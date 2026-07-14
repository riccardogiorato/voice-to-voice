import { createTogetherAI } from "@ai-sdk/togetherai";
import {
  jsonSchema,
  streamText,
  tool,
  type ModelMessage,
  type ToolSet,
} from "ai";
import WebSocket from "ws";
import type {
  ConversationMessage,
  JsonObject,
  RealtimeProvider,
  RealtimeTool,
  ReplyStreamEvent,
  SpeechConnection,
  TranscriptionConnection,
  TurnDetection,
} from "./types.js";

const TOGETHER_BASE_URL = "https://api.together.ai/v1";

export class TogetherRealtimeProvider implements RealtimeProvider {
  private together?: ReturnType<typeof createTogetherAI>;

  constructor(private readonly apiKey: string) {}

  async openTranscription(input: {
    sessionId: string;
    model: string;
    turnDetection: TurnDetection;
    signal: AbortSignal;
    onEvent: (event: JsonObject) => void;
  }): Promise<TranscriptionConnection> {
    const url = new URL("wss://api.together.ai/v1/realtime");
    url.searchParams.set("intent", "transcription");
    url.searchParams.set("model", input.model);
    url.searchParams.set("input_audio_format", "pcm_s16le_16000");
    url.searchParams.set("turn_detection", input.turnDetection ? "server_vad" : "none");
    if (input.turnDetection?.threshold !== undefined) {
      url.searchParams.set("threshold", String(input.turnDetection.threshold));
    }
    if (input.turnDetection?.silence_duration_ms !== undefined) {
      url.searchParams.set("silence_duration_ms", String(input.turnDetection.silence_duration_ms));
    }
    if (input.turnDetection?.prefix_padding_ms !== undefined) {
      url.searchParams.set("prefix_padding_ms", String(input.turnDetection.prefix_padding_ms));
    }

    const socket = await connectWithSingleRetry(url, this.getApiKey(), input.signal);
    socket.on("message", (data) => {
      const event = parseObject(data.toString());
      if (event) input.onEvent(event);
    });
    socket.on("error", (error) => input.onEvent(providerError("transcription_error", error)));
    socket.on("close", (code, reason) => {
      if (!input.signal.aborted && code !== 1000) {
        input.onEvent(providerError("transcription_disconnected", reason.toString() || `code ${code}`));
      }
    });
    input.signal.addEventListener("abort", () => socket.close(), { once: true });

    return {
      append(audio) {
        sendJson(socket, { type: "input_audio_buffer.append", audio });
      },
      commit() {
        sendJson(socket, { type: "input_audio_buffer.commit" });
      },
      close() {
        socket.close();
      },
    };
  }

