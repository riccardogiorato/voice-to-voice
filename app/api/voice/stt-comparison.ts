import WebSocket from "ws";
import {
  buildInklingAudioRequest,
  createInklingAudioCompletion,
  pcm16ToWav,
  TOGETHER_MODELS_URL,
} from "./inkling";
import { cleanTranscript } from "./voice-utils";
import {
  STT_PLAYGROUND_FALLBACK_MODELS,
  STT_PLAYGROUND_MAX_SECONDS,
  STT_PLAYGROUND_SAMPLE_RATE,
  type SttComparisonModel,
  type SttComparisonResult,
} from "@/app/_lib/stt-playground";

export { STT_PLAYGROUND_MAX_SECONDS, STT_PLAYGROUND_SAMPLE_RATE };
export type { SttComparisonModel, SttComparisonResult };

const STT_TIMEOUT_MS = 25_000;
const STT_CHUNK_BYTES = 32_000;
const MODEL_CATALOG_CACHE_MS = 5 * 60_000;
const DEDICATED_ONLY_STT_PREFIXES = ["deepgram/"];

type TogetherCatalogModel = {
  created?: unknown;
  display_name?: unknown;
  id?: unknown;
  type?: unknown;
};

let catalogCache:
  | { expiresAt: number; models: SttComparisonModel[] }
  | undefined;

function toComparisonModel(model: TogetherCatalogModel): SttComparisonModel | null {
  if (model.type !== "transcribe" || typeof model.id !== "string" || !model.id) {
    return null;
  }
  const id = model.id;
  if (typeof model.created === "number" && model.created !== 0) return null;
  if (DEDICATED_ONLY_STT_PREFIXES.some((prefix) => id.startsWith(prefix))) {
    return null;
  }

  return {
    id,
    kind: "realtime",
    label:
      typeof model.display_name === "string" && model.display_name
        ? model.display_name
        : id,
    model: id,
  };
}

export async function getSttComparisonModels({
  apiKey,
  fetchImpl = fetch,
  now = Date.now,
}: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<SttComparisonModel[]> {
  if (catalogCache && catalogCache.expiresAt > now()) return catalogCache.models;

  try {
    const response = await fetchImpl(TOGETHER_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`Together model catalog failed (${response.status}).`);

    const body = (await response.json()) as { data?: unknown } | unknown[];
    const catalog = Array.isArray(body) ? body : Array.isArray(body.data) ? body.data : [];
    const realtime = catalog
      .map((entry) => toComparisonModel(entry as TogetherCatalogModel))
      .filter((entry): entry is SttComparisonModel => entry !== null)
      .sort((left, right) => left.label.localeCompare(right.label));
    const audioChatModels = STT_PLAYGROUND_FALLBACK_MODELS.filter(
      (entry) => entry.kind === "audio-chat",
    );
    const models = [...realtime, ...audioChatModels];
    if (!models.length) throw new Error("Together returned no serverless STT models.");

    catalogCache = { expiresAt: now() + MODEL_CATALOG_CACHE_MS, models };
    return models;
  } catch {
    return STT_PLAYGROUND_FALLBACK_MODELS;
  }
}

export async function transcribeSttComparisonModel(
  pcm16: Uint8Array,
  entry: SttComparisonModel,
  apiKey: string,
  dependencies: {
    now?: () => number;
    transcribeAudioChat?: typeof transcribeAudioChatModel;
    transcribeRealtime?: typeof transcribeRealtimeModel;
  } = {},
): Promise<SttComparisonResult> {
  const now = dependencies.now ?? performance.now.bind(performance);
  const startedAt = now();
  const realtime = dependencies.transcribeRealtime ?? transcribeRealtimeModel;
  const audioChat = dependencies.transcribeAudioChat ?? transcribeAudioChatModel;

  try {
    const transcript =
      entry.kind === "audio-chat"
        ? await audioChat(pcm16, entry.model, apiKey)
        : await realtime(pcm16, entry.model, apiKey);
    const cleanedTranscript = cleanTranscript(transcript);
    if (!cleanedTranscript) {
      throw new Error(`${entry.label} returned an empty transcript.`);
    }
    return {
      ...entry,
      transcript: cleanedTranscript,
      latencyMs: Math.max(0, Math.round(now() - startedAt)),
      error: null,
    };
  } catch (error) {
    return {
      ...entry,
      transcript: "",
      latencyMs: Math.max(0, Math.round(now() - startedAt)),
      error: error instanceof Error ? error.message : "Transcription failed.",
    };
  }
}

export function decodeSttPlaygroundAudio(value: unknown) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Recorded audio is missing.");
  }

  const pcm16 = new Uint8Array(Buffer.from(value, "base64"));
  const maxBytes = STT_PLAYGROUND_SAMPLE_RATE * 2 * STT_PLAYGROUND_MAX_SECONDS;
  if (pcm16.byteLength < STT_PLAYGROUND_SAMPLE_RATE / 2) {
    throw new Error("Hold the button a little longer before releasing.");
  }
  if (pcm16.byteLength > maxBytes) {
    throw new Error(`Recordings are limited to ${STT_PLAYGROUND_MAX_SECONDS} seconds.`);
  }
  if (pcm16.byteLength % 2 !== 0) {
    throw new Error("Recorded audio contains an incomplete PCM sample.");
  }
  return pcm16;
}

