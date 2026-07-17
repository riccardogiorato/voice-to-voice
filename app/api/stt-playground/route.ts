import { isAllowedOrigin } from "@/app/api/voice/voice-utils";
import {
  compareSttModels,
  decodeSttPlaygroundAudio,
} from "@/app/api/voice/stt-comparison";
import { STT_PLAYGROUND_SAMPLE_RATE } from "@/app/_lib/stt-playground";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }

  const apiKey = process.env.TOGETHER_API_KEY?.trim();
  if (!apiKey) {
    return Response.json(
      { error: "Together API key is not configured." },
      { status: 500 },
    );
  }

  try {
    const body = (await request.json()) as {
      audio?: unknown;
      sampleRate?: unknown;
    };
    if (body.sampleRate !== STT_PLAYGROUND_SAMPLE_RATE) {
      return Response.json(
        { error: `Audio must be ${STT_PLAYGROUND_SAMPLE_RATE} Hz PCM16.` },
        { status: 400 },
      );
    }
    const pcm16 = decodeSttPlaygroundAudio(body.audio);
    const results = await compareSttModels(pcm16, apiKey);
    return Response.json({ results });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Comparison failed." },
      { status: 400 },
    );
  }
}
