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
TOGETHER_STT_MODEL=openai/whisper-large-v3
TOGETHER_CHAT_MODEL=Qwen/Qwen2.5-7B-Instruct-Turbo
TOGETHER_TTS_MODEL=hexgrad/Kokoro-82M
TOGETHER_TTS_VOICE=af_heart
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

## Files

- `app/page.tsx` - mobile-first voice UI, mic capture, WebSocket client, PCM playback
- `app/api/voice/route.ts` - server-side WebSocket that hides the API key and orchestrates Together STT/chat/TTS
