import { RealtimeProtocolError } from "./types.js";

export function resamplePcm16Base64(
  audio: string,
  fromRate = 24000,
  toRate = 16000,
) {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(audio, "base64");
  } catch {
    throw new RealtimeProtocolError(
      "Audio must be valid base64-encoded PCM16.",
      "invalid_audio",
      "audio",
    );
  }
  if (bytes.length === 0 || bytes.length % 2 !== 0) {
    throw new RealtimeProtocolError(
      "Audio must contain complete PCM16 samples.",
      "invalid_audio",
      "audio",
    );
  }
  if (fromRate === toRate) return bytes.toString("base64");

  const input = new Int16Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength / Int16Array.BYTES_PER_ELEMENT,
  );
  const outputLength = Math.floor((input.length * toRate) / fromRate);
  const output = new Int16Array(outputLength);
  const ratio = fromRate / toRate;

  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const mix = position - left;
    output[i] = Math.round((input[left] ?? 0) * (1 - mix) + (input[right] ?? 0) * mix);
  }

  return Buffer.from(output.buffer, output.byteOffset, output.byteLength).toString("base64");
}

export function pcm16DurationMs(base64: string, sampleRate = 24000) {
  return Math.floor((Buffer.from(base64, "base64").byteLength / 2 / sampleRate) * 1000);
}
