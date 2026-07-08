# Together Voice Demo

A tiny voice-to-voice demo for Together AI:

Browser mic -> Vercel WebSocket -> Together realtime STT -> Together chat streaming -> Together realtime TTS -> browser audio.

The browser never receives the Together API key. It only connects to `/api/voice`.

## Run

```bash
npm install
npm run dev
```

`npm run dev` is useful for UI work, but full voice mode needs a runtime that supports WebSocket upgrades. For the working voice demo, deploy to Vercel.

Create `.env` with:

```bash
TOGETHER_API_KEY=...
```

Optional model overrides:

```bash
TOGETHER_STT_MODEL=nvidia/nemotron-3-asr-streaming-0.6b
TOGETHER_STT_FALLBACK_MODEL=openai/whisper-large-v3
TOGETHER_CHAT_MODEL=Qwen/Qwen2.5-7B-Instruct-Turbo
TOGETHER_TTS_MODEL=cartesia/sonic-3
TOGETHER_TTS_VOICE=47c38ca4-5f35-497b-b1a3-415245fb35e1
TOGETHER_TTS_FALLBACK_MODEL=hexgrad/Kokoro-82M
TOGETHER_TTS_FALLBACK_VOICE=af_heart
```

`Qwen/Qwen2.5-7B-Instruct-Turbo` is the default chat model because it reliably streams speakable assistant text for short voice turns. The route keeps `max_tokens` tight and forwards text to TTS sentence by sentence so the UI can show text while audio is generated.

## Deploy

Deploy to Vercel and set `TOGETHER_API_KEY` in the project environment:

```bash
vercel env add TOGETHER_API_KEY
vercel deploy
```

For a production URL:

```bash
vercel deploy --prod
```

This uses Vercel's `experimental_upgradeWebSocket()` API for Next.js App Router. WebSockets require Fluid Compute and are governed by Vercel Function max duration, so the route exports `maxDuration = 300`.

### Why the function region is pinned to `iad1`

`vercel.json` pins the function to `iad1` (US East). This was measured, not guessed (2026-07-08, probe function timing warm requests to `api.together.ai`):

| Function region | Warm RTT to Together API | First audio, measured from Europe |
| --------------- | ------------------------ | --------------------------------- |
| `iad1` (US East) | ~131 ms | **~1.2–1.3 s** |
| `sfo1` (US West) | ~78 ms | ~1.4–1.5 s |

Together's serverless inference origin is US West (behind Cloudflare), so `sfo1` is closest to the models — but the orchestrator talks to **both** sides: each turn is one client<->function exchange plus several function<->Together round trips. For users outside the US West coast, `iad1` sits between them and the models and wins end to end.

Rules of thumb:

- Keep the orchestrator near the model APIs, not near the user — the user leg is one streaming WebSocket, the Together leg is many round trips per turn.
- Demoing to a US West audience? Switch `regions` to `["sfo1"]` and redeploy; for users in SF both legs shorten and first audio should drop well under 1 s.
- Re-measure after any region change with `npm run test:voice -- <url>` (see below).

## Files

- `app/page.tsx` - mobile-first voice UI, mic capture, WebSocket client, PCM playback
- `app/api/voice/route.ts` - server-side WebSocket that hides the API key and orchestrates Together STT/chat/TTS

## End-to-end voice test

`scripts/e2e-voice-latency.mjs` drives a full voice turn over the deployed `/api/voice` WebSocket and reports per-stage latencies (STT, time-to-first-assistant-token, first audio, total) plus content/audio sanity checks. It requires a **deployed URL** — local `next dev` does not support WebSocket upgrades, so run it against your Vercel deployment.

```bash
npm run test:voice -- https://your-app.vercel.app
# or a full wss URL:
npm run test:voice -- wss://your-app.vercel.app/api/voice
```

On first run it auto-synthesizes the `test-fixtures/hello-16k.pcm` fixture via Together REST TTS (`hexgrad/Kokoro-82M`), so `TOGETHER_API_KEY` must be available (exported or in `.env`) for that one-time step. The fixture is reused on subsequent runs.

Latency budgets are tunable with env vars (defaults shown):

```bash
BUDGET_STT_MS=4000         # transcript.final within this after audio.commit
BUDGET_FIRST_AUDIO_MS=7000 # first audio.delta within this after audio.commit
BUDGET_TOTAL_MS=20000      # audio.done within this after audio.commit
```

Full results are written to `bench-results/voice-e2e-<timestamp>.json`. The script exits `0` only if every assertion passes, `1` otherwise.
