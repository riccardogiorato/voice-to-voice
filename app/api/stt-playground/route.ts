import { isAllowedOrigin } from "@/app/api/voice/voice-utils";
import {
  decodeSttPlaygroundAudio,
  getSttComparisonModels,
  transcribeSttComparisonModel,
} from "@/app/api/voice/stt-comparison";
import { STT_PLAYGROUND_SAMPLE_RATE } from "@/app/_lib/stt-playground";

export const runtime = "nodejs";
export const maxDuration = 60;

function getApiKey() {
  return process.env.TOGETHER_API_KEY?.trim();
}

export async function GET(request: Request) {
  if (!isAllowedOrigin(request)) {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return Response.json(
      { error: "Together API key is not configured." },
      { status: 500 },
    );
  }
  return Response.json({ models: await getSttComparisonModels({ apiKey }) });
}

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return Response.json(
      { error: "Together API key is not configured." },
      { status: 500 },
    );
  }

  try {
    const body = (await request.json()) as {
      audio?: unknown;
      model?: unknown;
      sampleRate?: unknown;
    };
    if (body.sampleRate !== STT_PLAYGROUND_SAMPLE_RATE) {
      return Response.json(
        { error: `Audio must be ${STT_PLAYGROUND_SAMPLE_RATE} Hz PCM16.` },
        { status: 400 },
      );
    }
    const pcm16 = decodeSttPlaygroundAudio(body.audio);
    if (typeof body.model !== "string" || !body.model) {
      return Response.json({ error: "A comparison model is required." }, { status: 400 });
    }
    const models = await getSttComparisonModels({ apiKey });
    const model = models.find((entry) => entry.id === body.model);
    if (!model) {
      return Response.json({ error: "Unknown transcription model." }, { status: 400 });
    }
    const result = await transcribeSttComparisonModel(pcm16, model, apiKey);
    return Response.json({ result });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Comparison failed." },
      { status: 400 },
    );
  }
}
