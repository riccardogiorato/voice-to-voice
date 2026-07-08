#!/usr/bin/env node
// scripts/benchmark-together-tts.mts
//
// Standalone text-to-speech latency benchmark for Together AI TTS models.
// Measures time-to-first-audio per model/voice using the lowest-latency
// supported delivery method for each model: realtime websocket for Kokoro and
// Orpheus, REST audio generation for Cartesia Sonic models.
//
//   * Opens wss://api.together.ai/v1/audio/speech/websocket?model=<m>&voice=<v>
//     &response_format=pcm&sample_rate=24000&segment=sentence with an
//     Authorization: Bearer <key> header and records sessionMs from connection
//     start to the first session.created event.
//   * Reuses ONE socket per model for every (sentence, run) in that model's
//     matrix: sends input_text_buffer.append then input_text_buffer.commit,
//     and measures firstAudioMs (commit -> first audio_output.delta) and
//     doneMs (commit -> last audio_output.done). Accumulates base64-decoded
//     PCM bytes -> audioSeconds = bytes/2/24000 (16-bit @ 24 kHz) and
//     rtf = audioSeconds / (doneMs/1000).
//   * Handles conversation.item.tts.failed and websocket errors per-run;
//     a model whose socket cannot be opened is recorded as failed and the run
//     moves on. Never aborts the whole benchmark.
//   * Prints a per-model aligned table and a final median summary, and writes
//     full results to bench-results/together-tts-<timestamp>.json.
//
// Only external dependency is 'ws' (already installed). Requires Node 20+.
//
// Usage:
//   TOGETHER_API_KEY=... node scripts/benchmark-together-tts.mts
//   node scripts/benchmark-together-tts.mts --models "hexgrad/Kokoro-82M,cartesia/sonic" --runs 3
//   TTS_BENCH_MODELS="hexgrad/Kokoro-82M" node scripts/benchmark-together-tts.mts --runs 5
//
// Reads TOGETHER_API_KEY from process.env. Also tries to load ./.env when the
// key is not already exported, so the project's gitignored .env works out of
// the box. The model list is taken from --models, else TTS_BENCH_MODELS, else
// the built-in serverless TTS catalog.

import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

type CliArgs = {
  models: string[] | null;
  runs: number;
  timeout: number;
  outDir: string;
  noJson: boolean;
  help: boolean;
};

type RunStatus = 'ok' | 'error';

type TtsRunEntry = {
  model?: string;
  sentenceNo: number;
  runNo: number;
  sentence?: string;
  status: RunStatus;
  error: string | null;
  firstAudioMs: number | null;
  doneMs: number | null;
  audioSeconds: number | null;
  rtf: number | null;
  audioBytes: number;
  deltaCount: number;
  doneCount: number;
};

type ActiveRunState = {
  sentenceNo: number;
  runNo: number;
  sentence: string;
  status: RunStatus;
  error: string | null;
  commitAt: number;
  firstAudioAt: number | null;
  firstDoneAt: number | null;
  lastDoneAt: number | null;
  doneAt: number | null;
  audioBytes: number;
  deltaCount: number;
  doneCount: number;
  lastActivityAt: number;
  settled: boolean;
};

type ModelResult = {
  model: string;
  voice: string | null;
  delivery: Delivery;
  url: string;
  sessionMs: number | null;
  status: 'ok' | 'failed';
  connectionError: string | null;
  runs: TtsRunEntry[];
};

type ModelSummary = {
  model: string;
  voice: string | null;
  delivery: Delivery;
  status: 'ok' | 'failed';
  sessionMs: number | null;
  runs: number;
  ok: number;
  errors: number;
  medianFirstAudioMs: number | null;
  medianDoneMs: number | null;
  medianAudioSeconds: number | null;
  medianRtf: number | null;
  connectionError: string | null;
  lastError: string | null;
};

type Delivery = 'websocket' | 'rest';

