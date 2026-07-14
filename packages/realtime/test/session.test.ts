import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  createRealtimeEngine,
  type JsonObject,
  type RealtimeProvider,
  type RealtimeSocket,
  type ReplyStreamEvent,
  type SpeechConnection,
  type TranscriptionConnection,
} from "../src/index.js";

class FakeSocket extends EventEmitter implements RealtimeSocket {
  readyState = 1;
  sent: JsonObject[] = [];
  send(data: string) { this.sent.push(JSON.parse(data) as JsonObject); }
  close() { this.readyState = 3; this.emit("close", 1000, "closed"); }
  receive(event: JsonObject) { this.emit("message", Buffer.from(JSON.stringify(event))); }
}

class FakeProvider implements RealtimeProvider {
  transcriptionEvent?: (event: JsonObject) => void;
  speechEvent?: (event: JsonObject) => void;
  replies: ReplyStreamEvent[][] = [];
  committed = 0;
  holdReply = false;

  async openTranscription(input: Parameters<RealtimeProvider["openTranscription"]>[0]): Promise<TranscriptionConnection> {
    this.transcriptionEvent = input.onEvent;
    return { append() {}, commit: () => { this.committed += 1; }, close() {} };
  }
  async *streamReply(input: Parameters<RealtimeProvider["streamReply"]>[0]): AsyncIterable<ReplyStreamEvent> {
    for (const event of this.replies.shift() ?? []) yield event;
    if (this.holdReply && !input.signal.aborted) {
      await new Promise<void>((resolveAbort) => {
        input.signal.addEventListener("abort", () => resolveAbort(), { once: true });
      });
    }
  }
  async openSpeech(input: Parameters<RealtimeProvider["openSpeech"]>[0]): Promise<SpeechConnection> {
    this.speechEvent = input.onEvent;
    return {
      append() {},
      commit: () => {
        input.onEvent({ type: "conversation.item.audio_output.delta", delta: Buffer.alloc(4800).toString("base64") });
        input.onEvent({ type: "conversation.item.audio_output.done" });
      },
      cancel() {},
      close() {},
    };
  }
}

async function setup(provider = new FakeProvider()) {
  const engine = createRealtimeEngine({
    realtimeSecret: "test-secret-with-at-least-32-bytes",
    models: { stt: "stt", reply: "reply", tts: "tts" },
    replyContextWindowTokens: 4096,
    maxOutputTokens: 256,
    defaultVoice: "voice one",
    provider,
  });
  const secret = await engine.createClientSecret();
  const socket = new FakeSocket();
  engine.acceptSocket(socket, secret.value);
  await tick();
  return { provider, socket };
}

describe("OpenAI-compatible session state", () => {
  it("orders manual commit, transcript, streamed text, audio, and response completion", async () => {
    const { provider, socket } = await setup();
    provider.replies.push([
      { type: "text-delta", delta: "Hello there." },
      { type: "done", finishReason: "stop" },
    ]);
    socket.receive({ type: "session.update", session: { model: "together-realtime", audio: { input: { turn_detection: null } } } });
    socket.receive({ type: "input_audio_buffer.append", audio: Buffer.alloc(4800).toString("base64") });
    socket.receive({ type: "input_audio_buffer.commit" });
    socket.receive({ type: "response.create" });
    await waitFor(() => provider.committed === 1);
    provider.transcriptionEvent?.({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Hello",
    });
    await waitFor(() => socket.sent.some((event) => event.type === "response.done"));
    const types = socket.sent.map((event) => event.type);
    expect(types.indexOf("input_audio_buffer.committed")).toBeLessThan(types.indexOf("conversation.item.input_audio_transcription.completed"));
    expect(types.indexOf("response.created")).toBeLessThan(types.indexOf("response.output_audio_transcript.delta"));
    expect(types.indexOf("response.output_audio_transcript.delta")).toBeLessThan(types.indexOf("response.output_audio.delta"));
    expect(types.at(-1)).toBe("response.done");
  });

  it("round trips a client function tool result and resumes generation", async () => {
    const { provider, socket } = await setup();
    provider.replies.push(
      [
        { type: "tool-call", callId: "call_clock", name: "clock", arguments: "{}" },
        { type: "done", finishReason: "tool-calls" },
      ],
      [
        { type: "text-delta", delta: "It is noon." },
        { type: "done", finishReason: "stop" },
      ],
    );
    socket.receive({
      type: "session.update",
      session: { tools: [{ type: "function", name: "clock", parameters: { type: "object" } }] },
    });
    socket.receive({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "time" }] } });
    socket.receive({ type: "response.create" });
    await waitFor(() => socket.sent.some((event) => event.type === "response.function_call_arguments.done"));
    socket.receive({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "call_clock", output: "noon" } });
    socket.receive({ type: "response.create" });
    await waitFor(() => socket.sent.filter((event) => event.type === "response.done").length === 2);
    expect(socket.sent.some((event) => event.type === "response.output_audio.delta")).toBe(true);
  });

  it("cancels an active response when server VAD reports barge-in", async () => {
    const { provider, socket } = await setup();
    provider.holdReply = true;
    provider.replies.push([{ type: "text-delta", delta: "A long answer" }]);
    socket.receive({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "start" }] } });
    socket.receive({ type: "response.create" });
    await waitFor(() => socket.sent.some((event) => event.type === "response.created"));
    provider.transcriptionEvent?.({ type: "input_audio_buffer.speech_started", audio_start_ms: 10 });
    await waitFor(() => socket.sent.some((event) =>
      event.type === "response.done" && (event.response as JsonObject | undefined)?.status === "cancelled"));
  });
});

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(assertion: () => boolean, timeoutMs = 1000) {
  const started = Date.now();
  while (!assertion()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for session event.");
    await tick();
  }
}
