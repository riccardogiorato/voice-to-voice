import type { MutableRefObject } from "react";

type VadDecision = {
  probability: number;
  isSpeech: boolean;
};

type TenVadModule = {
  _ten_vad_create(handlePtr: number, hopSize: number, threshold: number): number;
  _ten_vad_process(
    handle: number,
    audioDataPtr: number,
    audioDataLength: number,
    outProbabilityPtr: number,
    outFlagPtr: number,
  ): number;
  _ten_vad_destroy(handlePtr: number): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAP16: Int16Array;
  HEAP32: Int32Array;
  HEAPF32: Float32Array;
};

type TenVadImport = {
  default(options?: { locateFile?: (path: string) => string }): Promise<TenVadModule>;
};

const VAD_OPEN_THRESHOLD = 0.62;
const VAD_CLOSE_THRESHOLD = 0.38;
const TEN_VAD_SAMPLE_RATE = 16_000;
const TEN_VAD_HOP_SIZE = 256;
const THINKING_SOUND_URL = "/thinking-sounds/gemini-bips-loop.mp3";
const THINKING_ASSET_BASE_GAIN = 0.065;

export type ThinkingSoundHandle = {
  setVolume: (volume: number) => void;
  stop: () => void;
};

type WindowWithAudioContext = Window & {
  webkitAudioContext?: typeof AudioContext;
};

