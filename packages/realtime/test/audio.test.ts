import { describe, expect, it } from "vitest";
import { pcm16DurationMs, resamplePcm16Base64 } from "../src/index.js";

describe("PCM16 audio", () => {
  it("resamples 24 kHz mono PCM16 to 16 kHz deterministically", () => {
    const input = new Int16Array(240);
    for (let index = 0; index < input.length; index += 1) input[index] = index * 100;
    const encoded = Buffer.from(input.buffer).toString("base64");
    const output = Buffer.from(resamplePcm16Base64(encoded), "base64");
    expect(output.byteLength).toBe(160 * 2);
    expect(new Int16Array(output.buffer, output.byteOffset, output.byteLength / 2)[10]).toBe(1500);
  });

  it("calculates playback duration at the public 24 kHz format", () => {
    expect(pcm16DurationMs(Buffer.alloc(48_000).toString("base64"))).toBe(1000);
  });
});
