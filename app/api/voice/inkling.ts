import {
  parseReplyLanguagePrefix,
  stripAssistantMarkdown,
  stripReplyLanguageControlTags,
} from "./reply";
import { buildVoiceToolPolicyPrompt } from "./tool-policy";
import {
  AVAILABLE_TOOLS,
  LOCAL_CONTEXT_TOOLS,
  runToolCallWithActivity,
} from "./tools";
import type { TogetherToolCall, ToolActivity } from "./tools";
import type { UserContext } from "./user-context";
import type { ChatMessage } from "./voice-utils";

export const TOGETHER_INKLING_MODEL = "thinkingmachines/inkling";
export const TOGETHER_MODELS_URL = "https://api.together.ai/v1/models";
export const TOGETHER_CHAT_COMPLETIONS_URL =
  "https://api.together.ai/v1/chat/completions";
const INKLING_MAX_TOOL_ROUNDS = 1;
const INKLING_FINAL_ANSWER_REMINDER =
  "The next response is the final spoken answer. Output exactly " +
  "<transcript>the exact spoken words</transcript>, then a newline, then " +
  "<lang:xx> followed by the direct answer. Do not call another tool.";

export type InklingAudioFormat = "flac" | "wav";

export type InklingAudioInput = {
  data: string;
  format: InklingAudioFormat;
  numFrames: number;
  sampleRate: number;
};

export type InklingTextMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type InklingAudioMessage = {
  role: "user";
  content: [
    { type: "text"; text: string },
    {
      type: "input_audio";
      input_audio: {
        data: string;
        format: InklingAudioFormat;
        num_frames: number;
        sample_rate: number;
      };
    },
  ];
};

type InklingAssistantToolMessage = {
  role: "assistant";
  content: string;
  tool_calls: TogetherToolCall[];
};

type InklingToolMessage = {
  role: "tool";
  tool_call_id: string;
  content: string;
};

type InklingMessage =
  | InklingTextMessage
  | InklingAudioMessage
  | InklingAssistantToolMessage
  | InklingToolMessage;

export type InklingChatRequest = {
  model: string;
  messages: InklingMessage[];
  max_tokens: number;
  reasoning_effort: "low";
  stream: boolean;
  tools?: ReadonlyArray<(typeof AVAILABLE_TOOLS)[number]>;
  tool_choice?: "auto" | "none";
};

export type InklingChatCompletion = {
  content: string;
  toolCalls: TogetherToolCall[];
};

export type InklingVoiceTurn = {
  language: string | null;
  reply: string;
  transcript: string;
};

export type TogetherModelAvailability = {
  available: boolean;
  model: Record<string, unknown> | null;
};

export type PcmWavMetadata = {
  bitsPerSample: number;
  channels: number;
  dataBytes: number;
  numFrames: number;
  sampleRate: number;
};

export function buildInklingAudioRequest({
  audio,
  history = [],
  instruction,
  maxTokens = 600,
  model = TOGETHER_INKLING_MODEL,
  stream = false,
  system,
  toolChoice,
  tools,
}: {
  audio: InklingAudioInput;
  history?: InklingTextMessage[];
  instruction: string;
  maxTokens?: number;
  model?: string;
  stream?: boolean;
  system?: string;
  toolChoice?: InklingChatRequest["tool_choice"];
  tools?: InklingChatRequest["tools"];
}): InklingChatRequest {
  if (!audio.data) throw new Error("Inkling audio data is empty.");
  if (!Number.isInteger(audio.numFrames) || audio.numFrames <= 0) {
    throw new Error("Inkling audio numFrames must be a positive integer.");
  }
  if (!Number.isInteger(audio.sampleRate) || audio.sampleRate <= 0) {
    throw new Error("Inkling audio sampleRate must be a positive integer.");
  }

  const messages: InklingMessage[] = [];
  if (system?.trim()) {
    messages.push({ role: "system", content: system.trim() });
  }
  messages.push(...history);
  messages.push({
    role: "user",
    content: [
      { type: "text", text: instruction },
      {
        type: "input_audio",
        input_audio: {
          data: audio.data,
          format: audio.format,
          num_frames: audio.numFrames,
          sample_rate: audio.sampleRate,
        },
      },
    ],
  });

  const request: InklingChatRequest = {
    model,
    messages,
    max_tokens: maxTokens,
    reasoning_effort: "low",
    stream,
  };
  if (tools?.length) {
    request.tools = tools;
    request.tool_choice = toolChoice ?? "auto";
  } else if (toolChoice) {
    request.tool_choice = toolChoice;
  }
  return request;
}

