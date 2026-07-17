export type SttComparisonModel = {
  id: string;
  kind: "audio-chat" | "realtime";
  label: string;
  model: string;
};

export type SttComparisonResult = SttComparisonModel & {
  error: string | null;
  latencyMs: number;
  transcript: string;
};

export const STT_PLAYGROUND_FALLBACK_MODELS: SttComparisonModel[] = [
  {
    id: "nvidia/parakeet-tdt-0.6b-v3",
    kind: "realtime",
    label: "Parakeet TDT 0.6B v3",
    model: "nvidia/parakeet-tdt-0.6b-v3",
  },
  {
    id: "openai/whisper-large-v3",
    kind: "realtime",
    label: "Whisper Large v3",
    model: "openai/whisper-large-v3",
  },
  {
    id: "nvidia/nemotron-3-asr-streaming-0.6b",
    kind: "realtime",
    label: "Nemotron 3 ASR Streaming 0.6B",
    model: "nvidia/nemotron-3-asr-streaming-0.6b",
  },
  {
    id: "nvidia/nemotron-3.5-asr-streaming-0.6b",
    kind: "realtime",
    label: "Nemotron 3.5 ASR Streaming 0.6B",
    model: "nvidia/nemotron-3.5-asr-streaming-0.6b",
  },
  {
    id: "inkling",
    kind: "audio-chat",
    label: "Inkling FP4",
    model: "thinkingmachines/inkling",
  },
];

export const STT_PLAYGROUND_SAMPLE_RATE = 16_000;
export const STT_PLAYGROUND_MAX_SECONDS = 20;