export function transcribeRealtimeModel(
  pcm16: Uint8Array,
  model: string,
  apiKey: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL("wss://api.together.ai/v1/realtime");
    url.searchParams.set("intent", "transcription");
    url.searchParams.set("model", model);
    url.searchParams.set("input_audio_format", "pcm_s16le_16000");
    url.searchParams.set("turn_detection", "none");

    const socket = new WebSocket(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error(`${model} timed out.`)),
      STT_TIMEOUT_MS,
    );

    function finish(error?: Error, transcript?: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close(1000, "comparison complete");
      }
      if (error) reject(error);
      else resolve(transcript ?? "");
    }

    socket.on("open", () => {
      for (let offset = 0; offset < pcm16.byteLength; offset += STT_CHUNK_BYTES) {
        const chunk = pcm16.subarray(
          offset,
          Math.min(offset + STT_CHUNK_BYTES, pcm16.byteLength),
        );
        socket.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: Buffer.from(chunk).toString("base64"),
          }),
        );
      }
      socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    });
    socket.on("message", (data) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event.type === "conversation.item.input_audio_transcription.completed") {
        finish(undefined, String(event.transcript ?? ""));
      } else if (
        event.type === "conversation.item.input_audio_transcription.failed" ||
        event.type === "error"
      ) {
        const detail = event.error as { message?: unknown } | undefined;
        finish(new Error(String(detail?.message ?? event.message ?? `${model} failed.`)));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      if (!settled) finish(new Error(`${model} disconnected before finishing.`));
    });
  });
}

export async function transcribeAudioChatModel(
  pcm16: Uint8Array,
  model: string,
  apiKey: string,
) {
  const wav = pcm16ToWav(pcm16, STT_PLAYGROUND_SAMPLE_RATE);
  const request = buildInklingAudioRequest({
    audio: {
      data: Buffer.from(wav).toString("base64"),
      format: "wav",
      numFrames: pcm16.byteLength / 2,
      sampleRate: STT_PLAYGROUND_SAMPLE_RATE,
    },
    instruction:
      "Transcribe the spoken audio exactly. Return only " +
      "<transcript>the exact spoken words</transcript> and no other text.",
    maxTokens: 300,
    model,
    system:
      "You are a multilingual speech transcription engine. Preserve the " +
      "speaker's language, names, wording, and hesitations. Never answer the speech.",
  });
  const completion = await createInklingAudioCompletion({ apiKey, request });
  const match = completion.content.match(/<transcript>\s*([\s\S]*?)\s*<\/transcript>/i);
  const transcript = cleanTranscript(match?.[1] ?? completion.content);
  if (!transcript) throw new Error(`${model} returned an empty transcript.`);
  return transcript;
}
