#!/usr/bin/env node
// scripts/benchmark-together-tts.mjs
//
// Standalone realtime text-to-speech latency benchmark for Together AI
// websocket TTS models. Measures time-to-first-audio per model/voice by
// streaming text into a single persistent TTS websocket per model (mirroring
// how app/api/voice/route.ts keeps one TTS socket per voice session).
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
//   TOGETHER_API_KEY=... node scripts/benchmark-together-tts.mjs
//   node scripts/benchmark-together-tts.mjs --models "hexgrad/Kokoro-82M,cartesia/sonic-english" --runs 3
//   TTS_BENCH_MODELS="hexgrad/Kokoro-82M" node scripts/benchmark-together-tts.mjs --runs 5
//
// Reads TOGETHER_API_KEY from process.env. Also tries to load ./.env when the
// key is not already exported, so the project's gitignored .env works out of
// the box. The model list is taken from --models, else TTS_BENCH_MODELS, else
// the built-in default pair.

import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

// ---------- constants ----------

const WS_ENDPOINT = 'wss://api.together.ai/v1/audio/speech/websocket';

// Default Together realtime TTS websocket models (override with --models or
// TTS_BENCH_MODELS). hexgrad/Kokoro-82M always emits 24 kHz s16le PCM.
const DEFAULT_MODELS = ['hexgrad/Kokoro-82M', 'cartesia/sonic-english'];

// Default voice per model. The TTS overview docs do not state a default voice
// for cartesia/sonic-english ("All valid voices supported by Cartesia are
// supported" / "pass in the voice ID instead of the name"), so for that model
// we omit the voice query param and let the server default apply. af_heart is
// the documented Kokoro voice used in app/api/voice/route.ts.
const KOKORO_MODEL = 'hexgrad/Kokoro-82M';
const KOKORO_VOICE = 'af_heart';

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

