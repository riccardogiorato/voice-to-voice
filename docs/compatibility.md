# Realtime compatibility matrix

Tested client: `@openai/agents` `0.13.3` using `OpenAIRealtimeWebSocket` and a
custom URL. The goal is compatibility for the documented voice-agent slice,
not a claim that Together's pipeline is an OpenAI Realtime model.

| Surface | Status | Behavior |
| --- | --- | --- |
| `POST /v1/realtime/client_secrets`-shaped response | Supported | Returns `value`, `expires_at`, and effective `session`; demo path is `/api/realtime/client_secrets` |
| Browser WebSocket subprotocol authentication | Supported | Accepts `realtime` plus `openai-insecure-api-key.<ek_...>` |
| `session.update`: instructions | Supported | Up to 32,000 characters |
| `session.update`: function tools and tool choice | Supported | Function tools execute client-side; hosted tools are rejected |
| Voice selection | Supported | Any non-empty Together voice name; locked after first output audio |
| Input/output formats | Supported | Mono PCM16 at 24 kHz only |
| Turn detection | Supported | `server_vad` or `null` for manual commit |
| Barge-in | Supported | Speech start cancels the response and truncates unheard assistant audio |
| Conversation item create/delete/retrieve/truncate | Supported | Text, audio-transcript, function call, and function output items in the implemented slice |
| `response.create` / `response.cancel` | Supported | One active response per session |
| Context truncation | Supported | `auto` removes oldest complete turns and keeps function call/output pairs; `disabled` emits an error |
| `tracing: null`, `include: []` | Ignored | Harmless compatibility fields; the core records no telemetry |
| Client STT/reply/TTS model selection | Rejected | All three model IDs are explicit server configuration |
| Non-PCM formats, speed changes, noise reduction | Rejected | These would change audio behavior |
| `semantic_vad`, retention-ratio truncation | Rejected | Not implemented by this engine |
| Hosted MCP, web search, image tools | Rejected | Only local function tools are supported |
| Temperature, reasoning, prompt objects, parallel-tool override | Rejected | Cannot be ignored without changing output, cost, or tool semantics |
| Per-response overrides in `response.create` | Rejected | Configure the session first; overrides would change expected output |
| Non-null tracing or response include fields | Rejected | No core telemetry and no fabricated fields |
| Unknown session keys | Rejected | Prevents silent behavior or cost drift |
| WebRTC and SIP | Rejected | WebSocket transport only |

## Error behavior

Client mistakes produce an OpenAI-shaped `error` event with `type`, `code`,
`message`, `param`, and the triggering event ID when available. Recoverable
protocol mistakes keep the WebSocket open. Authentication and malformed upgrade
requests fail the HTTP upgrade. Provider failures complete an active response as
failed and are not masked by switching models.

## Intentionally absent

The core has no telemetry, rate limiting, persistence, database, moderation,
distributed session store, or provider fallback. Applications can add policy in
`onSessionUpdate`, and operational controls belong outside the engine.
