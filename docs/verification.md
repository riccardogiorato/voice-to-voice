# Verification record

Date: 2026-07-14 (Europe/Rome)

## Deterministic and build checks

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Passed for `@together/realtime` and the Next.js demo |
| `pnpm build` | Passed package ESM/declaration build and Next.js 16.2.10 production build |
| `pnpm test` | 5 files passed, 15 tests passed |
| In-app browser `?smoke=1` | Agents SDK secret + WebSocket connection passed; received `session.created` and two `session.updated` events; clean disconnect; no console errors |

The smoke query deliberately skips `getUserMedia`; it verifies the real browser
SDK/transport without capturing ambient audio. Normal demo microphone capture is
implemented but was not exercised by automation because that would transmit
live ambient audio.

## Paid Together black-box suite

`pnpm test:e2e` passed 5/5 using a Node client with browser WebSocket
subprotocols and only the demo's public HTTP/WebSocket endpoints:

| Case | Result | Wall time |
| --- | --- | ---: |
| Manual PCM16 STT -> reply -> streamed TTS | Passed | 4,484 ms |
| Together server VAD without manual commit | Passed | 7,912 ms |
| Client function tool and result resume | Passed | 2,675 ms |
| Server-VAD barge-in cancels active output | Passed | 4,410 ms |
| Recoverable protocol error keeps session valid | Passed | 11 ms |

The suite used real paid/network calls to Together. It did not use provider
mocks. The generated JSON report is intentionally ignored under `e2e-results/`
because it contains run-specific timing and transcripts.

## Live serverless catalog

Authenticated `GET https://api.together.ai/v1/models` returned HTTP 200 with:

| Stage | ID | Live type / relevant value |
| --- | --- | --- |
| STT | `openai/whisper-large-v3` | `transcribe` |
| Reply | `Qwen/Qwen3.5-9B` | `chat`, context length 262,144 |
| TTS | `cartesia/sonic-3` | `audio` |

The paid suite additionally proved each exact model through its inference
endpoint. `cartesia/sonic-3.5` was deliberately not used: although discoverable
in broader model and voices data, its inference socket returned a dedicated-
endpoint requirement rather than serverless service. There is no fallback.

The demo voice `nonfiction man` was accepted by the live Sonic 3 WebSocket.

## Not deployment-verified

No Vercel or Railway deployment was created because this review gate forbids
deployments and previews. The Dockerfile was not built locally because the
configured Docker/Colima daemon socket did not exist. The package and Next
production builds passed independently; a human should still validate the
container and each target host before release.