// ---------- constants ----------

const WS_ENDPOINT = 'wss://api.together.ai/v1/audio/speech/websocket';
const REST_ENDPOINT = 'https://api.together.ai/v1/audio/speech';

// Together serverless TTS catalog, verified against /v1/models on 2026-07-08.
// Override with --models / TTS_BENCH_MODELS for ad hoc tests.
const DEFAULT_MODELS = [
  'hexgrad/Kokoro-82M',
  'canopylabs/orpheus-3b-0.1-ft',
  'cartesia/sonic',
  'cartesia/sonic-3',
  'cartesia/sonic-2',
];

// Default voice per model, verified against /v1/voices on 2026-07-08.
const DEFAULT_VOICES: Record<string, string> = {
  'hexgrad/Kokoro-82M': 'af_heart',
  'canopylabs/orpheus-3b-0.1-ft': 'tara',
  'cartesia/sonic': 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4',
  'cartesia/sonic-3': 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4',
  'cartesia/sonic-2': 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4',
};

const DELIVERY_BY_MODEL: Record<string, Delivery> = {
  'hexgrad/Kokoro-82M': 'websocket',
  'canopylabs/orpheus-3b-0.1-ft': 'websocket',
  'cartesia/sonic': 'rest',
  'cartesia/sonic-3': 'rest',
  'cartesia/sonic-2': 'rest',
};

// PCM is 16-bit little-endian mono at 24 kHz (per the websocket reference).
const SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2;

// Exactly these three sentences, in this order.
const SENTENCES = [
  'Hello! How are you doing today?',
  'Together AI serves over two hundred open source models with fast inference APIs.',
  'The quick brown fox jumps over the lazy dog, while the curious cat watches from the windowsill.',
];

// After the last audio_output.done, wait this long for any further segment
// before declaring the run complete. segment=sentence can split a single
// committed buffer into multiple items (e.g. "Hello! How are you doing
// today?" -> two done events), so completion is inferred from a quiet period
// following the last done. This mirrors the documented websocket example's
// "stop when no new chunks arrive for 0.3s" loop.
const QUIET_GRACE_MS = 500;

// Per-run timeout (from the commit send). A timeout counts as a failed run.
const DEFAULT_RUN_TIMEOUT_MS = 20000;

// ---------- helpers ----------

