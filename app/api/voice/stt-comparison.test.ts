import { expect, test } from "bun:test";
import {
  compareSttModels,
  decodeSttPlaygroundAudio,
  STT_COMPARISON_MODELS,
} from "./stt-comparison";

test("sends the same audio to both realtime models and Inkling", async () => {
  const audio = new Uint8Array([1, 0, 2, 0]);
  const calls: Array<{ kind: string; audio: Uint8Array; model?: string }> = [];
  let clock = 100;

  const results = await compareSttModels(audio, "test-key", {
    now: () => (clock += 25),
    transcribeRealtime: async (received, model) => {
      calls.push({ kind: "realtime", audio: received, model });
      return `Transcript from ${model}`;
    },
    transcribeInkling: async (received) => {
      calls.push({ kind: "inkling", audio: received });
      return "Transcript from Inkling";
    },
  });

  expect(calls).toHaveLength(3);
  expect(calls.every((call) => call.audio === audio)).toBe(true);
  expect(calls.filter((call) => call.kind === "realtime").map((call) => call.model)).toEqual(
    STT_COMPARISON_MODELS.slice(0, 2).map((entry) => entry.model),
  );
  expect(results.map((result) => result.id)).toEqual([
    "parakeet",
    "whisper",
    "inkling",
  ]);
  expect(results.every((result) => result.error === null)).toBe(true);
});

test("keeps one model failure isolated from the other transcripts", async () => {
  const results = await compareSttModels(new Uint8Array([1, 0]), "test-key", {
    transcribeRealtime: async (_audio, model) => {
      if (model.includes("whisper")) throw new Error("Whisper unavailable");
      return "Parakeet transcript";
    },
    transcribeInkling: async () => "Inkling transcript",
  });

  expect(results[0].transcript).toBe("Parakeet transcript");
  expect(results[1].error).toBe("Whisper unavailable");
  expect(results[2].transcript).toBe("Inkling transcript");
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
