import { expect, test } from "bun:test";
import {
  decodeSttPlaygroundAudio,
  getSttComparisonModels,
  transcribeSttComparisonModel,
} from "./stt-comparison";

test("lists every public serverless STT model and keeps Inkling visible", async () => {
  const models = await getSttComparisonModels({
    apiKey: "test-key",
    now: () => 10_000,
    fetchImpl: (async () =>
      Response.json({
        data: [
          { id: "openai/whisper-large-v3", type: "transcribe", created: 0 },
          { id: "nvidia/nemotron-3.5-asr-streaming-0.6b", type: "transcribe", created: 0 },
          { id: "deepgram/nova-3-multi", type: "transcribe", created: 0 },
          { id: "user/private-asr", type: "transcribe", created: 1 },
          { id: "Qwen/Qwen3.5-9B", type: "chat", created: 0 },
        ],
      })) as typeof fetch,
  });

  expect(models.map((model) => model.id)).toEqual([
    "nvidia/nemotron-3.5-asr-streaming-0.6b",
    "openai/whisper-large-v3",
    "inkling",
  ]);
  expect(models.at(-1)).toMatchObject({
    kind: "inkling",
    model: "thinkingmachines/inkling",
  });
});

test("transcribes one requested model without waiting for a slow sibling", async () => {
  const audio = new Uint8Array([1, 0, 2, 0]);
  const result = await transcribeSttComparisonModel(
    audio,
    {
      id: "openai/whisper-large-v3",
      kind: "realtime",
      label: "Whisper Large v3",
      model: "openai/whisper-large-v3",
    },
    "test-key",
    {
      now: () => 10,
      transcribeRealtime: async (received, model) => {
        expect(received).toBe(audio);
        expect(model).toBe("openai/whisper-large-v3");
        return "Hello from Whisper";
      },
      transcribeInkling: async () => {
        throw new Error("Inkling must not be called for the Whisper request.");
      },
    },
  );

  expect(result).toMatchObject({
    id: "openai/whisper-large-v3",
    transcript: "Hello from Whisper",
    error: null,
  });
});

test("returns a card-local error instead of throwing", async () => {
  const result = await transcribeSttComparisonModel(
    new Uint8Array([1, 0]),
    {
      id: "inkling",
      kind: "inkling",
      label: "Inkling",
      model: "thinkingmachines/inkling",
    },
    "test-key",
    { transcribeInkling: async () => { throw new Error("Inkling unavailable"); } },
  );

  expect(result.error).toBe("Inkling unavailable");
  expect(result.transcript).toBe("");
});

test("turns an empty provider completion into a visible card-local error", async () => {
  const result = await transcribeSttComparisonModel(
    new Uint8Array([1, 0]),
    {
      id: "nvidia/nemotron-3-asr-streaming-0.6b",
      kind: "realtime",
      label: "Nemotron 3 ASR Streaming 0.6B",
      model: "nvidia/nemotron-3-asr-streaming-0.6b",
    },
    "test-key",
    { transcribeRealtime: async () => "" },
  );

  expect(result.error).toBe("Nemotron 3 ASR Streaming 0.6B returned an empty transcript.");
  expect(result.transcript).toBe("");
});

test("rejects missing, too-short, and oversized recordings", () => {
  expect(() => decodeSttPlaygroundAudio("")).toThrow("missing");
  expect(() => decodeSttPlaygroundAudio(Buffer.alloc(100).toString("base64"))).toThrow(
    "little longer",
  );
  expect(() =>
    decodeSttPlaygroundAudio(Buffer.alloc(16_000 * 2 * 20 + 2).toString("base64")),
  ).toThrow("limited to 20 seconds");
});
