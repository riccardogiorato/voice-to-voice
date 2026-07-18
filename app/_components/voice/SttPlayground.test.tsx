import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createVoiceCaptureConstraints,
  formatVoiceCaptureInfo,
  pcm16WavBlobFromBase64,
} from "@/app/_lib/client-audio";
import { SttPlayground } from "./SttPlayground";

test("renders the push-to-talk comparison for every shipped serverless model", () => {
  const markup = renderToStaticMarkup(<SttPlayground />);

  expect(markup).toContain("Hold to speak");
  expect(markup).toContain("Press and hold");
  expect(markup).toContain("Parakeet TDT 0.6B v3");
  expect(markup).toContain("Whisper Large v3");
  expect(markup).toContain("Nemotron 3 ASR Streaming 0.6B");
  expect(markup).toContain("Nemotron 3.5 ASR Streaming 0.6B");
  expect(markup).toContain("Inkling FP4");
  expect(markup).toContain("Spoken language");
  expect(markup).toContain("Auto-detect");
  expect(markup).toContain("no VAD, reply model, or TTS involved");
});

test("wraps the same PCM bytes sent to Together in a playable WAV", async () => {
  const blob = pcm16WavBlobFromBase64("AQACAA==");
  const wav = new Uint8Array(await blob.arrayBuffer());

  expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
  expect([...wav.subarray(44)]).toEqual([1, 0, 2, 0]);
});

test("requests the browser voice-processing controls it supports", () => {
  const constraints = createVoiceCaptureConstraints({
    autoGainControl: true,
    echoCancellation: true,
    noiseSuppression: true,
  });

  expect(constraints).toMatchObject({
    autoGainControl: { ideal: false },
    channelCount: { ideal: 1 },
    echoCancellation: { ideal: false },
    noiseSuppression: { ideal: true },
    sampleRate: { ideal: 48_000 },
  });
  expect(
    formatVoiceCaptureInfo({
      autoGainControl: false,
      channelCount: 1,
      contextSampleRate: 48_000,
      echoCancellation: false,
      noiseSuppression: true,
      trackSampleRate: 48_000,
    }),
  ).toContain("48 kHz mono");
});
