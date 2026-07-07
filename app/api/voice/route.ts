import { experimental_upgradeWebSocket } from "@vercel/functions";
import WebSocket from "ws";

export const runtime = "nodejs";
export const maxDuration = 300;

const STT_MODEL = process.env.TOGETHER_STT_MODEL ?? "openai/whisper-large-v3";
const CHAT_MODEL = process.env.TOGETHER_CHAT_MODEL ?? "Qwen/Qwen3.5-9B";
const TTS_MODEL = process.env.TOGETHER_TTS_MODEL ?? "hexgrad/Kokoro-82M";
const TTS_VOICE = process.env.TOGETHER_TTS_VOICE ?? "af_heart";

type ClientEvent =
  | { type: "conversation.start" }
  | { type: "conversation.stop" }
  | { type: "response.cancel" }
  | { type: "audio.input"; audio: string; sampleRate: number };

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const systemPrompt =
  "You are a warm, concise voice assistant for a Together AI demo. " +
  "Answer naturally in one or two short spoken sentences. No markdown.";

export async function GET() {
  return experimental_upgradeWebSocket((client) => {
    const session = new VoiceSession(client);
    session.start();
  });
}

class VoiceSession {
  private stt?: WebSocket;
  private tts?: WebSocket;
  private chatAbort?: AbortController;
  private messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
  private generation = 0;
  private ttsContext = "turn-0";
  private ttsReady = false;
  private pendingSpeech: string[] = [];
  private pendingCommit = false;
  private stopped = false;

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

    this.connectStt();
    this.connectTts();
    this.send("state", { state: "connecting" });
  }

  private connectStt() {
    const url = new URL("wss://api.together.ai/v1/realtime");
    url.searchParams.set("intent", "transcription");
    url.searchParams.set("model", STT_MODEL);
    url.searchParams.set("input_audio_format", "pcm_s16le_16000");
    url.searchParams.set("min_silence_duration_ms", "650");
    url.searchParams.set("max_speech_duration_s", "8");

    this.stt = new WebSocket(url.toString(), {
      headers: { Authorization: `Bearer ${process.env.TOGETHER_API_KEY}` },
    });

    this.stt.on("open", () => this.send("state", { state: "listening" }));
    this.stt.on("message", (data) => this.handleSttMessage(data));
    this.stt.on("error", () =>
      this.send("error", { message: "Together realtime STT connection failed." }),
    );
  }

  private connectTts() {
    const url = new URL("wss://api.together.ai/v1/audio/speech/websocket");
    url.searchParams.set("model", TTS_MODEL);
    url.searchParams.set("voice", TTS_VOICE);
    url.searchParams.set("response_format", "pcm");
    url.searchParams.set("sample_rate", "24000");
    url.searchParams.set("segment", "sentence");
    url.searchParams.set("max_partial_length", "160");

    this.tts = new WebSocket(url.toString(), {
      headers: { Authorization: `Bearer ${process.env.TOGETHER_API_KEY}` },
    });

    this.tts.on("message", (data) => this.handleTtsMessage(data));
    this.tts.on("error", () =>
      this.send("error", { message: "Together realtime TTS connection failed." }),
    );
  }

  private handleClientMessage(data: WebSocket.RawData) {
    let event: ClientEvent;
    try {
      event = JSON.parse(data.toString()) as ClientEvent;
    } catch {
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
      const transcript = String(message.transcript ?? "").trim();
      if (transcript.length > 0) {
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

    if (
      message.context_id &&
      message.context_id !== this.ttsContext &&
      message.type !== "context.cancelled"
    ) {
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
      this.send("error", { message: message.error?.message ?? "TTS failed." });
    }
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

  private async answer(transcript: string) {
    this.cancelResponse();
    this.generation += 1;
    this.ttsContext = `turn-${this.generation}`;
    this.send("audio.clear", {});
    this.send("state", { state: "thinking" });

    this.messages.push({ role: "user", content: transcript });
    this.messages = [this.messages[0], ...this.messages.slice(-8)];

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
          messages: this.messages,
          max_tokens: 120,
          temperature: 0.45,
          reasoning: { enabled: false },
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Together chat failed with ${response.status}`);
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
        this.messages.push({ role: "assistant", content: assistant.trim() });
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

  private speak(text: string) {
    if (!this.ttsReady || !this.tts || this.tts.readyState !== WebSocket.OPEN) {
      this.pendingSpeech.push(text);
      return;
    }

    this.tts.send(
      JSON.stringify({
        type: "input_text_buffer.append",
        text,
        context_id: this.ttsContext,
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
        context_id: this.ttsContext,
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
      this.tts.send(
        JSON.stringify({ type: "context.cancel", context_id: this.ttsContext }),
      );
      this.tts.send(JSON.stringify({ type: "input_text_buffer.clear" }));
    }

    this.send("audio.clear", {});
  }

  private send(type: string, payload: Record<string, unknown>) {
    if (this.stopped || this.client.readyState !== WebSocket.OPEN) return;
    this.client.send(JSON.stringify({ type, ...payload }));
  }

  private close() {
    if (this.stopped) return;
    this.stopped = true;
    this.chatAbort?.abort();
    this.stt?.close();
    this.tts?.close();
    if (this.client.readyState === WebSocket.OPEN) this.client.close();
  }
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
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          yield delta;
        }
      } catch {
        // Ignore partial or non-JSON SSE lines.
      }
    }
  }
}