export async function generateInklingVoiceTurn({
  apiKey,
  fetchImpl = fetch,
  history,
  pcm16,
  signal,
  onToolActivity,
  userContext = {},
}: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  history: ChatMessage[];
  pcm16: Uint8Array;
  signal: AbortSignal;
  onToolActivity?: (activity: ToolActivity) => void;
  userContext?: UserContext;
}): Promise<InklingVoiceTurn> {
  const wav = pcm16ToWav(pcm16);
  const baseRequest = buildInklingAudioRequest({
    audio: {
      data: Buffer.from(wav).toString("base64"),
      format: "wav",
      numFrames: pcm16.byteLength / 2,
      sampleRate: 16_000,
    },
    history,
    instruction:
      "Listen to the latest audio. Output exactly two parts: first " +
      "<transcript>the exact spoken words</transcript>, then a newline, then " +
      "<lang:xx> followed by your direct answer in that language. Do not output " +
      "reasoning, markdown, a closing language tag, or any other text.",
    maxTokens: 600,
    system: buildInklingSystemPrompt(new Date(), userContext),
  });
  const messages = [...baseRequest.messages];

  for (let round = 0; round <= INKLING_MAX_TOOL_ROUNDS; round += 1) {
    const allowTools = round < INKLING_MAX_TOOL_ROUNDS;
    const availableTools = process.env.EXA_API_KEY
      ? AVAILABLE_TOOLS
      : LOCAL_CONTEXT_TOOLS;
    const request: InklingChatRequest = {
      ...baseRequest,
      messages: [...messages],
      ...(allowTools
        ? { tools: availableTools, tool_choice: "auto" as const }
        : {}),
    };
    const completion = await createInklingAudioCompletion({
      apiKey,
      fetchImpl,
      request,
      signal,
    });

    if (completion.toolCalls.length === 0) {
      return parseInklingVoiceResponse(completion.content);
    }

    messages.push({
      role: "assistant",
      content: completion.content,
      tool_calls: completion.toolCalls,
    });
    for (const toolCall of completion.toolCalls.slice(0, 2)) {
      const toolResult = await runToolCallWithActivity(
        toolCall,
        signal,
        onToolActivity,
        userContext,
      );
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolResult,
      });
    }
    messages.push({ role: "system", content: INKLING_FINAL_ANSWER_REMINDER });
  }

  throw new Error("Together Inkling did not produce a final answer after tool use.");
}

export function parseInklingVoiceResponse(content: string): InklingVoiceTurn {
  const transcriptMatch = content.match(
    /<transcript>\s*([\s\S]*?)\s*<\/transcript>/i,
  );
  const transcript = transcriptMatch?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  if (!transcript) {
    throw new Error("Together Inkling returned no transcript.");
  }

  const replySource = content.slice(
    (transcriptMatch?.index ?? 0) + (transcriptMatch?.[0].length ?? 0),
  );
  const parsed = parseReplyLanguagePrefix(replySource);
  if (parsed.pending) {
    throw new Error("Together Inkling returned an incomplete reply.");
  }
  const reply = stripAssistantMarkdown(
    stripReplyLanguageControlTags(parsed.content),
  ).trim();
  if (!reply) {
    throw new Error("Together Inkling returned no reply.");
  }

  return { language: parsed.language, reply, transcript };
}

export function buildInklingSystemPrompt(
  now = new Date(),
  userContext: UserContext = {},
) {
  return (
    "You are Together Voice, a warm, concise voice assistant demo built by " +
    "Together AI. You understand the user's latest speech directly with the " +
    "Thinking Machines Inkling model, and the app sends your text reply to a " +
    "separate text-to-speech model. Reply naturally in one or two short spoken " +
    "sentences in the same language as the latest speech. Use plain spoken text " +
    "without markdown or formatting symbols.\n" +
    buildVoiceToolPolicyPrompt(now, userContext)
  );
}

