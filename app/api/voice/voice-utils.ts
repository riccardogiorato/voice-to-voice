// Parakeet is multilingual (25 languages) with punctuated output;
// nemotron-3-asr is English-only (Italian "ciao come stai" came back as
// "Shao comes") and only ~37ms faster. Benchmarked 2026-07-09.
const STT_MODEL = envOrDefault(
  "TOGETHER_STT_MODEL",
  "nvidia/parakeet-tdt-0.6b-v3",
);
const STT_FALLBACK_MODEL = envOrDefault(
  "TOGETHER_STT_FALLBACK_MODEL",
  "openai/whisper-large-v3",
);
// Replies need reasoning/tool-call behavior; keep smaller Qwen models for transcript repair.
// Override via env for latency experiments.
export const CHAT_MODEL = envOrDefault(
  "TOGETHER_CHAT_MODEL",
  "nvidia/nemotron-3-ultra-550b-a55b",
);
const CHAT_FALLBACK_MODEL = envOrDefault(
  "TOGETHER_CHAT_FALLBACK_MODEL",
  "MiniMaxAI/MiniMax-M2.7",
);
export const TRANSCRIPT_REPAIR_MODEL = envOrDefault(
  "TOGETHER_TRANSCRIPT_REPAIR_MODEL",
  "Qwen/Qwen3.5-9B",
);
const TTS_MODEL = envOrDefault("TOGETHER_TTS_MODEL", "cartesia/sonic-3");
const TTS_VOICE = envOrDefault("TOGETHER_TTS_VOICE", "nonfiction man");
const TTS_FALLBACK_MODEL = envOrDefault("TOGETHER_TTS_FALLBACK_MODEL", "hexgrad/Kokoro-82M");
const TTS_FALLBACK_VOICE = envOrDefault("TOGETHER_TTS_FALLBACK_VOICE", "af_heart");
export const STT_MODELS = uniqueNonEmpty([STT_MODEL, STT_FALLBACK_MODEL]);
export const CHAT_MODELS = uniqueNonEmpty([CHAT_MODEL, CHAT_FALLBACK_MODEL]);
export const TTS_MODELS = uniqueTtsConfigs([
  { model: TTS_MODEL, voice: TTS_VOICE },
  { model: TTS_FALLBACK_MODEL, voice: TTS_FALLBACK_VOICE },
]);
// Merge window: long enough to catch a mid-sentence pause continuation,
// short enough to never swallow a legitimate follow-up question.
export const TRANSCRIPT_MERGE_WINDOW_MS = 1500;
// The client VAD already decided the user finished; this only coalesces
// photo-finish arrivals. Anything longer re-litigates endpointing.
export const REPLY_GRACE_MS = 300;
// When the transcript reads as an unfinished thought ("so what about"),
// wait longer before answering: the pause is probably the user thinking.
export const REPLY_GRACE_INCOMPLETE_MS = 1200;
// Repair is cosmetic-only; a result landing after the client's settle
// window would rewrite text the user already trusts, so cap it hard.
export const TRANSCRIPT_REPAIR_TIMEOUT_MS = 800;
const GHOST_TRANSCRIPTS = new Set([
  "ok",
  "okay",
  "you",
  "thank you",
  "thanks for watching",
  "hmm",
  "mm hmm",
  "mhm",
  "uh",
  "um",
]);

export type ClientEvent =
  | { type: "conversation.start"; history?: { role: string; text: string }[] }
  | { type: "conversation.reset" }
  | { type: "conversation.stop" }
  | { type: "response.cancel" }
  | { type: "speech.started" }
  | { type: "audio.commit" }
  | {
      type: "audio.input";
      audio: string;
      sampleRate: number;
      format?: "float32le" | "pcm_s16le";
    };

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export const systemPrompt =
  "You are Together Voice, a warm, concise voice assistant demo built by Together AI. " +
  "Together AI is an AI acceleration cloud: it serves 200+ open-source models with fast inference APIs, " +
  "plus fine-tuning and GPU clusters. This demo runs entirely on Together AI models: " +
  "NVIDIA Parakeet transcribes the user's speech, an open chat model writes your replies, and Cartesia Sonic speaks them. " +
  "Whisper and Kokoro are configured as fallbacks. " +
  "If asked about Together AI, Together Voice, or this app, answer from those facts only. " +
  "You can use a fast web_search tool for current, recent, factual, or source-backed questions. " +
  "When tool results are provided, synthesize them into a short spoken answer and do not mention hidden reasoning. " +
  "Always reply in the same language as the user's latest message; if the language is unclear, default to English. " +
  "Answer naturally in one or two short spoken sentences. Plain spoken text only: no markdown, bullets, bold markers, code ticks, em dashes, or formatting symbols. Spell out numbers and abbreviations.";

export const transcriptRepairPrompt =
  "Rewrite speech-to-text transcripts as the most likely intended user utterance.\n" +
  "Rules:\n" +
  "- Fix obvious ASR errors, missing small words, punctuation, casing, and grammar.\n" +
  "- Preserve the user's meaning and language.\n" +
  "- Do not answer the user.\n" +
  "- Do not add facts, names, or details that are not strongly implied.\n" +
  "- Preserve short commands like yes, no, stop, and cancel exactly.\n" +
  "- If the transcript is already clear or the intended wording is uncertain, return it unchanged.\n" +
  "Return only the repaired transcript text.";

