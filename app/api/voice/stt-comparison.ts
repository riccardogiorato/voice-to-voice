import WebSocket from "ws";
import {
  buildInklingAudioRequest,
  createInklingAudioCompletion,
  pcm16ToWav,
  TOGETHER_INKLING_MODEL,
} from "./inkling";
import { cleanTranscript } from "./voice-utils";
import {
  STT_PLAYGROUND_MAX_SECONDS,
  STT_PLAYGROUND_MODELS,
  STT_PLAYGROUND_SAMPLE_RATE,
  type SttPlaygroundModelId,
} from "@/app/_lib/stt-playground";

export { STT_PLAYGROUND_MAX_SECONDS, STT_PLAYGROUND_SAMPLE_RATE };

export const STT_COMPARISON_MODELS = STT_PLAYGROUND_MODELS.map((entry) => ({
  ...entry,
  model: entry.id === "inkling" ? TOGETHER_INKLING_MODEL : entry.model,
  kind: entry.id === "inkling" ? ("inkling" as const) : ("realtime" as const),
}));
const STT_TIMEOUT_MS = 25_000;
const STT_CHUNK_BYTES = 32_000;

export type SttComparisonResult = {
  id: SttPlaygroundModelId;
  label: string;
  model: string;
  transcript: string;
  latencyMs: number;
  error: string | null;
};

type ComparisonDependencies = {
  transcribeRealtime?: typeof transcribeRealtimeModel;
  transcribeInkling?: typeof transcribeInklingModel;
  now?: () => number;
};

export async function compareSttModels(
  pcm16: Uint8Array,
  apiKey: string,
  dependencies: ComparisonDependencies = {},
): Promise<SttComparisonResult[]> {
  const realtime = dependencies.transcribeRealtime ?? transcribeRealtimeModel;
  const inkling = dependencies.transcribeInkling ?? transcribeInklingModel;
  const now = dependencies.now ?? performance.now.bind(performance);

  return Promise.all(
    STT_COMPARISON_MODELS.map(async (entry) => {
      const startedAt = now();
      try {
        const transcript =
          entry.kind === "inkling"
            ? await inkling(pcm16, apiKey)
            : await realtime(pcm16, entry.model, apiKey);
        return {
          id: entry.id,
          label: entry.label,
          model: entry.model,
          transcript: cleanTranscript(transcript),
          latencyMs: Math.max(0, Math.round(now() - startedAt)),
          error: null,
        };
      } catch (error) {
        return {
          id: entry.id,
          label: entry.label,
          model: entry.model,
          transcript: "",
          latencyMs: Math.max(0, Math.round(now() - startedAt)),
          error: error instanceof Error ? error.message : "Transcription failed.",
        };
      }
    }),
  );
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
      let event: Record<string, any>;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (event.type === "conversation.item.input_audio_transcription.completed") {
        finish(undefined, String(event.transcript ?? ""));
      } else if (
        event.type === "conversation.item.input_audio_transcription.failed" ||
        event.type === "error"
      ) {
        finish(
          new Error(
            String(event.error?.message ?? event.message ?? `${model} failed.`),
          ),
        );
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      if (!settled) finish(new Error(`${model} disconnected before finishing.`));
    });
  });
}

export async function transcribeInklingModel(
  pcm16: Uint8Array,
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
    system:
      "You are a multilingual speech transcription engine. Preserve the " +
      "speaker's language, names, wording, and hesitations. Never answer the speech.",
  });
  const completion = await createInklingAudioCompletion({ apiKey, request });
  const match = completion.content.match(
    /<transcript>\s*([\s\S]*?)\s*<\/transcript>/i,
  );
  const transcript = cleanTranscript(match?.[1] ?? completion.content);
  if (!transcript) throw new Error("Inkling returned an empty transcript.");
  return transcript;
}
