import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserTenVad, rms } from "@/app/_lib/client-audio";
import {
  detectBargeInSpeech,
  trackBargeInAttempt,
  type BargeInAttempt,
} from "./useVoiceConversation";

// Regression for the "cannot interrupt the assistant" bug: natural speech dips
// below the barge-in thresholds for tens of milliseconds between phonemes, so
// any sustain logic that demands gapless evidence never fires. This replays
// real speech fixtures through the real TEN VAD wasm at the exact cadence of
// the mic-capture worklet (128-sample chunks at 48kHz) and asserts a barge-in
// fires while the assistant is speaking.

const ROOT = join(import.meta.dir, "..", "..");
const SAMPLE_RATE = 48_000;
const CHUNK = 128;

async function loadVad() {
  const imported = await import(join(ROOT, "public/ten-vad/ten_vad.js"));
  const vadModule = await imported.default({
    wasmBinary: readFileSync(join(ROOT, "public/ten-vad/ten_vad.wasm")),
  });
  return new BrowserTenVad(vadModule);
}

function loadFixtureAs48k(name: string) {
  const bytes = readFileSync(join(ROOT, "test-fixtures", name));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples16k = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < samples16k.length; i += 1) {
    samples16k[i] = view.getInt16(i * 2, true) / 32768;
  }
  const samples48k = new Float32Array(samples16k.length * 3);
  for (let i = 0; i < samples16k.length; i += 1) {
    samples48k[i * 3] = samples16k[i];
    samples48k[i * 3 + 1] = samples16k[i];
    samples48k[i * 3 + 2] = samples16k[i];
  }
  return samples48k;
}

async function replayThroughBargeInGate(audio: Float32Array) {
  const vad = await loadVad();
  let attempt: BargeInAttempt = {
    startedAt: Number.NEGATIVE_INFINITY,
    lastEvidenceAt: Number.NEGATIVE_INFINITY,
    ready: false,
  };
  let firedAtMs: number | null = null;

  for (let offset = 0; offset + CHUNK <= audio.length; offset += CHUNK) {
    const now = (offset / SAMPLE_RATE) * 1000;
    const input = audio.subarray(offset, offset + CHUNK);
    const vadDecision = vad.process(input, SAMPLE_RATE);
    attempt = trackBargeInAttempt({
      hasBargeInSpeech: detectBargeInSpeech({
        level: rms(input),
        vadProbability: vadDecision?.probability ?? null,
      }),
      startedAt: attempt.startedAt,
      lastEvidenceAt: attempt.lastEvidenceAt,
      now,
    });
    if (attempt.ready) {
      firedAtMs = now;
      break;
    }
  }

  vad.destroy();
  return firedAtMs;
}

for (const fixture of ["stt-bench-en-1.pcm", "stt-bench-en-2.pcm"]) {
  test(`barge-in fires within 1s of continuous real speech (${fixture})`, async () => {
    const firedAtMs = await replayThroughBargeInGate(loadFixtureAs48k(fixture));

    expect(firedAtMs).not.toBeNull();
    expect(firedAtMs!).toBeLessThan(1_000);
  });
}

test("barge-in never fires on silence", async () => {
  const firedAtMs = await replayThroughBargeInGate(
    new Float32Array(SAMPLE_RATE * 2),
  );

  expect(firedAtMs).toBeNull();
});