  async *streamReply(input: {
    model: string;
    instructions: string;
    messages: ConversationMessage[];
    tools: RealtimeTool[];
    toolChoice: "auto" | "none" | "required" | { type: "function"; name: string };
    maxOutputTokens: number;
    signal: AbortSignal;
  }): AsyncIterable<ReplyStreamEvent> {
    let emitted = false;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const tools = toAiTools(input.tools);
        const result = streamText({
          model: this.getTogether()(input.model),
          system: input.instructions,
          messages: toModelMessages(input.messages),
          tools,
          toolChoice: toToolChoice(input.toolChoice),
          maxOutputTokens: input.maxOutputTokens,
          abortSignal: input.signal,
        });

        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            emitted = true;
            yield { type: "text-delta", delta: part.text };
          } else if (part.type === "tool-call") {
            emitted = true;
            yield {
              type: "tool-call",
              callId: part.toolCallId,
              name: part.toolName,
              arguments: JSON.stringify(part.input),
            };
          } else if (part.type === "finish") {
            yield { type: "done", finishReason: part.finishReason };
          } else if (part.type === "error") {
            throw normalizeError(part.error);
          }
        }
        return;
      } catch (error) {
        lastError = normalizeError(error);
        if (input.signal.aborted || emitted || attempt === 1) break;
      }
    }

    yield { type: "error", error: lastError ?? new Error("Together reply failed.") };
  }

  async openSpeech(input: {
    sessionId: string;
    model: string;
    voice: string;
    signal: AbortSignal;
    onEvent: (event: JsonObject) => void;
  }): Promise<SpeechConnection> {
    const url = new URL("wss://api.together.ai/v1/audio/speech/websocket");
    url.searchParams.set("model", input.model);
    url.searchParams.set("voice", input.voice);
    url.searchParams.set("response_format", "pcm");
    url.searchParams.set("sample_rate", "24000");
    url.searchParams.set("segment", "immediate");
    url.searchParams.set("max_partial_length", "80");
    const socket = await connectWithSingleRetry(url, this.getApiKey(), input.signal);
    const contextId = `ctx_${input.sessionId}`;
    const queue: JsonObject[] = [];
    let ready = false;

    socket.on("message", (data) => {
      const event = parseObject(data.toString());
      if (!event) return;
      if (event.type === "session.created") {
        ready = true;
        for (const pending of queue.splice(0)) sendJson(socket, pending);
      }
      input.onEvent(event);
    });
    socket.on("error", (error) => input.onEvent(providerError("speech_error", error)));
    socket.on("close", (code, reason) => {
      if (!input.signal.aborted && code !== 1000) {
        input.onEvent(providerError("speech_disconnected", reason.toString() || `code ${code}`));
      }
    });
    input.signal.addEventListener("abort", () => socket.close(), { once: true });

    const dispatch = (event: JsonObject) => {
      if (ready) sendJson(socket, event);
      else queue.push(event);
    };
    return {
      append(text) {
        dispatch({ type: "input_text_buffer.append", text, context_id: contextId });
      },
      commit() {
        dispatch({ type: "input_text_buffer.commit", context_id: contextId });
      },
      cancel() {
        dispatch({ type: "context.cancel", context_id: contextId });
      },
      close() {
        socket.close();
      },
    };
  }

  private getTogether() {
    this.together ??= createTogetherAI({
      apiKey: this.getApiKey(),
      baseURL: TOGETHER_BASE_URL,
      fetch: voiceReplyFetch,
    });
    return this.together;
  }

  private getApiKey() {
    if (!this.apiKey.trim()) throw new Error("TOGETHER_API_KEY is required.");
    return this.apiKey;
  }
}

const voiceReplyFetch: typeof fetch = async (input, init) => {
  if (String(input).endsWith("/chat/completions") && typeof init?.body === "string") {
    const body = JSON.parse(init.body) as JsonObject;
    return fetch(input, {
      ...init,
      body: JSON.stringify({ ...body, reasoning: { enabled: false } }),
    });
  }
  return fetch(input, init);
};

function toAiTools(definitions: RealtimeTool[]): ToolSet {
  return Object.fromEntries(
    definitions.map((definition) => [
      definition.name,
      tool({
        inputSchema: jsonSchema(definition.parameters),
        outputSchema: jsonSchema({}),
        ...(definition.description ? { description: definition.description } : {}),
      }),
    ]),
  );
}

function toToolChoice(
  choice: "auto" | "none" | "required" | { type: "function"; name: string },
) {
  return typeof choice === "string"
    ? choice
    : ({ type: "tool", toolName: choice.name } as const);
}

function toModelMessages(messages: ConversationMessage[]): ModelMessage[] {
  const output: ModelMessage[] = [];
  for (const message of messages) {
    if ("text" in message) {
      output.push({ role: message.role, content: message.text });
    } else if ("toolCall" in message) {
      output.push({
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: message.toolCall.callId,
          toolName: message.toolCall.name,
          input: parseToolInput(message.toolCall.arguments),
        }],
      });
    } else {
      output.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: message.toolResult.callId,
          toolName: message.toolResult.name,
          output: { type: "text", value: message.toolResult.output },
        }],
      });
    }
  }
  return output;
}

function parseToolInput(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function connectWithSingleRetry(url: URL, apiKey: string, signal: AbortSignal) {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await connect(url, apiKey, signal);
    } catch (error) {
      lastError = normalizeError(error);
      if (signal.aborted || attempt === 1) throw lastError;
    }
  }
  throw lastError ?? new Error("Together WebSocket connection failed.");
}

function connect(url: URL, apiKey: string, signal: AbortSignal) {
  return new Promise<WebSocket>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Operation aborted."));
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    const onAbort = () => {
      socket.close();
      reject(new Error("Operation aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("open", () => {
      signal.removeEventListener("abort", onAbort);
      resolve(socket);
    });
    socket.once("error", (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

function sendJson(socket: WebSocket, event: JsonObject) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}

function parseObject(value: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
}

function providerError(code: string, error: unknown): JsonObject {
  return { type: "provider.error", code, message: normalizeError(error).message };
}

function normalizeError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