function loadDotEnv(file) {
  let text;
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

function parseArgs(argv) {
  const a = {
    models: null,
    runs: 3,
    timeout: DEFAULT_RUN_TIMEOUT_MS,
    outDir: 'bench-results',
    noJson: false,
    help: false,
  };
  const rest = [...argv];
  const need = (name) => {
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
  console.log(`benchmark-together-tts.mjs - Together realtime TTS websocket latency benchmark

Usage:
  node scripts/benchmark-together-tts.mjs [options]

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
  Opens ONE websocket per model and reuses it across every (sentence, run) for
  that model, sending input_text_buffer.append + input_text_buffer.commit and
  waiting for conversation.item.audio_output.done before the next commit. Voices:
  af_heart for hexgrad/Kokoro-82M; for cartesia/sonic-english the docs state no
  default voice, so the voice param is omitted and the server default applies.
  tts.failed / socket errors are recorded per-run and never abort the run; a
  model whose socket cannot open is marked failed and the benchmark continues.
  Exit code is 0 as long as the benchmark completes, even with failed models.
`);
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const fmtMs = (v) => (v == null ? '-' : Math.round(v).toLocaleString('en-US'));
const fmt2 = (v) => (v == null ? '-' : v.toFixed(2));
const fmt3 = (v) => (v == null ? '-' : v.toFixed(3));

function trunc(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function errorString(e) {
  if (e == null) return 'Unknown error';
  if (typeof e === 'string') return e;
  if (e.message) return `${e.name || 'Error'}: ${e.message}`;
  return String(e);
}

// Build the websocket URL for a model. Kokoro gets voice=af_heart; for every
// other model (incl. cartesia/sonic-english, whose docs state no default voice)
// the voice param is omitted so the server applies its own default.
function buildUrl(model) {
  const url = new URL(WS_ENDPOINT);
  url.searchParams.set('model', model);
  if (model === KOKORO_MODEL) {
    url.searchParams.set('voice', KOKORO_VOICE);
  }
  url.searchParams.set('response_format', 'pcm');
  url.searchParams.set('sample_rate', String(SAMPLE_RATE));
  url.searchParams.set('segment', 'sentence');
  return url.toString();
}

function voiceFor(model) {
  return model === KOKORO_MODEL ? KOKORO_VOICE : null;
}

// ---------- per-model runner ----------

// Open and run the full (sentence x runs) matrix for one model on a single
// shared websocket. Resolves to a model result object; never throws.
async function runModel(model, runs, timeoutMs, apiKey) {
  const result = {
    model,
    voice: voiceFor(model),
    url: buildUrl(model),
    sessionMs: null,
    status: 'ok',
    connectionError: null,
    runs: [], // per (sentence, run) entries
  };

  const connectStart = performance.now();
  let ws;
  try {
    ws = new WebSocket(result.url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (e) {
    result.status = 'failed';
    result.connectionError = `WebSocket init failed: ${errorString(e)}`;
    return result;
  }

  // session.created fence. The socket is shared, so the message handler stays
  // attached for the whole run; runState points at the active run (or null
  // between runs) so the same handler routes every message.
  let sessionReady = false;
  let sessionError = null;
  let runState = null;

  const handleFatal = (msg) => {
    if (!sessionReady) {
      sessionError = msg;
    } else if (runState && !runState.settled) {
      runState.error = msg;
      runState.settled = true;
      runState.doneAt = performance.now();
    }
  };

  ws.on('message', (data) => {
    let message;
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
  const sessionOk = await new Promise((resolve) => {
    const settled = () => resolve(sessionReady);
    if (sessionReady || sessionError) return settled();
    let done = false;
    const finish = (val) => {
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
      const entry = await runOne(ws, s + 1, r, sentence, timeoutMs, () => runState, (st) => {
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

function makeFailedRun(sentenceNo, runNo, error) {
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
async function runOne(ws, sentenceNo, runNo, sentence, timeoutMs, getRunState, setRunState) {
  if (ws.readyState !== WebSocket.OPEN) {
    return makeFailedRun(sentenceNo, runNo, 'Socket not open');
  }

  const state = {
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
  await new Promise((resolve) => {
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

function finalize(state) {
  const out = {
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

function summarize(modelResult) {
  const ok = modelResult.runs.filter((r) => r.status === 'ok');
  const errs = modelResult.runs.filter((r) => r.status === 'error');
  const firstAudio = ok
    .map((r) => r.firstAudioMs)
    .filter((v) => v != null);
  const done = ok.map((r) => r.doneMs).filter((v) => v != null);
  const audio = ok.map((r) => r.audioSeconds).filter((v) => v != null);
  const rtf = ok.map((r) => r.rtf).filter((v) => v != null);
  return {
    model: modelResult.model,
    voice: modelResult.voice,
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

function printModelTable(modelResult) {
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
  const pad = (cells) =>
    cells.map((c, i) => String(c).padEnd(widths[i], ' ')).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  console.log(pad(cols));
  console.log(sep);
  for (const r of rows) console.log(pad(r));
  for (const r of modelResult.runs.filter((x) => x.status === 'error')) {
    console.log(`  ! s${r.sentenceNo}r${r.runNo}: ${trunc(r.error || '', 140)}`);
  }
}

function printSummaryTable(summaries) {
  const cols = ['Model', 'Voice', 'OK', 'sessionMs', 'firstAudio(ms)', 'done(ms)', 'audio(s)', 'rtf'];
  const data = summaries.map((s) => [
    trunc(s.model, 34),
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
  const pad = (cells) =>
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
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
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

  console.log('Together realtime TTS websocket benchmark');
  console.log('─'.repeat(53));
  console.log(`Models      : ${models.length} (${models.join(', ')})`);
  console.log(`Sentences   : ${SENTENCES.length}`);
  console.log(`Runs        : ${args.runs} per (model, sentence)`);
  console.log(`Timeout     : ${args.timeout} ms per run`);
  console.log(`Endpoint    : ${WS_ENDPOINT}`);
  console.log(`Total runs  : ${models.length * SENTENCES.length * args.runs}`);
  console.log('─'.repeat(53));

  const startedAt = Date.now();
  const modelResults = [];
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
      console.error(`\nFailed to write JSON: ${e.message}`);
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
    console.error(`Fatal: ${e?.stack || e}`);
    process.exit(1);
  });