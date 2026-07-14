# Deployment guidance

The engine holds conversation, VAD, and response state in the process that owns
each WebSocket. Deploy it on a Node.js 22 runtime with one WebSocket pinned to
one process for its lifetime. No database or shared session store is required,
and reconnecting starts a new session.

## Local container

```bash
docker build -t together-realtime-v2 .
docker run --rm -p 3000:3000 \
  -e TOGETHER_API_KEY \
  -e TOGETHER_REALTIME_SECRET \
  together-realtime-v2
```

The image builds the workspace and starts the demo server on `0.0.0.0:$PORT`.
Terminate connections during shutdown and let clients create a new secret and
session after reconnecting.

## Vercel

Use the Next adapter routes and enable a Node.js function runtime with Fluid
Compute. The adapter depends on Vercel's experimental WebSocket upgrade helper,
so pin and retest `@vercel/functions` before upgrades.

Vercel functions have finite duration. As of 2026-07-14, Vercel documents up to
1,800 seconds for Pro and Enterprise Node.js functions in the extended-duration
Fluid Compute beta. Set the route's `maxDuration` to the duration your plan
supports and design the client to reconnect before it expires. Hobby limits are
shorter. See [Vercel's extended duration announcement](https://vercel.com/changelog/extended-durations-for-vercel-functions) and [function duration documentation](https://vercel.com/docs/functions/configuring-functions/duration).

Required environment variables:

```text
TOGETHER_API_KEY
TOGETHER_REALTIME_SECRET
```

Set an origin allowlist in application code for a cross-origin client. Deploy a
single region near the expected users and Together endpoints, then measure the
complete STT-to-first-audio path; geographic advice without measurement is not
portable.

## Railway

Railway detects the root Dockerfile. Configure the two secrets, generate a
public domain, and use `/` as a basic HTTP health check. The server already binds
to `0.0.0.0` and reads Railway's `PORT` variable, as required by [Railway public networking](https://docs.railway.com/public-networking).

Railway documents a 15-minute maximum request duration, including WebSockets.
The client must reconnect with a new client secret and new in-memory session
after that boundary or any deployment restart. See Railway's [WebSocket guide](https://docs.railway.com/guides/socketio) and [SSE versus WebSockets guide](https://docs.railway.com/guides/sse-vs-websockets).

Do not scale a single conversation across instances. Horizontal replicas are
fine when each upgraded connection remains on one replica; this engine neither
needs nor provides cross-instance session synchronization.

## Operational checklist

- Use a distinct high-entropy `TOGETHER_REALTIME_SECRET` per environment.
- Restrict allowed browser origins in production.
- Enforce user authentication before issuing a client secret in the host app.
- Put rate limits, quotas, moderation, logs, and metrics around the engine if the
  product needs them; they are intentionally not core features.
- Re-run `pnpm test:e2e` against the public deployment with `E2E_BASE_URL` before
  routing users to it.
