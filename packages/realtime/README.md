# `@together/realtime`

A Node.js 22+ TypeScript engine that presents an OpenAI-compatible Realtime
WebSocket while orchestrating Together STT, tool-capable chat, and TTS.

## Engine

Models are server configuration, never client choices and never implicit
defaults.

```ts
import { createRealtimeEngine } from "@together/realtime";

export const engine = createRealtimeEngine({
  apiKey: process.env.TOGETHER_API_KEY,
  realtimeSecret: process.env.TOGETHER_REALTIME_SECRET,
  models: {
    stt: "openai/whisper-large-v3",
    reply: "Qwen/Qwen3.5-9B",
    tts: "cartesia/sonic-3",
  },
  replyContextWindowTokens: 262_144,
  maxOutputTokens: 1024,
  defaultVoice: "nonfiction man",
  onSessionUpdate(requested, context) {
    // Optional application policy hook. Return the allowed session update.
    return requested;
  },
});
```

`defaultVoice` is required because valid voices depend on the configured TTS
model. Query Together's `/v1/voices?model=<model>` endpoint rather than relying
on an alias from another model version. Clients may select any voice accepted
by that server-configured model until the first output audio is emitted.

`TOGETHER_REALTIME_SECRET` signs stateless `ek_...` client secrets. Production
secret issuance and authentication fail closed if it is absent; local
development creates a process-local secret and prints a warning. Validation is
lazy so a production build does not need runtime credentials. A secret contains
only a session ID, expiry, audience, and small immutable policy. It contains no
Together credential or conversation.

## Node.js adapter

```ts
import { createServer } from "node:http";
import { createNodeRealtimeAdapter } from "@together/realtime/node";
import { engine } from "./engine.js";

const adapter = createNodeRealtimeAdapter(engine, {
  allowedOrigins: ["https://voice.example.com"],
});

const server = createServer(async (request, response) => {
  if (await adapter.handleRequest(request, response)) return;
  response.writeHead(404).end();
});

adapter.attach(server);
server.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
```

The default endpoints are:

- `POST /api/realtime/client_secrets`
- `GET /api/realtime?model=together-realtime` upgraded to WebSocket

The browser subprotocols are `realtime` and
`openai-insecure-api-key.<client-secret>`. The server selects only `realtime`,
so the credential is not echoed back.

## Next.js adapter

Create the engine in a server-only module. Then expose one handler at each
route. These routes require the Node.js runtime.

```ts
// app/api/realtime/client_secrets/route.ts
import { createNextRealtimeHandlers } from "@together/realtime/next";
import { engine } from "@/lib/realtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createNextRealtimeHandlers(engine).POST;
```

```ts
// app/api/realtime/route.ts
import { createNextRealtimeHandlers } from "@together/realtime/next";
import { engine } from "@/lib/realtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createNextRealtimeHandlers(engine).GET;
```

The WebSocket handler uses Vercel's experimental upgrade helper when deployed
as a Next.js function. For ordinary Node servers, use the Node adapter even if
Next.js renders the UI; this is the setup used by the local demo.

## Contract boundary

The engine accepts OpenAI-style `session.update`, input-audio, conversation,
response, and cancellation events. Function tools execute in the client. Reply
generation uses the Vercel AI SDK Together provider and resumes only after the
client sends `function_call_output` plus `response.create`.

The Together provider sets `reasoning: { enabled: false }` on chat requests.
This is an explicit server-side voice policy: it prevents hybrid reasoning
models such as the example Qwen model from consuming the output budget before
emitting speakable text, while preserving AI SDK function-tool handling.

All audio is mono signed PCM16 at 24 kHz on the public socket. The Together STT
leg is resampled to 16 kHz internally. Server VAD and manual `input_audio_buffer.commit`
are supported. See the repository compatibility matrix for exact behavior.
