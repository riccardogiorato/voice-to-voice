import { createRealtimeEngine } from "@together/realtime";
import { DEMO_VOICE } from "./voice";

export const realtimeEngine = createRealtimeEngine({
  ...(process.env.TOGETHER_API_KEY ? { apiKey: process.env.TOGETHER_API_KEY } : {}),
  ...(process.env.TOGETHER_REALTIME_SECRET
    ? { realtimeSecret: process.env.TOGETHER_REALTIME_SECRET }
    : {}),
  models: {
    stt: "openai/whisper-large-v3",
    reply: "Qwen/Qwen3.5-9B",
    tts: "cartesia/sonic-3",
  },
  replyContextWindowTokens: 262_144,
  maxOutputTokens: 1024,
  defaultVoice: DEMO_VOICE,
  debug: process.env.TOGETHER_REALTIME_DEBUG === "1",
});