export async function getTogetherModelAvailability({
  apiKey,
  fetchImpl = fetch,
  model = TOGETHER_INKLING_MODEL,
}: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  model?: string;
}): Promise<TogetherModelAvailability> {
  const response = await fetchImpl(TOGETHER_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`Together model catalog failed with ${response.status}.`);
  }

  const payload = await response.json();
  const models = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : [];
  const normalizedModel = model.toLowerCase();
  const match = models.find((entry: unknown) => {
    if (!entry || typeof entry !== "object") return false;
    const record = entry as Record<string, unknown>;
    const id = record.id ?? record.name ?? record.model;
    return typeof id === "string" && id.toLowerCase() === normalizedModel;
  });

  return {
    available: Boolean(match),
    model: match ? (match as Record<string, unknown>) : null,
  };
}

export async function createInklingAudioCompletion({
  apiKey,
  fetchImpl = fetch,
  request,
  signal,
}: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  request: InklingChatRequest;
  signal?: AbortSignal;
}) {
  if (request.stream) {
    throw new Error(
      "The Inkling voice adapter currently supports non-streaming responses only.",
    );
  }

  const response = await fetchImpl(TOGETHER_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Together Inkling failed with ${response.status}${body ? `: ${compactBody(body)}` : ""}`,
    );
  }

  const payload = await response.json();
  const message = payload?.choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls.filter(isTogetherToolCall)
    : [];
  if (!content && toolCalls.length === 0) {
    throw new Error("Together Inkling returned no text or tool calls.");
  }
  return { content, toolCalls } satisfies InklingChatCompletion;
}

function isTogetherToolCall(value: unknown): value is TogetherToolCall {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.type !== "function") return false;
  if (!record.function || typeof record.function !== "object") return false;
  const fn = record.function as Record<string, unknown>;
  return typeof fn.name === "string" && typeof fn.arguments === "string";
}

export function pcm16ToWav(
  pcm: Uint8Array,
  sampleRate = 16_000,
  channels = 1,
) {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error("WAV sampleRate must be a positive integer.");
  }
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new Error("WAV channels must be a positive integer.");
  }

  const bytesPerFrame = channels * 2;
  if (pcm.byteLength === 0 || pcm.byteLength % bytesPerFrame !== 0) {
    throw new Error("PCM16 data must contain complete, non-empty audio frames.");
  }

  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  writeAscii(wav, 0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(wav, 8, "WAVE");
  writeAscii(wav, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerFrame, true);
  view.setUint16(32, bytesPerFrame, true);
  view.setUint16(34, 16, true);
  writeAscii(wav, 36, "data");
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
}

export function readPcmWavMetadata(wav: Uint8Array): PcmWavMetadata {
  if (
    wav.byteLength < 44 ||
    readAscii(wav, 0, 4) !== "RIFF" ||
    readAscii(wav, 8, 4) !== "WAVE"
  ) {
    throw new Error("Expected a RIFF/WAVE audio file.");
  }

  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let blockAlign = 0;
  let audioFormat = 0;
  let dataBytes = 0;

  while (offset + 8 <= wav.byteLength) {
    const chunkId = readAscii(wav, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    if (chunkStart + chunkSize > wav.byteLength) {
      throw new Error(`Invalid WAV ${chunkId} chunk length.`);
    }

    if (chunkId === "fmt ") {
      if (chunkSize < 16) throw new Error("Invalid WAV fmt chunk.");
      audioFormat = view.getUint16(chunkStart, true);
      channels = view.getUint16(chunkStart + 2, true);
      sampleRate = view.getUint32(chunkStart + 4, true);
      blockAlign = view.getUint16(chunkStart + 12, true);
      bitsPerSample = view.getUint16(chunkStart + 14, true);
    } else if (chunkId === "data") {
      dataBytes += chunkSize;
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (audioFormat !== 1 || !channels || !sampleRate || bitsPerSample !== 16) {
    throw new Error("Inkling probe currently expects uncompressed PCM16 WAV audio.");
  }
  if (!dataBytes || !blockAlign || dataBytes % blockAlign !== 0) {
    throw new Error("WAV file contains no complete PCM16 audio frames.");
  }

  return {
    bitsPerSample,
    channels,
    dataBytes,
    numFrames: dataBytes / blockAlign,
    sampleRate,
  };
}

function writeAscii(target: Uint8Array, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    target[offset + index] = value.charCodeAt(index);
  }
}

function readAscii(source: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...source.subarray(offset, offset + length));
}

function compactBody(body: string) {
  try {
    const payload = JSON.parse(body);
    return String(
      payload?.error?.message ?? payload?.message ?? payload?.error ?? body,
    ).slice(0, 500);
  } catch {
    return body.replace(/\s+/g, " ").trim().slice(0, 500);
  }
}
