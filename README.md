# Together Voice-to-Voice v2

An OpenAI Realtime-compatible voice pipeline built from Together's serverless
speech-to-text, chat, and text-to-speech models. The reusable TypeScript engine
is framework-neutral; Node.js and Next.js adapters keep the transport layer
thin.

```text
PCM16 microphone -> Together STT -> AI SDK tool-capable reply -> Together TTS -> PCM16 audio
```

The Together API key stays on the server. Browsers first request a short-lived,
stateless signed client secret, then authenticate the Realtime WebSocket with
the same subprotocol shape used by the OpenAI Agents SDK.

## Requirements

- Node.js 22 or newer
- pnpm 11
- `TOGETHER_API_KEY`
- `TOGETHER_REALTIME_SECRET` in every non-local environment

```bash
cp .env.example .env
pnpm install
pnpm test
pnpm demo
```

Open <http://localhost:3000>, allow microphone access, and connect. The demo
uses `@openai/agents` with a local function tool against the custom Realtime
URL.

For a transport-only browser smoke test that must not capture ambient audio,
open <http://localhost:3000/?smoke=1>. It uses the same Agents SDK connection
and session configuration but deliberately skips `getUserMedia`.

## Workspace

- `packages/realtime` - engine, Together provider, stateless client secrets,
  OpenAI-compatible session state, Node adapter, and Next adapter
- `examples/demo` - Next.js browser demo and paid public-endpoint black-box suite
- `docs/compatibility.md` - supported, ignored, and rejected contract surface
- `docs/deployment.md` - local container, Vercel, and Railway guidance
- `docs/verification.md` - dated deterministic, paid-network, browser, and catalog evidence

The example models are deliberately explicit, with no fallback:

| Stage | Model | Live Together catalog check |
| --- | --- | --- |
| STT | `openai/whisper-large-v3` | present as `transcribe` on 2026-07-14 |
| Reply | `Qwen/Qwen3.5-9B` | present as `chat`, 262,144-token context on 2026-07-14 |
| TTS | `cartesia/sonic-3` | present in the live serverless catalog and paid WebSocket probe on 2026-07-14 |

Applications must pass all three model IDs and the reply context window when
constructing the engine. A provider error is surfaced; the engine never changes
models silently. The example disables Qwen's optional reasoning mode in the
server-side Together request so voice replies do not spend the output budget on
hidden thinking before producing speakable text.

The demo voice `nonfiction man` was also confirmed by the live Sonic 3
WebSocket on 2026-07-14. The package requires an explicit default because voice
catalogs are model-specific.

## Verification

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm test:e2e
pnpm demo
```

`pnpm test` is deterministic and uses fake providers. `pnpm test:e2e` is
explicitly paid/networked: it starts the demo, obtains a client secret over
HTTP, and drives the WebSocket like a browser using only public endpoints. It
checks manual commit, server VAD, function-tool continuation, barge-in, PCM16
audio, event ordering, and a nonfatal protocol error. Provider mocks are not
treated as integration proof.

## Package usage

See [`packages/realtime/README.md`](packages/realtime/README.md) for the engine
API and complete Node.js and Next.js adapter examples. The tested OpenAI Agents
SDK version is `0.13.3`; compatibility outside the matrix is not implied.

This v2 core intentionally has no telemetry, rate limiter, persistence,
database, or distributed session coordination. Session state lives in the
process that owns the WebSocket.
