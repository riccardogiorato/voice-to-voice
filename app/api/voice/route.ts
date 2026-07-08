import { experimental_upgradeWebSocket } from "@vercel/functions";
import WebSocket from "ws";

export const runtime = "nodejs";
export const maxDuration = 300;

const STT_MODEL = envOrDefault(
  "TOGETHER_STT_MODEL",
  "nvidia/nemotron-3-asr-streaming-0.6b",
);
const STT_FALLBACK_MODEL = envOrDefault(
  "TOGETHER_STT_FALLBACK_MODEL",
  "openai/whisper-large-v3",
);
const CHAT_MODEL = envOrDefault(
  "TOGETHER_CHAT_MODEL",
  "Qwen/Qwen2.5-7B-Instruct-Turbo",
);
const TTS_MODEL = envOrDefault("TOGETHER_TTS_MODEL", "canopylabs/orpheus-3b-0.1-ft");
const TTS_VOICE = envOrDefault("TOGETHER_TTS_VOICE", "tara");
const TTS_FALLBACK_MODEL = envOrDefault("TOGETHER_TTS_FALLBACK_MODEL", "hexgrad/Kokoro-82M");
const TTS_FALLBACK_VOICE = envOrDefault("TOGETHER_TTS_FALLBACK_VOICE", "af_heart");
const STT_MODELS = uniqueNonEmpty([STT_MODEL, STT_FALLBACK_MODEL]);
const TTS_MODELS = uniqueTtsConfigs([
  { model: TTS_MODEL, voice: TTS_VOICE },
  { model: TTS_FALLBACK_MODEL, voice: TTS_FALLBACK_VOICE },
]);

type ClientEvent =
  | { type: "conversation.start"; history?: { role: string; text: string }[] }
  | { type: "conversation.reset" }
  | { type: "conversation.stop" }
  | { type: "response.cancel" }
  | { type: "audio.commit" }
  | { type: "audio.input"; audio: string; sampleRate: number };

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const systemPrompt =
  "You are Together Voice, a warm, concise voice assistant demo built by Together AI. " +
  "Together AI is an AI acceleration cloud: it serves 200+ open-source models with fast inference APIs, " +
  "plus fine-tuning and GPU clusters. This demo runs entirely on Together AI models: " +
  "NVIDIA Nemotron transcribes the user's speech, an open chat model writes your replies, and Orpheus speaks them. " +
  "Whisper and Kokoro are configured as fallbacks. " +
  "If asked about Together AI, Together Voice, or this app, answer from those facts only. " +
  "Answer naturally in one or two short spoken sentences. Spell out numbers and abbreviations. No markdown.";

export async function GET(request: Request) {
  if (!isAllowedOrigin(request)) {
    return new Response("Forbidden", { status: 403 });
  }

  return experimental_upgradeWebSocket((client) => {
    const session = new VoiceSession(client);
    session.start();
  });
}