export function getVoiceSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/voice`;
}

export async function loadBrowserTenVad() {
  const modulePath = "/ten-vad/ten_vad.js";
  const imported = (await import(/* webpackIgnore: true */ modulePath)) as TenVadImport;
  const vadModule = await imported.default({
    locateFile: (path) => `/ten-vad/${path}`,
  });
  return new BrowserTenVad(vadModule);
}

export class BrowserTenVad {
  private handle = 0;
  private readonly handlePtr: number;
  private readonly audioPtr: number;
  private readonly probabilityPtr: number;
  private readonly flagPtr: number;
  private leftover = new Int16Array(0);
  private destroyed = false;

  constructor(private vadModule: TenVadModule) {
    this.handlePtr = vadModule._malloc(4);
    this.audioPtr = vadModule._malloc(TEN_VAD_HOP_SIZE * 2);
    this.probabilityPtr = vadModule._malloc(4);
    this.flagPtr = vadModule._malloc(4);

    if (
      vadModule._ten_vad_create(
        this.handlePtr,
        TEN_VAD_HOP_SIZE,
        (VAD_OPEN_THRESHOLD + VAD_CLOSE_THRESHOLD) / 2,
      ) !== 0
    ) {
      this.destroy();
      throw new Error("TEN VAD failed to initialize.");
    }

    this.handle = vadModule.HEAP32[this.handlePtr >> 2];
    if (!this.handle) {
      this.destroy();
      throw new Error("TEN VAD returned an empty handle.");
    }
  }

  process(input: Float32Array, sampleRate: number): VadDecision | null {
    if (this.destroyed) return null;

    const pcm16 = downsampleToPcm16(input, sampleRate, TEN_VAD_SAMPLE_RATE);
    const samples = concatInt16(this.leftover, pcm16);
    let offset = 0;
    let maxProbability = 0;
    let isSpeech = false;
    let frames = 0;

    while (offset + TEN_VAD_HOP_SIZE <= samples.length) {
      const frame = samples.subarray(offset, offset + TEN_VAD_HOP_SIZE);
      this.vadModule.HEAP16.set(frame, this.audioPtr >> 1);

      if (
        this.vadModule._ten_vad_process(
          this.handle,
          this.audioPtr,
          TEN_VAD_HOP_SIZE,
          this.probabilityPtr,
          this.flagPtr,
        ) === 0
      ) {
        frames += 1;
        const probability = this.vadModule.HEAPF32[this.probabilityPtr >> 2];
        maxProbability = Math.max(maxProbability, probability);
        isSpeech = isSpeech || this.vadModule.HEAP32[this.flagPtr >> 2] === 1;
      }

      offset += TEN_VAD_HOP_SIZE;
    }

    this.leftover = samples.slice(offset);
    if (frames === 0) return null;
    return { probability: maxProbability, isSpeech };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.handle) this.vadModule._ten_vad_destroy(this.handlePtr);
    this.vadModule._free(this.handlePtr);
    this.vadModule._free(this.audioPtr);
    this.vadModule._free(this.probabilityPtr);
    this.vadModule._free(this.flagPtr);
    this.leftover = new Int16Array(0);
  }
}

export function createMicWorkletUrl() {
  const source = `
    class MicCaptureProcessor extends AudioWorkletProcessor {
      process(inputs) {
        const input = inputs[0] && inputs[0][0];
        if (input && input.length) {
          const copy = new Float32Array(input);
          this.port.postMessage(copy, [copy.buffer]);
        }
        return true;
      }
    }

    registerProcessor("mic-capture", MicCaptureProcessor);
  `;

  return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}

export function float32ToBase64(input: Float32Array) {
  const bytes = new Uint8Array(input.length * 4);
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < input.length; i += 1) {
    view.setFloat32(i * 4, input[i], true);
  }

  return bytesToBase64(bytes);
}

export function pcm16Base64FromFloat32(
  input: Float32Array,
  fromRate: number,
  toRate = 16_000,
) {
  const pcm16 = downsampleToPcm16(input, fromRate, toRate);
  const bytes = new Uint8Array(pcm16.length * 2);
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < pcm16.length; i += 1) {
    view.setInt16(i * 2, pcm16[i], true);
  }

  return bytesToBase64(bytes);
}

export function rms(input: Float32Array) {
  let sum = 0;

  for (let i = 0; i < input.length; i += 1) {
    sum += input[i] * input[i];
  }

  return Math.sqrt(sum / Math.max(1, input.length));
}

export function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

export function normalizeRange(value: number, floor: number, ceiling: number) {
  if (ceiling <= floor) return 0;
  return clamp01((value - floor) / (ceiling - floor));
}

export function createInteractiveAudioContext() {
  const AudioContextCtor =
    window.AudioContext ?? (window as WindowWithAudioContext).webkitAudioContext;
  if (!AudioContextCtor) throw new Error("Web Audio is not available in this browser.");
  return new AudioContextCtor({ latencyHint: "interactive" });
}

export function createThinkingSound(
  audioContext: AudioContext,
  volume = 1,
): ThinkingSoundHandle {
  const master = audioContext.createGain();
  master.gain.value = 0;
  master.connect(audioContext.destination);

  let source: AudioBufferSourceNode | null = null;
  let stopped = false;
  let currentVolume = clamp01(volume);

  const setVolume = (nextVolume: number) => {
    currentVolume = clamp01(nextVolume);

    master.gain.setTargetAtTime(
      THINKING_ASSET_BASE_GAIN * currentVolume,
      audioContext.currentTime,
      0.025,
    );
  };

  void fetch(THINKING_SOUND_URL)
    .then((response) => {
      if (!response.ok) throw new Error("Thinking sound asset failed to load.");
      return response.arrayBuffer();
    })
    .then((arrayBuffer) => audioContext.decodeAudioData(arrayBuffer))
    .then((buffer) => {
      if (stopped) return;

      source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(master);
      source.start();
      setVolume(currentVolume);
    })
    .catch(() => {});

  setVolume(volume);

  return {
    setVolume,
    stop: () => {
      stopped = true;

      try {
        master.gain.setTargetAtTime(0, audioContext.currentTime, 0.025);
      } catch {}

      setTimeout(() => {
        try {
          source?.stop();
        } catch {}
        try {
          source?.disconnect();
        } catch {}
        try {
          master.disconnect();
        } catch {}
      }, 80);
    },
  };
}

export function concatFloat32(chunks: Float32Array[], totalLength: number) {
  const output = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

function downsampleToPcm16(input: Float32Array, fromRate: number, toRate: number) {
  if (fromRate <= 0 || input.length === 0) return new Int16Array(0);

  if (Math.abs(fromRate - toRate) < 1) {
    const output = new Int16Array(input.length);
    for (let index = 0; index < input.length; index += 1) {
      output[index] = floatToPcm16Sample(input[index]);
    }
    return output;
  }

  const ratio = fromRate / toRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Int16Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.max(start + 1, Math.floor((index + 1) * ratio));
    let sum = 0;
    let count = 0;

    for (let sampleIndex = start; sampleIndex < end && sampleIndex < input.length; sampleIndex += 1) {
      sum += input[sampleIndex];
      count += 1;
    }

    output[index] = floatToPcm16Sample(sum / Math.max(1, count));
  }

  return output;
}

function floatToPcm16Sample(input: number) {
  const sample = Math.max(-1, Math.min(1, input));
  return sample < 0 ? sample * 0x8000 : sample * 0x7fff;
}

function concatInt16(left: Int16Array, right: Int16Array) {
  if (left.length === 0) return right;
  if (right.length === 0) return left;

  const output = new Int16Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

export function base64Pcm16ToFloat32(
  base64: string,
  leftoverRef: MutableRefObject<Uint8Array | null>,
) {
  let bytes = base64ToBytes(base64);

  if (leftoverRef.current) {
    bytes = concatBytes(leftoverRef.current, bytes);
    leftoverRef.current = null;
  }

  if (bytes.byteLength % 2 === 1) {
    leftoverRef.current = bytes.subarray(bytes.byteLength - 1);
    bytes = bytes.subarray(0, bytes.byteLength - 1);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));

  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }

  return samples;
}

function concatBytes(left: Uint8Array, right: Uint8Array) {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left, 0);
  output.set(right, left.byteLength);
  return output;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}