// Browsers do not enforce CORS on WebSocket upgrades, so any site could open
// this socket from a visitor's browser and burn Together credits. Reject
// cross-origin browser connections; requests without an Origin header
// (curl, test scripts) pass through since a non-browser client can spoof
// Origin anyway.
export function isAllowedOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  const extraOrigins = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return (
    originHost === request.headers.get("host") ||
    extraOrigins.some((entry) => entry === origin || entry === originHost)
  );
}

function envOrDefault(name: string, fallback: string) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function uniqueNonEmpty(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueTtsConfigs(configs: { model: string; voice: string }[]) {
  const seen = new Set<string>();
  return configs.filter((config) => {
    const model = config.model.trim();
    const voice = config.voice.trim();
    if (!model || !voice) return false;

    const key = `${model}\0${voice}`;
    if (seen.has(key)) return false;
    seen.add(key);
    config.model = model;
    config.voice = voice;
    return true;
  });
}

export function compactErrorBody(body: string) {
  if (!body.trim()) return "";

  try {
    const json = JSON.parse(body);
    const message =
      json.error?.message ??
      json.message ??
      json.error ??
      json.detail ??
      JSON.stringify(json);
    return String(message).slice(0, 500);
  } catch {
    return body.replace(/\s+/g, " ").trim().slice(0, 500);
  }
}

export function cleanTranscript(transcript: string) {
  const words = transcript.replace(/\s+/g, " ").trim().split(" ");
  const cleaned: string[] = [];
  let previous = "";
  let repeatCount = 0;

  for (const word of words) {
    const normalized = normalizeTranscript(word);
    if (!normalized) continue;

    repeatCount = normalized && normalized === previous ? repeatCount + 1 : 1;
    previous = normalized;

    if (repeatCount <= 2) cleaned.push(word);
  }

  return cleaned.join(" ").slice(0, 800).trim();
}

export function isGhostTranscript(transcript: string) {
  const normalized = normalizeTranscript(transcript);
  if (!normalized) return true;
  if (GHOST_TRANSCRIPTS.has(normalized)) return normalized.split(" ").length <= 3;
  return isLowIntentNoiseTranscript(normalized);
}

function isLowIntentNoiseTranscript(normalized: string) {
  return /^(?:ok(?:ay)?\s+)?(?:mm\s+hmm|mhm)(?:\s+i\s+don\s+t\s+know)?$/u.test(
    normalized,
  );
}

export function transcriptLooksComplete(text: string) {
  return /[.?!]["')\]]?$/u.test(text.trim());
}

export function wordChangeRatio(before: string, after: string) {
  const beforeWords = normalizeTranscript(before).split(" ").filter(Boolean);
  const afterWords = normalizeTranscript(after).split(" ").filter(Boolean);
  if (beforeWords.length === 0) return afterWords.length === 0 ? 0 : 1;

  const counts = new Map<string, number>();
  for (const word of beforeWords) counts.set(word, (counts.get(word) ?? 0) + 1);
  let common = 0;
  for (const word of afterWords) {
    const count = counts.get(word) ?? 0;
    if (count > 0) {
      common += 1;
      counts.set(word, count - 1);
    }
  }

  return 1 - common / Math.max(beforeWords.length, afterWords.length);
}

export function mergeTranscriptText(previous: string, next: string) {
  const trimmedPrevious = previous.trim();
  const trimmedNext = next.trim();
  if (!trimmedPrevious) return trimmedNext;
  if (!trimmedNext) return trimmedPrevious;
  return `${trimmedPrevious.replace(/[.?!,;:\s]+$/u, "")} ${trimmedNext}`;
}

export function shouldFlushFirstTtsChunk(text: string) {
  const trimmed = text.trim();
  if (/[.!?]\s$/u.test(text)) return true;
  if (trimmed.length >= 44) return true;
  return trimmed.length >= 24 && /[,;:]\s*$/u.test(text);
}

export function normalizeTranscript(transcript: string) {
  return transcript
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseJson(data: import("ws").RawData) {
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
}

export function decodeFloat32(base64: string) {
  const buffer = Buffer.from(base64, "base64");
  const samples = new Float32Array(buffer.byteLength / 4);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = buffer.readFloatLE(i * 4);
  }
  return samples;
}

export function resample(input: Float32Array, fromRate: number, toRate: number) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const before = Math.floor(position);
    const after = Math.min(before + 1, input.length - 1);
    const weight = position - before;
    output[i] = input[before] * (1 - weight) + input[after] * weight;
  }

  return output;
}

export function floatTo16BitPcm(input: Float32Array) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

export async function* streamTogetherText(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;

      try {
        const json = JSON.parse(payload);
        const delta =
          json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.text;
        if (typeof delta === "string" && delta.length > 0) {
          yield delta;
        }
      } catch {
        // Ignore partial or non-JSON SSE lines.
      }
    }
  }
}
