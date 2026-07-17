export const VOICE_PIPELINES = ["classic", "inkling"] as const;

export type VoicePipeline = (typeof VOICE_PIPELINES)[number];

export function parseVoicePipeline(value: string | null | undefined): VoicePipeline {
  return value?.toLowerCase() === "inkling" ? "inkling" : "classic";
}
