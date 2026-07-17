export const STT_PLAYGROUND_MODELS = [
  {
    id: "parakeet",
    label: "Parakeet",
    model: "nvidia/parakeet-tdt-0.6b-v3",
  },
  {
    id: "whisper",
    label: "Whisper Large v3",
    model: "openai/whisper-large-v3",
  },
  {
    id: "inkling",
    label: "Inkling",
    model: "thinkingmachines/inkling",
  },
] as const;

export type SttPlaygroundModelId = (typeof STT_PLAYGROUND_MODELS)[number]["id"];

export const STT_PLAYGROUND_SAMPLE_RATE = 16_000;
export const STT_PLAYGROUND_MAX_SECONDS = 20;