// Browsers do not enforce CORS on WebSocket upgrades, so any site could open
// this socket from a visitor's browser and burn Together credits. Reject
// cross-origin browser connections; requests without an Origin header
// (curl, test scripts) pass through since a non-browser client can spoof
// Origin anyway.
function isAllowedOrigin(request: Request) {
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

class VoiceSession {
  private stt?: WebSocket;
  private tts?: WebSocket;
  private chatAbort?: AbortController;
  private history: ChatMessage[] = [];
  private turnCount = 0;
  private ttsContextId = "turn-0";
  private ttsReady = false;
  private pendingSpeech: string[] = [];
  private pendingCommit = false;
  private stopped = false;
  private lastTranscript = "";
  private lastTranscriptAt = 0;
  private keepaliveTimer?: NodeJS.Timeout;
  private expiryTimer?: NodeJS.Timeout;
  private sttReconnects = 0;
  private ttsReconnects = 0;
  private sttModelIndex = 0;
  private ttsModelIndex = 0;
  private sttFallbackPending = false;
  private ttsFallbackPending = false;

  constructor(private client: WebSocket) {}

  start() {
    this.client.on("message", (data) => this.handleClientMessage(data));
    this.client.on("close", () => this.close());
    this.client.on("error", () => this.close());

    if (!process.env.TOGETHER_API_KEY) {
      this.send("error", { message: "Missing TOGETHER_API_KEY on the server." });
      this.client.close();
      return;
    }

    this.keepaliveTimer = setInterval(() => {
      if (this.stt?.readyState === WebSocket.OPEN) this.stt.ping();
      if (this.tts?.readyState === WebSocket.OPEN) this.tts.ping();
    }, 15_000);

    // End 20s before Vercel's maxDuration (300s) hard-kills the function, so
    // the client hears why instead of a silent drop.
    this.expiryTimer = setTimeout(() => {
      this.send("error", {
        message: "Session time limit reached. Tap the mic to start a new session.",
      });
      this.send("state", { state: "idle" });
      this.close();
    }, 280_000);

    this.connectStt();
    this.connectTts();
    this.send("state", { state: "connecting" });
  }

  private connectStt() {
    const model = STT_MODELS[this.sttModelIndex] ?? STT_MODELS[0];
    const url = new URL("wss://api.together.ai/v1/realtime");
    url.searchParams.set("intent", "transcription");
    url.searchParams.set("model", model);
    url.searchParams.set("input_audio_format", "pcm_s16le_16000");
    url.searchParams.set("turn_detection", "none");
    url.searchParams.set("max_speech_duration_s", "8");

    this.stt = new WebSocket(url.toString(), {
      headers: { Authorization: `Bearer ${process.env.TOGETHER_API_KEY}` },
    });

    this.stt.on("open", () => this.send("state", { state: "listening" }));
    this.stt.on("message", (data) => this.handleSttMessage(data));
    this.stt.on("error", () => {});
    this.stt.on("close", () => {
      if (this.stopped) return;
      if (this.sttFallbackPending) return;
      if (this.fallbackStt("Speech service disconnected.")) return;
      if (this.sttReconnects >= 2) {
        this.send("error", { message: "Speech service disconnected." });
        return;
      }
      this.sttReconnects += 1;
      setTimeout(() => {
        if (!this.stopped) this.connectStt();
      }, 500);
    });
  }

  private connectTts() {
    const config = TTS_MODELS[this.ttsModelIndex] ?? TTS_MODELS[0];
    const url = new URL("wss://api.together.ai/v1/audio/speech/websocket");
    url.searchParams.set("model", config.model);
    url.searchParams.set("voice", config.voice);
    url.searchParams.set("response_format", "pcm");
    url.searchParams.set("sample_rate", "24000");
    url.searchParams.set("segment", "sentence");
    url.searchParams.set("max_partial_length", "160");

    this.tts = new WebSocket(url.toString(), {
      headers: { Authorization: `Bearer ${process.env.TOGETHER_API_KEY}` },
    });

    this.tts.on("message", (data) => this.handleTtsMessage(data));
    this.tts.on("error", () => {});
    this.tts.on("close", () => {
      if (this.stopped) return;
      this.ttsReady = false;
      if (this.ttsFallbackPending) return;
      if (this.fallbackTts("Voice service disconnected.")) return;
      if (this.ttsReconnects >= 2) {
        this.send("error", { message: "Voice service disconnected." });
        return;
      }
      this.ttsReconnects += 1;
      setTimeout(() => {
        if (!this.stopped) this.connectTts();
      }, 500);
    });
  }

  private handleClientMessage(data: WebSocket.RawData) {
    let event: ClientEvent;
    try {
      event = JSON.parse(data.toString()) as ClientEvent;
    } catch {
      return;
    }

    if (event.type === "conversation.start") {
      this.seedHistory(event.history);
      return;
    }

    if (event.type === "conversation.reset") {
      this.cancelResponse();
      this.history = [];
      this.send("state", { state: "listening" });
      return;
    }

    if (event.type === "conversation.stop") {
      this.close();
      return;
    }

    if (event.type === "response.cancel") {
      this.cancelResponse();
      this.send("state", { state: "listening" });
      return;
    }

    if (event.type === "audio.commit") {
      this.commitAudio();
      return;
    }

    if (event.type === "audio.input") {
      this.forwardAudio(event.audio, event.sampleRate);
    }
  }

  private handleSttMessage(data: WebSocket.RawData) {
    const message = parseJson(data);
    if (!message) return;

    if (message.type === "conversation.item.input_audio_transcription.delta") {
      this.send("transcript.delta", { text: message.delta ?? "" });
      return;
    }

    if (message.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = cleanTranscript(String(message.transcript ?? ""));
      if (transcript.length > 0) {
        if (this.isDuplicateTranscript(transcript)) return;

        this.send("transcript.final", { text: transcript });
        void this.answer(transcript);
      }
      return;
    }

    if (message.type === "conversation.item.input_audio_transcription.failed") {
      this.send("error", {
        message: message.error?.message ?? "Transcription failed.",
      });
    }
  }

  private handleTtsMessage(data: WebSocket.RawData) {
    const message = parseJson(data);
    if (!message) return;

    if (message.type === "session.created") {
      this.ttsReady = true;
      this.flushSpeech();
      return;
    }

    // Audio from a cancelled turn's context can still arrive after
    // context.cancel; drop anything not belonging to the current turn.
    if (message.context_id && message.context_id !== this.ttsContextId) {
      return;
    }

    if (message.type === "conversation.item.audio_output.delta") {
      this.send("audio.delta", { audio: message.delta, sampleRate: 24000 });
      return;
    }

    if (message.type === "conversation.item.audio_output.done") {
      this.send("audio.done", {});
      this.send("state", { state: "listening" });
      return;
    }

    if (message.type === "conversation.item.tts.failed") {
      if (this.fallbackTts("Voice generation failed.")) return;
      this.send("error", { message: message.error?.message ?? "TTS failed." });
      this.send("state", { state: "listening" });
    }
  }

  private fallbackStt(reason: string) {
    if (this.sttModelIndex >= STT_MODELS.length - 1) return false;

    this.sttModelIndex += 1;
    this.sttReconnects = 0;
    this.sttFallbackPending = true;
    const model = STT_MODELS[this.sttModelIndex];
    this.send("error", { message: `${reason} Falling back to ${model}.` });

    try {
      this.stt?.close();
    } catch {}

    setTimeout(() => {
      this.sttFallbackPending = false;
      if (!this.stopped) this.connectStt();
    }, 250);
    return true;
  }

  private fallbackTts(reason: string) {
    if (this.ttsModelIndex >= TTS_MODELS.length - 1) return false;

    this.ttsModelIndex += 1;
    this.ttsReconnects = 0;
    this.ttsReady = false;
    this.ttsFallbackPending = true;
    const config = TTS_MODELS[this.ttsModelIndex];
    this.send("error", {
      message: `${reason} Falling back to ${config.model}.`,
    });

    try {
      this.tts?.close();
    } catch {}

    setTimeout(() => {
      this.ttsFallbackPending = false;
      if (!this.stopped) this.connectTts();
    }, 250);
    return true;
  }

  private forwardAudio(base64Float32: string, sampleRate: number) {
    if (!this.stt || this.stt.readyState !== WebSocket.OPEN) return;

    const float32 = decodeFloat32(base64Float32);
    const pcm16 = floatTo16BitPcm(resample(float32, sampleRate, 16_000));
    this.stt.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength).toString(
          "base64",
        ),
      }),
    );
  }

  private commitAudio() {
    if (!this.stt || this.stt.readyState !== WebSocket.OPEN) return;
    this.stt.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  }

  private async answer(transcript: string) {
    this.cancelResponse();
    this.send("audio.clear", {});
    this.send("state", { state: "thinking" });

    this.turnCount += 1;
    this.ttsContextId = `turn-${this.turnCount}`;

    this.history.push({ role: "user", content: transcript });
    this.trimHistory();

    const chatMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...this.history,
    ];

    const controller = new AbortController();
    this.chatAbort = controller;

    let assistant = "";
    let sentence = "";

    try {
      const response = await fetch("https://api.together.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.TOGETHER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: CHAT_MODEL,
          messages: chatMessages,
          max_tokens: 120,
          temperature: 0.45,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const errorBody = await response.text().catch(() => "");
        const message = compactErrorBody(errorBody);
        console.error("Together chat failed", {
          status: response.status,
          model: CHAT_MODEL,
          messageCount: chatMessages.length,
          lastUserLength: transcript.length,
          body: message,
        });
        throw new Error(
          `Together chat failed with ${response.status}${message ? `: ${message}` : ""}`,
        );
      }

      this.send("state", { state: "speaking" });

      for await (const delta of streamTogetherText(response.body)) {
        assistant += delta;
        sentence += delta;
        this.send("assistant.delta", { text: delta });

        if (/[.!?]\s$/.test(sentence) || sentence.length > 150) {
          this.speak(sentence);
          sentence = "";
        }
      }

      if (sentence.trim()) this.speak(sentence);
      this.commitSpeech();

      if (assistant.trim()) {
        this.history.push({ role: "assistant", content: assistant.trim() });
        this.trimHistory();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.send("error", {
          message: error instanceof Error ? error.message : "Chat failed.",
        });
        this.send("state", { state: "listening" });
      }
    }
  }

  private trimHistory() {
    if (this.history.length > 8) this.history = this.history.slice(-8);
  }

  // Sessions are per-connection, so a stop/expiry/reconnect would otherwise
  // wipe the assistant's memory while the client still shows the transcript.
  // The client re-seeds prior turns on conversation.start.
  private seedHistory(turns?: { role: string; text: string }[]) {
    if (!Array.isArray(turns) || this.history.length > 0) return;

    this.history = turns
      .filter(
        (turn) =>
          (turn?.role === "user" || turn?.role === "assistant") &&
          typeof turn.text === "string" &&
          turn.text.trim().length > 0,
      )
      .map((turn) => ({
        role: turn.role as "user" | "assistant",
        content: turn.text.trim().slice(0, 800),
      }));
    this.trimHistory();
  }

  private speak(text: string) {
    if (!this.ttsReady || !this.tts || this.tts.readyState !== WebSocket.OPEN) {
      this.pendingSpeech.push(text);
      return;
    }

    this.tts.send(
      JSON.stringify({
        type: "input_text_buffer.append",
        text,
        context_id: this.ttsContextId,
      }),
    );
  }

  private commitSpeech() {
    if (!this.ttsReady || !this.tts || this.tts.readyState !== WebSocket.OPEN) {
      this.pendingCommit = true;
      return;
    }

    this.tts.send(
      JSON.stringify({
        type: "input_text_buffer.commit",
        context_id: this.ttsContextId,
      }),
    );
  }

  private flushSpeech() {
    const pending = this.pendingSpeech;
    this.pendingSpeech = [];
    pending.forEach((text) => this.speak(text));

    if (this.pendingCommit) {
      this.pendingCommit = false;
      this.commitSpeech();
    }
  }

  private cancelResponse() {
    this.chatAbort?.abort();
    this.chatAbort = undefined;
    this.pendingSpeech = [];
    this.pendingCommit = false;

    if (this.tts && this.tts.readyState === WebSocket.OPEN) {
      this.tts.send(JSON.stringify({ type: "context.cancel", context_id: this.ttsContextId }));
    }

    // Retire the context id so in-flight deltas from the cancelled turn are
    // dropped by the handleTtsMessage filter instead of reaching the client.
    this.ttsContextId = `turn-${this.turnCount}-cancelled`;

    this.send("audio.clear", {});
  }

  private send(type: string, payload: Record<string, unknown>) {
    if (this.stopped || this.client.readyState !== WebSocket.OPEN) return;
    this.client.send(JSON.stringify({ type, ...payload }));
  }

  private isDuplicateTranscript(transcript: string) {
    const normalized = normalizeTranscript(transcript);
    const now = Date.now();
    const duplicate =
      normalized === this.lastTranscript && now - this.lastTranscriptAt < 3000;

    this.lastTranscript = normalized;
    this.lastTranscriptAt = now;

    return duplicate;
  }

  private close() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.keepaliveTimer);
    clearTimeout(this.expiryTimer);
    this.chatAbort?.abort();
    this.stt?.close();
    this.tts?.close();
    if (this.client.readyState === WebSocket.OPEN) this.client.close();
  }
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

function compactErrorBody(body: string) {
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

function cleanTranscript(transcript: string) {
  const words = transcript.replace(/\s+/g, " ").trim().split(" ");
  const cleaned: string[] = [];
  let previous = "";
  let repeatCount = 0;

  for (const word of words) {
    const normalized = normalizeTranscript(word);
    repeatCount = normalized && normalized === previous ? repeatCount + 1 : 1;
    previous = normalized;

    if (repeatCount <= 2) cleaned.push(word);
  }

  return cleaned.join(" ").slice(0, 800).trim();
}

function normalizeTranscript(transcript: string) {
  return transcript
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseJson(data: WebSocket.RawData) {
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
}

function decodeFloat32(base64: string) {
  const buffer = Buffer.from(base64, "base64");
  const samples = new Float32Array(buffer.byteLength / 4);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = buffer.readFloatLE(i * 4);
  }
  return samples;
}

function resample(input: Float32Array, fromRate: number, toRate: number) {
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

function floatTo16BitPcm(input: Float32Array) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

async function* streamTogetherText(body: ReadableStream<Uint8Array>) {
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