function loadDotEnv(file: string) {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    models: null,
    runs: 3,
    timeout: DEFAULT_RUN_TIMEOUT_MS,
    outDir: 'bench-results',
    noJson: false,
    help: false,
  };
  const rest = [...argv];
  const need = (name: string) => {
    const v = rest.shift();
    if (v === undefined) throw new Error(`Missing value for ${name}`);
    return v;
  };
  while (rest.length) {
    const arg = rest.shift();
    switch (arg) {
      case '--models':
        a.models = need('--models')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--runs':
        a.runs = parseInt(need('--runs'), 10);
        break;
      case '--timeout':
        a.timeout = parseInt(need('--timeout'), 10);
        break;
      case '--out-dir':
        a.outDir = need('--out-dir');
        break;
      case '--no-json':
        a.noJson = true;
        break;
      case '-h':
      case '--help':
        a.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return a;
}

function printHelp() {
  console.log(`benchmark-together-tts.mts - Together TTS latency benchmark

Usage:
  node scripts/benchmark-together-tts.mts [options]

Options:
  --models "a,b"      Comma-separated TTS model ids to benchmark
                      (default: ${DEFAULT_MODELS.join(',')})
                      Also overridable via TTS_BENCH_MODELS env var.
  --runs N            Repetitions per (model, sentence) (default 3)
  --timeout MS        Per-run timeout in ms, measured from the commit (default 20000)
  --out-dir DIR       JSON output directory (default bench-results)
  --no-json           Skip writing JSON results file
  -h, --help          Show this help and exit

Env:
  TOGETHER_API_KEY    Required. Also auto-loaded from ./.env if not exported.
  TTS_BENCH_MODELS    Comma-separated model list fallback when --models is absent.

Notes:
  Uses the configured delivery method for each model: websocket for Kokoro and
  Orpheus, REST audio generation for Cartesia Sonic models. Voices come from
  the built-in DEFAULT_VOICES map, verified with /v1/voices.
  tts.failed / socket errors are recorded per-run and never abort the run; a
  model whose socket cannot open is marked failed and the benchmark continues.
  Exit code is 0 as long as the benchmark completes, even with failed models.
`);
}

function median(arr: number[]) {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const fmtMs = (v: number | null) => (v == null ? '-' : Math.round(v).toLocaleString('en-US'));
const fmt3 = (v: number | null) => (v == null ? '-' : v.toFixed(3));

function trunc(s: unknown, n: number) {
  const text = String(s ?? '');
  return text.length <= n ? text : text.slice(0, n - 1) + '…';
}

function errorString(e: unknown) {
  if (e == null) return 'Unknown error';
  if (typeof e === 'string') return e;
  if (e instanceof Error) return `${e.name || 'Error'}: ${e.message}`;
  return String(e);
}

function deliveryFor(model: string): Delivery {
  return DELIVERY_BY_MODEL[model] ?? 'rest';
}

function buildUrl(model: string) {
  if (deliveryFor(model) === 'rest') return REST_ENDPOINT;
  const url = new URL(WS_ENDPOINT);
  url.searchParams.set('model', model);
  const voice = voiceFor(model);
  if (voice) {
    url.searchParams.set('voice', voice);
  }
  url.searchParams.set('response_format', 'pcm');
  url.searchParams.set('sample_rate', String(SAMPLE_RATE));
  url.searchParams.set('segment', 'sentence');
  return url.toString();
}

function voiceFor(model: string) {
  return DEFAULT_VOICES[model] ?? null;
}

// ---------- per-model runner ----------

async function runModel(model: string, runs: number, timeoutMs: number, apiKey: string): Promise<ModelResult> {
  if (deliveryFor(model) === 'rest') return runRestModel(model, runs, timeoutMs, apiKey);
  return runWebSocketModel(model, runs, timeoutMs, apiKey);
}

// Open and run the full (sentence x runs) matrix for one model on a single
// shared websocket. Resolves to a model result object; never throws.
async function runWebSocketModel(model: string, runs: number, timeoutMs: number, apiKey: string): Promise<ModelResult> {
  const result: ModelResult = {
    model,
    voice: voiceFor(model),
    delivery: 'websocket',
    url: buildUrl(model),
    sessionMs: null,
    status: 'ok',
    connectionError: null,
    runs: [], // per (sentence, run) entries
  };

  const connectStart = performance.now();
  let ws: WebSocket;
  try {
    ws = new WebSocket(result.url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (e) {
    result.status = 'failed';
    result.connectionError = `WebSocket init failed: ${errorString(e)}`;
    fillFailedRuns(result, runs, result.connectionError);
    return result;
  }

  // session.created fence. The socket is shared, so the message handler stays
  // attached for the whole run; runState points at the active run (or null
  // between runs) so the same handler routes every message.
  let sessionReady = false;
  let sessionError: string | null = null;
  let runState: ActiveRunState | null = null;

  const handleFatal = (msg: string) => {
    if (!sessionReady) {
      sessionError = msg;
    } else if (runState && !runState.settled) {
      runState.error = msg;
      runState.settled = true;
      runState.doneAt = performance.now();
    }
  };

  ws.on('message', (data: WebSocket.RawData) => {
    let message: {
      type?: string;
      delta?: string;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    const type = message?.type;

    if (type === 'session.created') {
      if (!sessionReady) {
        sessionReady = true;
        result.sessionMs = performance.now() - connectStart;
      }
      return;
    }

    // Once the session is up, route everything to the active run.
    if (!runState || runState.settled) return;

    if (type === 'conversation.item.audio_output.delta') {
      const now = performance.now();
      if (typeof message.delta === 'string' && message.delta.length > 0) {
        const chunk = Buffer.from(message.delta, 'base64');
        runState.audioBytes += chunk.length;
        runState.deltaCount += 1;
      }
      // firstAudioMs is measured from the commit send. Ignore any deltas that
      // arrive before the commit (segment=sentence can start emitting on the
      // append for text that already ends a sentence).
      if (runState.firstAudioAt == null && now >= runState.commitAt) {
        runState.firstAudioAt = now;
      }
      runState.lastActivityAt = now;
      return;
    }

    if (type === 'conversation.item.audio_output.done') {
      const now = performance.now();
      if (runState.firstDoneAt == null) runState.firstDoneAt = now;
      runState.lastDoneAt = now;
      runState.doneCount += 1;
      runState.lastActivityAt = now;
      return;
    }

    if (type === 'conversation.item.tts.failed') {
      runState.error =
        message?.error?.message ?? 'conversation.item.tts.failed';
      runState.settled = true;
      runState.doneAt = performance.now();
      return;
    }

    // Other event types (conversation.item.input_text.received,
    // conversation.item.word_timestamps, context.cancelled, ...) are ignored.
  });

  ws.on('error', (err) => {
    handleFatal(errorString(err));
  });

  // If the socket drops mid-run, fail the active run; if it drops before the
  // session is established, mark the whole model failed.
  ws.on('close', () => {
    if (!sessionReady) {
      if (!sessionError) sessionError = 'Socket closed before session.created';
    } else if (runState && !runState.settled) {
      runState.error = 'Socket closed before audio_output.done';
      runState.settled = true;
      runState.doneAt = performance.now();
    }
  });

  // Wait for session.created (with a bounded timeout). A failure here fails
  // the entire model: e.g. model_not_available on this account, bad api key.
  const sessionOk = await new Promise<boolean>((resolve) => {
    const settled = () => resolve(sessionReady);
    if (sessionReady || sessionError) return settled();
    let done = false;
    const finish = (val: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => {
      if (!sessionReady && !sessionError) sessionError = 'Timed out waiting for session.created';
      finish(sessionReady);
    }, timeoutMs);
    // Re-check on each turn of the event loop until the session resolves.
    const tick = () => {
      if (sessionReady || sessionError) return finish(sessionReady);
      setImmediate(tick);
    };
    tick();
  });

  if (!sessionOk) {
    result.status = 'failed';
    result.connectionError = sessionError || 'Could not establish TTS session';
    fillFailedRuns(result, runs, result.connectionError);
    try {
      ws.close();
    } catch {}
    return result;
  }

  console.log(
    `  session ready in ${fmtMs(result.sessionMs)} ms` +
      (result.voice ? ` (voice=${result.voice})` : ' (voice=server-default)'),
  );

  // Run the (sentence x runs) matrix sequentially on this one socket, waiting
  // for each commit's audio_output.done before the next commit.
  for (let s = 0; s < SENTENCES.length; s += 1) {
    const sentence = SENTENCES[s];
    for (let r = 1; r <= runs; r += 1) {
      const entry = await runOne(ws, s + 1, r, sentence, timeoutMs, (st) => {
        runState = st;
      });
      result.runs.push(entry);

      const tag = `s${s + 1}r${r}`;
      if (entry.status === 'ok') {
        console.log(
          `  [${tag}] ok  firstAudio=${fmtMs(entry.firstAudioMs)} ms  ` +
            `done=${fmtMs(entry.doneMs)} ms  audio=${fmt3(entry.audioSeconds)} s  ` +
            `rtf=${fmt3(entry.rtf)}  (${entry.deltaCount} deltas, ${entry.doneCount} done)`,
        );
      } else {
        console.log(`  [${tag}] ERROR - ${trunc(entry.error || '', 140)}`);
      }

      // If the socket died on this run, the remaining runs for this model
      // cannot reuse it; record them as failed with the same cause and stop.
      if (ws.readyState !== WebSocket.OPEN) {
        const cause = entry.error || 'Socket closed';
        for (let r2 = r + 1; r2 <= runs; r2 += 1) {
          result.runs.push(makeFailedRun(s + 1, r2, `Socket closed mid-run: ${cause}`));
        }
        for (let s2 = s + 1; s2 < SENTENCES.length; s2 += 1) {
          for (let r2 = 1; r2 <= runs; r2 += 1) {
            result.runs.push(
              makeFailedRun(s2 + 1, r2, 'Socket unavailable (closed by previous run)'),
            );
          }
        }
        return result;
      }
    }
  }

  try {
    ws.close();
  } catch {}

  return result;
}

async function runRestModel(model: string, runs: number, timeoutMs: number, apiKey: string): Promise<ModelResult> {
  const result: ModelResult = {
    model,
    voice: voiceFor(model),
    delivery: 'rest',
    url: REST_ENDPOINT,
    sessionMs: null,
    status: 'ok',
    connectionError: null,
    runs: [],
  };

  console.log(`  REST endpoint (voice=${result.voice ?? 'server-default'})`);

  for (let s = 0; s < SENTENCES.length; s += 1) {
    const sentence = SENTENCES[s];
    for (let r = 1; r <= runs; r += 1) {
      const entry = await runRestOne(model, result.voice, s + 1, r, sentence, timeoutMs, apiKey);
      result.runs.push(entry);

      const tag = `s${s + 1}r${r}`;
      if (entry.status === 'ok') {
        console.log(
          `  [${tag}] ok  firstAudio=${fmtMs(entry.firstAudioMs)} ms  ` +
            `done=${fmtMs(entry.doneMs)} ms  audio=${fmt3(entry.audioSeconds)} s  ` +
            `rtf=${fmt3(entry.rtf)}`,
        );
      } else {
        console.log(`  [${tag}] ERROR - ${trunc(entry.error || '', 140)}`);
      }
    }
  }

  if (result.runs.length > 0 && result.runs.every((entry) => entry.status === 'error')) {
    result.status = 'failed';
    result.connectionError = result.runs[result.runs.length - 1].error;
  }

  return result;
}

async function runRestOne(
  model: string,
  voice: string | null,
  sentenceNo: number,
  runNo: number,
  sentence: string,
  timeoutMs: number,
  apiKey: string,
): Promise<TtsRunEntry> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();

  try {
    const response = await fetch(REST_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: sentence,
        voice,
        response_format: 'raw',
        sample_rate: SAMPLE_RATE,
        stream: false,
      }),
    });
    const firstAudioAt = performance.now();

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return makeFailedRun(
        sentenceNo,
        runNo,
        `HTTP ${response.status}: ${trunc(detail.replace(/\s+/g, ' '), 220)}`,
      );
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const doneAt = performance.now();
    const doneMs = doneAt - started;
    const audioSeconds = bytes.length / BYTES_PER_SAMPLE / SAMPLE_RATE;
    return {
      sentenceNo,
      runNo,
      sentence,
      status: 'ok',
      error: null,
      firstAudioMs: firstAudioAt - started,
      doneMs,
      audioSeconds,
      rtf: doneMs > 0 ? audioSeconds / (doneMs / 1000) : null,
      audioBytes: bytes.length,
      deltaCount: 1,
      doneCount: 1,
    };
  } catch (e) {
    const message =
      e instanceof Error && e.name === 'AbortError'
        ? `Timeout after ${timeoutMs} ms`
        : errorString(e);
    return makeFailedRun(sentenceNo, runNo, message);
  } finally {
    clearTimeout(timeout);
  }
}

function fillFailedRuns(result: ModelResult, runs: number, error: string) {
  for (let s = 0; s < SENTENCES.length; s += 1) {
    for (let r = 1; r <= runs; r += 1) {
      result.runs.push(makeFailedRun(s + 1, r, error));
    }
  }
}

function makeFailedRun(sentenceNo: number, runNo: number, error: string): TtsRunEntry {
  return {
    model: undefined,
    sentenceNo,
    runNo,
    status: 'error',
    error,
    firstAudioMs: null,
    doneMs: null,
    audioSeconds: null,
    rtf: null,
    audioBytes: 0,
    deltaCount: 0,
    doneCount: 0,
  };
}

// Drive a single (sentence, run) on the shared socket. runState is held in the
// caller via get/set accessors so the socket-level message handler can mutate it.
async function runOne(
  ws: WebSocket,
  sentenceNo: number,
  runNo: number,
  sentence: string,
  timeoutMs: number,
  setRunState: (state: ActiveRunState) => void,
): Promise<TtsRunEntry> {
  if (ws.readyState !== WebSocket.OPEN) {
    return makeFailedRun(sentenceNo, runNo, 'Socket not open');
  }

  const state: ActiveRunState = {
    sentenceNo,
    runNo,
    sentence,
    status: 'error',
    error: null,
    commitAt: 0,
    firstAudioAt: null,
    firstDoneAt: null,
    lastDoneAt: null,
    doneAt: null,
    audioBytes: 0,
    deltaCount: 0,
    doneCount: 0,
    lastActivityAt: 0,
    settled: false,
  };
  setRunState(state);

  try {
    ws.send(JSON.stringify({ type: 'input_text_buffer.append', text: sentence }));
  } catch (e) {
    state.error = `append send failed: ${errorString(e)}`;
    state.settled = true;
    state.doneAt = performance.now();
    return finalize(state);
  }

  state.commitAt = performance.now();
  state.lastActivityAt = state.commitAt;

  try {
    ws.send(JSON.stringify({ type: 'input_text_buffer.commit' }));
  } catch (e) {
    state.error = `commit send failed: ${errorString(e)}`;
    state.settled = true;
    state.doneAt = performance.now();
    return finalize(state);
  }

  // Wait until the run settles: a tts.failed, a socket close, the quiet period
  // after the last audio_output.done, or the per-run timeout.
  await new Promise<void>((resolve) => {
    const deadline = state.commitAt + timeoutMs;
    const tick = () => {
      if (state.settled) return resolve();
      const now = performance.now();
      if (now >= deadline) {
        state.error = `Timeout after ${timeoutMs} ms`;
        state.settled = true;
        state.doneAt = now;
        return resolve();
      }
      if (
        state.doneCount >= 1 &&
        now - state.lastActivityAt >= QUIET_GRACE_MS
      ) {
        state.settled = true;
        state.doneAt = now;
        return resolve();
      }
      setImmediate(tick);
    };
    tick();
  });

  return finalize(state);
}

function finalize(state: ActiveRunState): TtsRunEntry {
  const out: TtsRunEntry = {
    sentenceNo: state.sentenceNo,
    runNo: state.runNo,
    sentence: state.sentence,
    status: state.error ? 'error' : 'ok',
    error: state.error,
    firstAudioMs: null,
    doneMs: null,
    audioSeconds: null,
    rtf: null,
    audioBytes: state.audioBytes,
    deltaCount: state.deltaCount,
    doneCount: state.doneCount,
  };
  if (state.error) return out;

  out.firstAudioMs =
    state.firstAudioAt != null ? state.firstAudioAt - state.commitAt : null;
  out.doneMs =
    state.lastDoneAt != null ? state.lastDoneAt - state.commitAt : null;
  out.audioSeconds = state.audioBytes / BYTES_PER_SAMPLE / SAMPLE_RATE;
  if (out.doneMs != null && out.doneMs > 0) {
    out.rtf = out.audioSeconds / (out.doneMs / 1000);
  }
  return out;
}

// ---------- aggregation / reporting ----------

function summarize(modelResult: ModelResult): ModelSummary {
  const ok = modelResult.runs.filter((r) => r.status === 'ok');
  const errs = modelResult.runs.filter((r) => r.status === 'error');
  const firstAudio = ok
    .map((r) => r.firstAudioMs)
    .filter((v): v is number => v != null);
  const done = ok.map((r) => r.doneMs).filter((v): v is number => v != null);
  const audio = ok.map((r) => r.audioSeconds).filter((v): v is number => v != null);
  const rtf = ok.map((r) => r.rtf).filter((v): v is number => v != null);
  return {
    model: modelResult.model,
    voice: modelResult.voice,
    delivery: modelResult.delivery,
    status: modelResult.status,
    sessionMs: modelResult.sessionMs,
    runs: modelResult.runs.length,
    ok: ok.length,
    errors: errs.length,
    medianFirstAudioMs: median(firstAudio),
    medianDoneMs: median(done),
    medianAudioSeconds: median(audio),
    medianRtf: median(rtf),
    connectionError: modelResult.connectionError,
    lastError: errs.length ? errs[errs.length - 1].error : null,
  };
}

function printModelTable(modelResult: ModelResult) {
  const cols = ['#', 'run', 'firstAudioMs', 'doneMs', 'audioSec', 'rtf'];
  const rows = modelResult.runs.map((r) => [
    String(r.sentenceNo),
    String(r.runNo),
    r.status === 'ok' ? fmtMs(r.firstAudioMs) : 'ERR',
    r.status === 'ok' ? fmtMs(r.doneMs) : '-',
    r.status === 'ok' ? fmt3(r.audioSeconds) : '-',
    r.status === 'ok' ? fmt3(r.rtf) : '-',
  ]);
  const widths = cols.map((c, i) =>
    Math.max(c.length, ...rows.map((r) => r[i].length)),
  );
  const pad = (cells: string[]) =>
    cells.map((c, i) => String(c).padEnd(widths[i], ' ')).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  console.log(pad(cols));
  console.log(sep);
  for (const r of rows) console.log(pad(r));
  for (const r of modelResult.runs.filter((x) => x.status === 'error')) {
    console.log(`  ! s${r.sentenceNo}r${r.runNo}: ${trunc(r.error || '', 140)}`);
  }
}

function printSummaryTable(summaries: ModelSummary[]) {
  const cols = ['Model', 'Delivery', 'Voice', 'OK', 'sessionMs', 'firstAudio(ms)', 'done(ms)', 'audio(s)', 'rtf'];
  const data = summaries.map((s) => [
    trunc(s.model, 34),
    s.delivery,
    s.voice ?? '(default)',
    `${s.ok}/${s.runs}`,
    s.status === 'failed' ? 'FAIL' : fmtMs(s.sessionMs),
    s.ok > 0 ? fmtMs(s.medianFirstAudioMs) : '-',
    s.ok > 0 ? fmtMs(s.medianDoneMs) : '-',
    s.ok > 0 ? fmt3(s.medianAudioSeconds) : '-',
    s.ok > 0 ? fmt3(s.medianRtf) : '-',
  ]);
  const widths = cols.map((c, i) =>
    Math.max(c.length, ...data.map((r) => r[i].length)),
  );
  const pad = (cells: string[]) =>
    cells.map((c, i) => String(c).padEnd(widths[i], ' ')).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  console.log(pad(cols));
  console.log(sep);
  for (const r of data) console.log(pad(r));
  for (const s of summaries.filter((x) => x.status === 'failed' || x.errors > 0)) {
    const cause = s.status === 'failed' ? s.connectionError : s.lastError;
    console.log(`  ! ${s.model}: ${s.errors}/${s.runs} runs failed - ${trunc(cause || '', 140)}`);
  }
}

// ---------- main ----------

async function main() {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    printHelp();
    process.exit(2);
  }
  if (args.help) {
    printHelp();
    return;
  }

  if (!Number.isFinite(args.runs) || args.runs < 1) args.runs = 1;
  if (!Number.isFinite(args.timeout) || args.timeout < 1000) {
    args.timeout = DEFAULT_RUN_TIMEOUT_MS;
  }

  // Model list precedence: --models > TTS_BENCH_MODELS > built-in default.
  let models = args.models && args.models.length ? args.models : null;
  if (!models && process.env.TTS_BENCH_MODELS) {
    models = process.env.TTS_BENCH_MODELS
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (!models || !models.length) models = DEFAULT_MODELS;

  if (!process.env.TOGETHER_API_KEY) {
    loadDotEnv(path.join(process.cwd(), '.env'));
  }
  const apiKey = process.env.TOGETHER_API_KEY;
  if (!apiKey) {
    console.error('TOGETHER_API_KEY is not set. Export it or put it in ./.env .');
    process.exit(1);
  }

  console.log('Together TTS latency benchmark');
  console.log('─'.repeat(53));
  console.log(`Models      : ${models.length} (${models.join(', ')})`);
  console.log(`Sentences   : ${SENTENCES.length}`);
  console.log(`Runs        : ${args.runs} per (model, sentence)`);
  console.log(`Timeout     : ${args.timeout} ms per run`);
  console.log(`Endpoints   : ${WS_ENDPOINT} / ${REST_ENDPOINT}`);
  console.log(`Total runs  : ${models.length * SENTENCES.length * args.runs}`);
  console.log('─'.repeat(53));

  const startedAt = Date.now();
  const modelResults: ModelResult[] = [];
  for (const model of models) {
    console.log(`\nModel: ${model}`);
    const res = await runModel(model, args.runs, args.timeout, apiKey);
    modelResults.push(res);
    if (res.status === 'failed') {
      console.log(`  MODEL FAILED - ${trunc(res.connectionError || '', 200)}`);
    }
    printModelTable(res);
  }

  const summaries = modelResults.map(summarize);

  console.log('\nSummary (median across successful runs)');
  console.log('─'.repeat(53));
  printSummaryTable(summaries);

  const failedModels = summaries.filter((s) => s.status === 'failed');
  if (failedModels.length) {
    console.log('\nFully failed models (could not establish a TTS session):');
    for (const s of failedModels) {
      console.log(`  - ${s.model}: ${trunc(s.connectionError || '', 200)}`);
    }
  }

  if (!args.noJson) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(args.outDir, `together-tts-${stamp}.json`);
    try {
      fs.mkdirSync(args.outDir, { recursive: true });
      const payload = {
        meta: {
          timestamp: new Date().toISOString(),
          startedAt: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
          endpoint: WS_ENDPOINT,
          models,
          runs: args.runs,
          timeoutMs: args.timeout,
          sampleRate: SAMPLE_RATE,
          bytesPerSample: BYTES_PER_SAMPLE,
          quietGraceMs: QUIET_GRACE_MS,
          sentences: SENTENCES,
        },
        models: modelResults.map((mr) => ({
          ...mr,
          runs: mr.runs.map((r) => ({
            ...r,
            // The shared socket carries the model; keep the run entry
            // self-describing by stamping the model name here.
            model: mr.model,
          })),
          summary: summarize(mr),
        })),
      };
      fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
      console.log(`\nJSON written: ${file}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`\nFailed to write JSON: ${message}`);
    }
  }

  const totalOk = summaries.reduce((s, m) => s + m.ok, 0);
  const totalErr = summaries.reduce((s, m) => s + m.errors, 0);
  console.log(
    `\nDone: ${totalOk} ok / ${totalErr} errors across ${summaries.length} models ` +
      `(${failedModels.length} fully failed) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`Fatal: ${e instanceof Error ? e.stack || e.message : String(e)}`);
    process.exit(1);
  });
