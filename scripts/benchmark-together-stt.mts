#!/usr/bin/env node
// scripts/benchmark-together-stt.mts
//
// Realtime speech-to-text latency + accuracy benchmark for Together realtime
// transcription models over the WebSocket API
// (wss://api.together.ai/v1/realtime?intent=transcription&model=...).
//
//   * Synthesizes short multilingual utterances once via Together REST TTS
//     using language-matched voices, resamples 24 kHz -> 16 kHz with linear
//     interpolation, and saves them as test-fixtures/stt-bench-<language>-<index>.pcm
//     plus playable .wav sidecars (skipped if the file and sidecar metadata
//     already match).
//   * For every model x fixture x run, opens a transcription websocket with
//     turn_detection=none, streams the fixture as 80 ms (2560-byte) base64 s16le
//     chunks paced in real time, then sends input_audio_buffer.commit and
//     measures commit -> conversation.item.input_audio_transcription.completed
//     latency (commitToFinalMs) plus time-to-first-delta (firstDeltaMs, may be
//     null with turn_detection=none) and the per-run transcript.
//   * Computes WER or CER against the known ground truth with an in-script
//     Levenshtein implementation. WER uses Unicode-aware word normalization for
//     whitespace-delimited languages; CER is used for Japanese.
//   * Per-connection hard timeout: 30 s. Any run failure (socket error,
//     timeout, transcription.failed, or a generic {type:'error'} event) is
//     recorded and the benchmark continues with the next run; nothing aborts
//     the whole benchmark. The socket is closed cleanly after each run.
//   * Prints per-model aligned column tables (per run + a summary line) and a
//     final cross-model summary table, then writes full JSON results to
//     bench-results/together-stt-<timestamp>.json (ISO timestamp with ':' and
//     '.' replaced by '-'), same meta style as benchmark-together-chat.mjs.
//
// Only external dependency is 'ws' (already installed). Everything else is a
// node: builtin. Requires Node 20+ (global fetch, performance, Buffer, ws).
//
// Usage:
//   TOGETHER_API_KEY=... bun scripts/benchmark-together-stt.mts
//   bun scripts/benchmark-together-stt.mts --models "openai/whisper-large-v3" --runs 3
//   STT_BENCH_MODELS="a,b" bun scripts/benchmark-together-stt.mts --runs 5
//
// Reads TOGETHER_API_KEY from process.env. Also tries to load ./.env when the
// key is not already exported, so the project's gitignored .env works out of
// the box. Models default to Together's current serverless transcribe catalog; override with
// --models (wins) or the STT_BENCH_MODELS env var (comma-separated).

import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

type CliArgs = {
  models: string[] | null;
  languages: string[] | null;
  runs: number;
  help: boolean;
};

type ScoringMetric = 'wer' | 'cer';

type TtsConfig = {
  model: string;
  voice: string;
  sampleRate: number;
};

type FixtureDefinition = {
  name: string;
  language: string;
  scoring: ScoringMetric;
  text: string;
};

type PreparedFixture = FixtureDefinition & {
  index: number;
  path: string;
  bytes: number;
  chunks: string[];
};

type RunStatus = 'ok' | 'error';

type RunState = {
  finished: boolean;
  status: RunStatus;
  error: string | null;
  transcript: string;
  tStreamStart: number | null;
  tCommit: number | null;
  tFirstDelta: number | null;
  tFinal: number | null;
};

type RunResult = {
  model: string;
  fixtureIndex: number;
  fixture: string;
  language: string;
  groundTruth: string;
  run: number;
  status: RunStatus;
  commitToFinalMs: number | null;
  firstDeltaMs: number | null;
  transcript: string;
  metric: ScoringMetric;
  errorRate: number | null;
  error: string | null;
  totalElapsedMs: number;
};

type ModelSummary = {
  model: string;
  runs: number;
  ok: number;
  errors: number;
  medianCommitToFinalMs: number | null;
  meanErrorRate: number | null;
  lastError: string | null;
  runsData: RunResult[];
};

// ---------- constants ----------

// Together serverless transcribe catalog, verified against /v1/models on
// 2026-07-08. Override with --models / STT_BENCH_MODELS for ad hoc tests.
const DEFAULT_MODELS = [
  'openai/whisper-large-v3',
  'nvidia/parakeet-tdt-0.6b-v3',
  'nvidia/nemotron-3.5-asr-streaming-0.6b',
  'nvidia/nemotron-3-asr-streaming-0.6b',
];

const WS_BASE = 'wss://api.together.ai/v1/realtime';
const INTENT = 'transcription';
const INPUT_AUDIO_FORMAT = 'pcm_s16le_16000';
const TURN_DETECTION = 'none';

const CONN_TIMEOUT_MS = 30_000; // per-connection overall timeout

// Together REST TTS, used to synthesize fixtures. We use language-matched voices
// where Together exposes them so the STT benchmark is not polluted by an
// English TTS voice trying to pronounce other languages.
const TTS_ENDPOINT = 'https://api.together.ai/v1/audio/speech';
const TTS_SYNTH_SAMPLE_RATE = 24000;
const FIXTURE_SAMPLE_RATE = 16000;

const TTS_BY_LANGUAGE: Record<string, TtsConfig> = {
  en: { model: 'hexgrad/Kokoro-82M', voice: 'af_heart', sampleRate: TTS_SYNTH_SAMPLE_RATE },
  es: { model: 'hexgrad/Kokoro-82M', voice: 'ef_dora', sampleRate: TTS_SYNTH_SAMPLE_RATE },
  fr: { model: 'hexgrad/Kokoro-82M', voice: 'ff_siwis', sampleRate: TTS_SYNTH_SAMPLE_RATE },
  it: { model: 'hexgrad/Kokoro-82M', voice: 'if_sara', sampleRate: TTS_SYNTH_SAMPLE_RATE },
  ja: { model: 'hexgrad/Kokoro-82M', voice: 'jf_alpha', sampleRate: TTS_SYNTH_SAMPLE_RATE },
};

// 80 ms of audio at 16 kHz, 16-bit = 16000 * 2 * 0.08 = 2560 bytes.
const CHUNK_BYTES = 2560;
const CHUNK_INTERVAL_MS = 80; // stream chunks in real time

const OUT_DIR = 'bench-results';

// Short utterances with known ground-truth text. The fixture names are stable so
// generated audio is reused between runs.
const FIXTURES: FixtureDefinition[] = [
  {
    name: 'stt-bench-en-1.pcm',
    language: 'en',
    scoring: 'wer',
    text: 'Hello! How are you doing today?',
  },
  {
    name: 'stt-bench-en-2.pcm',
    language: 'en',
    scoring: 'wer',
    text: 'What is the fastest open source language model right now?',
  },
  {
    name: 'stt-bench-es-1.pcm',
    language: 'es',
    scoring: 'wer',
    text: '¿Hola, puedes decirme qué tiempo hace hoy en Madrid?',
  },
  {
    name: 'stt-bench-es-2.pcm',
    language: 'es',
    scoring: 'wer',
    text: 'Quisiera reservar una mesa para dos personas esta noche.',
  },
  {
    name: 'stt-bench-fr-1.pcm',
    language: 'fr',
    scoring: 'wer',
    text: "Bonjour, peux-tu me donner la météo pour Paris aujourd'hui ?",
  },
  {
    name: 'stt-bench-fr-2.pcm',
    language: 'fr',
    scoring: 'wer',
    text: 'Je voudrais réserver une table pour deux personnes ce soir.',
  },
  {
    name: 'stt-bench-it-1.pcm',
    language: 'it',
    scoring: 'wer',
    text: 'Ciao, puoi dirmi che tempo fa a Roma oggi?',
  },
  {
    name: 'stt-bench-it-2.pcm',
    language: 'it',
    scoring: 'wer',
    text: 'Vorrei prenotare un tavolo per due persone stasera.',
  },
  {
    name: 'stt-bench-ja-1.pcm',
    language: 'ja',
    scoring: 'cer',
    text: 'こんにちは、今日の東京の天気を教えてください。',
  },
  {
    name: 'stt-bench-ja-2.pcm',
    language: 'ja',
    scoring: 'cer',
    text: '今夜二人分の席を予約したいです。',
  },
];

// ---------- dotenv loader (matches scripts/benchmark-together-chat.mjs) ----------

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

// ---------- CLI ----------

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { models: null, languages: null, runs: 3, help: false };
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
      case '--languages':
        a.languages = need('--languages')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        break;
      case '--runs':
        a.runs = parseInt(need('--runs'), 10);
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
  console.log(`benchmark-together-stt.mts - Together realtime STT latency + accuracy benchmark

Usage:
  bun scripts/benchmark-together-stt.mts [options]

Options:
  --models "a,b,c"   Comma-separated realtime transcription model ids to benchmark
                     (default: ${DEFAULT_MODELS.join(',')}). Also set via the
                     STT_BENCH_MODELS env var; --models wins.
  --languages "it,fr" Comma-separated fixture language codes to run
                     (default: en,fr,it,ja). Also set via the
                     STT_BENCH_LANGUAGES env var; --languages wins.
  --runs N           Repetitions per model x fixture (default 3)
  -h, --help         Show this help

Env:
  TOGETHER_API_KEY   Required. Also auto-loaded from ./.env if not exported.
  STT_BENCH_MODELS   Comma-separated model ids (used only if --models is not given).
  STT_BENCH_LANGUAGES Comma-separated fixture language codes (used only if
                      --languages is not given).

Notes:
  Streams each fixture as 80 ms (2560-byte) base64 s16le chunks at real-time
  pace over a transcription websocket with turn_detection=none, then commits.
  Measures commit -> transcription.completed latency and transcript error vs
  the known ground truth. Per-connection timeout is 30 s. Run failures are
  recorded and never abort the whole benchmark. JSON results go to
  ${OUT_DIR}/together-stt-<timestamp>.json.
`);
}

// ---------- formatting helpers (aligned-column style of the chat benchmark) ----------

function median(arr: number[]) {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(arr: number[]) {
  if (!arr.length) return null;
  return arr.reduce((x, y) => x + y, 0) / arr.length;
}

const fmtMs = (v: number | null) => (v == null ? '-' : Math.round(v).toLocaleString('en-US'));
const fmtPct = (v: number | null) => (v == null ? '-' : `${(v * 100).toFixed(1)}%`);

function trunc(s: unknown, n: number): string {
  const text = String(s ?? '');
  return text.length <= n ? text : text.slice(0, n - 1) + '…';
}

function printRunsTable(rows: RunResult[]) {
  const cols = ['lang', 'fixture', 'run', 'commitToFinalMs', 'metric', 'error', 'transcript'];
  const data = rows.map((r) => [
    r.language,
    r.fixture,
    String(r.run),
    r.status === 'ok' ? fmtMs(r.commitToFinalMs) : 'ERR',
    r.metric.toUpperCase(),
    r.status === 'ok' && r.errorRate != null ? fmtPct(r.errorRate) : '-',
    r.status === 'ok' ? trunc(r.transcript || '', 60) : trunc(r.error || 'error', 60),
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
}

function printSummaryTable(summaries: ModelSummary[]) {
  const cols = ['Model', 'OK', 'Median commitToFinal(ms)', 'Mean error'];
  const data = summaries.map((s) => [
    trunc(s.model, 46),
    `${s.ok}/${s.runs}`,
    s.ok > 0 ? fmtMs(s.medianCommitToFinalMs) : 'ERR',
    s.ok > 0 ? fmtPct(s.meanErrorRate) : '-',
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
  for (const s of summaries.filter((x) => x.errors > 0)) {
    console.log(`  ! ${s.model}: ${s.errors}/${s.runs} failed - ${trunc(s.lastError || '', 120)}`);
  }
}

// ---------- transcript scoring ----------

function normalizeComparableText(text: unknown): string {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLowerCase();
}

// Unicode-aware word tokens for whitespace-delimited languages.
function normalizeWords(text: unknown): string[] {
  const s = normalizeComparableText(text)
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length ? s.split(' ') : [];
}

// Character tokens for languages where whitespace does not mark word
// boundaries reliably, such as Japanese.
function normalizeCharacters(text: unknown): string[] {
  const s = normalizeComparableText(text).replace(/[^\p{Letter}\p{Number}]/gu, '');
  return Array.from(s);
}

// Levenshtein distance between two token arrays (two rolling rows).
function levenshtein(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

// Error rate = token-level edit distance / reference token count. Returns null
// when the reference has no tokens (would divide by zero).
function computeErrorRate(
  reference: string,
  hypothesis: string,
  metric: ScoringMetric,
): number | null {
  const ref = metric === 'cer' ? normalizeCharacters(reference) : normalizeWords(reference);
  const hyp = metric === 'cer' ? normalizeCharacters(hypothesis) : normalizeWords(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : null;
  return levenshtein(ref, hyp) / ref.length;
}

// ---------- fixture synthesis ----------

function ttsConfigFor(language: string): TtsConfig {
  const config = TTS_BY_LANGUAGE[language];
  if (!config) throw new Error(`No TTS config for fixture language "${language}"`);
  return config;
}

function readFixtureMeta(metaPath: string) {
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function fixtureMetaMatches(
  fixture: FixtureDefinition,
  config: TtsConfig,
  meta: Record<string, unknown> | null,
) {
  return (
    meta?.text === fixture.text &&
    meta?.language === fixture.language &&
    meta?.scoring === fixture.scoring &&
    meta?.ttsModel === config.model &&
    meta?.ttsVoice === config.voice &&
    meta?.ttsSampleRate === config.sampleRate &&
    meta?.fixtureSampleRate === FIXTURE_SAMPLE_RATE
  );
}

function wavPathForPcm(pcmPath: string) {
  return pcmPath.endsWith('.pcm') ? `${pcmPath.slice(0, -4)}.wav` : `${pcmPath}.wav`;
}

function buildPcm16MonoWav(pcm: Buffer, sampleRate: number) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function writePlayableWav(pcmPath: string, pcm: Buffer) {
  fs.writeFileSync(wavPathForPcm(pcmPath), buildPcm16MonoWav(pcm, FIXTURE_SAMPLE_RATE));
}

// Synthesize one 16 kHz s16le mono PCM fixture via Together REST TTS, skipping
// if the file and metadata already match. The API returns 24 kHz s16le mono PCM
// for the fixture models configured here, so we request 24000 and resample the
// response down to 16 kHz with linear interpolation. The resample block below is
// duplicated from ensureFixture() in scripts/e2e-voice-latency.mjs.
async function ensureFixture(fixture: FixtureDefinition, apiKey: string) {
  const fixturePath = path.join('test-fixtures', fixture.name);
  const metaPath = `${fixturePath}.json`;
  const config = ttsConfigFor(fixture.language);
  if (fs.existsSync(fixturePath) && fixtureMetaMatches(fixture, config, readFixtureMeta(metaPath))) {
    const wavPath = wavPathForPcm(fixturePath);
    if (!fs.existsSync(wavPath)) writePlayableWav(fixturePath, fs.readFileSync(fixturePath));
    return;
  }

  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });

  const res = await fetch(TTS_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      input: fixture.text,
      voice: config.voice,
      response_format: 'raw',
      sample_rate: config.sampleRate,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `TTS synthesis failed for ${fixture.name} (HTTP ${res.status}): ${detail.slice(0, 300)}`,
    );
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error(`TTS synthesis returned no audio bytes for ${fixture.name}`);

  // ---- duplicated resample code (24 kHz s16le -> 16 kHz s16le) ----
  const inputSamples = Math.floor(bytes.length / 2);
  const input = new Float32Array(inputSamples);
  for (let i = 0; i < inputSamples; i += 1) {
    input[i] = bytes.readInt16LE(i * 2) / 32768;
  }

  const ratio = config.sampleRate / FIXTURE_SAMPLE_RATE; // 1.5 for 24 kHz -> 16 kHz
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const resampled = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const before = Math.floor(position);
    const after = Math.min(before + 1, input.length - 1);
    const weight = position - before;
    resampled[i] = input[before] * (1 - weight) + input[after] * weight;
  }

  const pcm16 = Buffer.alloc(outputLength * 2);
  for (let i = 0; i < outputLength; i += 1) {
    const sample = Math.max(-1, Math.min(1, resampled[i]));
    const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    pcm16.writeInt16LE(value, i * 2);
  }
  // ---- end duplicated resample code ----

  fs.writeFileSync(fixturePath, pcm16);
  writePlayableWav(fixturePath, pcm16);
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        text: fixture.text,
        language: fixture.language,
        scoring: fixture.scoring,
        ttsModel: config.model,
        ttsVoice: config.voice,
        ttsSampleRate: config.sampleRate,
        fixtureSampleRate: FIXTURE_SAMPLE_RATE,
        playablePath: wavPathForPcm(fixturePath),
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `Synthesized fixture: ${fixturePath} (${fixture.language}, ${config.model}/${config.voice}, ` +
      `${bytes.length} bytes -> resampled ${pcm16.length} bytes @ ${FIXTURE_SAMPLE_RATE} Hz)`,
  );
}

// Split the 16 kHz s16le fixture buffer into 80 ms (2560-byte) base64 chunks.
function buildChunks(pcmBuffer: Buffer) {
  const chunks: string[] = [];
  for (let off = 0; off < pcmBuffer.length; off += CHUNK_BYTES) {
    const end = Math.min(off + CHUNK_BYTES, pcmBuffer.length);
    chunks.push(pcmBuffer.subarray(off, end).toString('base64'));
  }
  return chunks;
}

// ---------- per-run websocket turn ----------

function buildResult(
  model: string,
  fixture: PreparedFixture,
  fixtureIndex: number,
  runIndex: number,
  state: RunState,
  runStart: number,
): RunResult {
  const totalElapsedMs = performance.now() - runStart;
  const commitToFinalMs =
    state.tFinal != null && state.tCommit != null ? state.tFinal - state.tCommit : null;
  const firstDeltaMs =
    state.tFirstDelta != null && state.tStreamStart != null
      ? state.tFirstDelta - state.tStreamStart
      : null;
  const status = state.status;
  const transcript = state.transcript || '';
  const errorRate =
    status === 'ok' ? computeErrorRate(fixture.text, transcript, fixture.scoring) : null;
  return {
    model,
    fixtureIndex,
    fixture: fixture.name,
    language: fixture.language,
    groundTruth: fixture.text,
    run: runIndex,
    status,
    commitToFinalMs,
    firstDeltaMs,
    transcript,
    metric: fixture.scoring,
    errorRate,
    error: status === 'error' ? state.error || 'unknown error' : null,
    totalElapsedMs,
  };
}

// Open a transcription websocket, stream the fixture, commit, and resolve with
// a result object. Any failure (socket error, 30 s timeout, transcription.failed,
// generic {type:'error'}) is captured as status:'error' and the benchmark
// continues; the socket is closed cleanly before resolving.
function runOne(
  model: string,
  fixture: PreparedFixture,
  fixtureIndex: number,
  runIndex: number,
  apiKey: string,
) {
  return new Promise<RunResult>((resolve) => {
    const wsUrl =
      `${WS_BASE}?intent=${INTENT}` +
      `&model=${encodeURIComponent(model)}` +
      `&input_audio_format=${INPUT_AUDIO_FORMAT}` +
      `&turn_detection=${TURN_DETECTION}`;
    const chunks = fixture.chunks;
    const runStart = performance.now();

    const state: RunState = {
      finished: false,
      status: 'error',
      error: null,
      transcript: '',
      tStreamStart: null,
      tCommit: null,
      tFirstDelta: null,
      tFinal: null,
    };

    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    let timer: NodeJS.Timeout | null = null;

    const finish = (status: RunStatus, error?: string) => {
      if (state.finished) return;
      state.finished = true;
      state.status = status;
      if (error) state.error = error;
      if (timer) clearTimeout(timer);
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, 'client done');
        }
      } catch {
        /* socket already gone */
      }
      // Give the close frame a moment to flush before resolving.
      setTimeout(() => resolve(buildResult(model, fixture, fixtureIndex, runIndex, state, runStart)), 50);
    };

    timer = setTimeout(() => finish('error', `Timeout after ${CONN_TIMEOUT_MS}ms`), CONN_TIMEOUT_MS);

    const safeSend = (obj: Record<string, unknown>) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        /* socket gone; ignore */
      }
    };

    const onMessage = (data: WebSocket.RawData) => {
      let event: {
        type?: string;
        transcript?: string;
        message?: string;
        error?: { message?: string };
      };
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (event.type) {
        case 'conversation.item.input_audio_transcription.delta':
          if (state.tFirstDelta === null) state.tFirstDelta = performance.now();
          return;
        case 'conversation.item.input_audio_transcription.completed':
          state.tFinal = performance.now();
          if (typeof event.transcript === 'string') state.transcript = event.transcript;
          finish('ok');
          return;
        case 'conversation.item.input_audio_transcription.failed':
          finish('error', event?.error?.message || 'transcription failed');
          return;
        case 'error':
          finish('error', event?.message || 'unknown server error');
          return;
        default:
          return; // session.created and any other events are ignored
      }
    };

    const stream = async () => {
      state.tStreamStart = performance.now();
      for (const b64 of chunks) {
        if (state.finished) return;
        safeSend({ type: 'input_audio_buffer.append', audio: b64 });
        await delay(CHUNK_INTERVAL_MS);
      }
      if (state.finished) return;
      safeSend({ type: 'input_audio_buffer.commit' });
      state.tCommit = performance.now();
    };

    ws.on('open', () => {
      stream().catch((e) => finish('error', `stream failure: ${e?.message || e}`));
    });
    ws.on('message', onMessage);
    ws.on('error', (err) => {
      finish('error', `socket error: ${err?.message || err}`);
    });
    ws.on('close', () => {
      if (!state.finished) finish('error', 'socket closed before completed');
    });
  });
}

// ---------- aggregation ----------

function summarize(model: string, runs: RunResult[]): ModelSummary {
  const ok = runs.filter((r) => r.status === 'ok');
  const errs = runs.filter((r) => r.status === 'error');
  const commitVals = ok.map((r) => r.commitToFinalMs).filter((v): v is number => v != null);
  const errorRateVals = ok.map((r) => r.errorRate).filter((v): v is number => v != null);
  return {
    model,
    runs: runs.length,
    ok: ok.length,
    errors: errs.length,
    medianCommitToFinalMs: median(commitVals),
    meanErrorRate: mean(errorRateVals),
    lastError: errs.length ? errs[errs.length - 1].error : null,
    runsData: runs,
  };
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

  // Load .env if TOGETHER_API_KEY is not already exported. This also surfaces
  // STT_BENCH_MODELS from ./.env.
  if (!process.env.TOGETHER_API_KEY) {
    loadDotEnv(path.join(process.cwd(), '.env'));
  }
  const apiKey = process.env.TOGETHER_API_KEY;
  if (!apiKey) {
    console.error('TOGETHER_API_KEY is not set. Export it or put it in ./.env .');
    process.exit(1);
  }

  // Resolve models: --models wins, then STT_BENCH_MODELS env, then default.
  let models = args.models && args.models.length ? args.models : null;
  if (!models) {
    const envModels = process.env.STT_BENCH_MODELS;
    if (envModels && envModels.trim()) {
      models = envModels.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  if (!models || !models.length) models = [...DEFAULT_MODELS];

  // Resolve fixtures: --languages wins, then STT_BENCH_LANGUAGES env, then all.
  let languages = args.languages && args.languages.length ? args.languages : null;
  if (!languages) {
    const envLanguages = process.env.STT_BENCH_LANGUAGES;
    if (envLanguages && envLanguages.trim()) {
      languages = envLanguages.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    }
  }
  const knownLanguages = Array.from(new Set(FIXTURES.map((f) => f.language))).sort();
  const selectedFixtures = languages?.length
    ? FIXTURES.filter((f) => languages.includes(f.language))
    : FIXTURES;
  if (languages?.length) {
    const unknownLanguages = languages.filter((lang) => !knownLanguages.includes(lang));
    if (unknownLanguages.length) {
      console.error(
        `Unknown language code(s): ${unknownLanguages.join(', ')}. Known: ${knownLanguages.join(', ')}`,
      );
      process.exit(2);
    }
  }
  if (!selectedFixtures.length) {
    console.error(`No fixtures selected. Known language codes: ${knownLanguages.join(', ')}`);
    process.exit(2);
  }

  // Ensure all fixtures exist (synthesize via TTS on first run).
  for (const f of selectedFixtures) {
    try {
      await ensureFixture(f, apiKey);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }

  // Preload fixture bytes + precompute chunks once (reused across models/runs).
  const fixtures = selectedFixtures.map((f, i) => {
    const fixturePath = path.join('test-fixtures', f.name);
    const pcm = fs.readFileSync(fixturePath);
    return {
      index: i + 1,
      name: f.name,
      language: f.language,
      scoring: f.scoring,
      tts: ttsConfigFor(f.language),
      text: f.text,
      path: fixturePath,
      bytes: pcm.length,
      chunks: buildChunks(pcm),
    };
  });

  const total = models.length * fixtures.length * args.runs;
  console.log('Together realtime STT benchmark');
  console.log('─'.repeat(53));
  console.log(`Models      : ${models.length} (${models.map((m) => trunc(m, 30)).join(', ')})`);
  console.log(`Runs/model  : ${args.runs} (per fixture)`);
  console.log(`Languages   : ${Array.from(new Set(fixtures.map((f) => f.language))).join(', ')}`);
  console.log(`Fixtures    : ${fixtures.length}`);
  console.log(`Chunk       : ${CHUNK_BYTES} bytes / ${CHUNK_INTERVAL_MS} ms @ ${FIXTURE_SAMPLE_RATE} Hz`);
  console.log(`Timeout     : ${CONN_TIMEOUT_MS} ms (per connection)`);
  console.log(`Endpoint    : ${WS_BASE}?intent=${INTENT}&model=...&input_audio_format=${INPUT_AUDIO_FORMAT}&turn_detection=${TURN_DETECTION}`);
  console.log(`Total runs  : ${total}`);
  console.log('─'.repeat(53));

  const startedAt = Date.now();
  let doneCount = 0;
  const summaries: ModelSummary[] = [];

  for (const model of models) {
    const modelRuns = [];
    console.log(`\nModel: ${model}`);
    for (const fx of fixtures) {
      for (let r = 1; r <= args.runs; r += 1) {
        const res = await runOne(model, fx, fx.index, r, apiKey);
        modelRuns.push(res);
        doneCount += 1;
        if (res.status === 'ok') {
          console.log(
            `[${doneCount}/${total}] ${trunc(model, 30)} ${fx.name} run ${r}/${args.runs}  ok ` +
              `commitToFinal=${fmtMs(res.commitToFinalMs)}ms firstDelta=${fmtMs(res.firstDeltaMs)}ms ` +
              `${res.metric}=${fmtPct(res.errorRate)}  "${trunc(res.transcript, 60)}"`,
          );
        } else {
          console.log(
            `[${doneCount}/${total}] ${trunc(model, 30)} ${fx.name} run ${r}/${args.runs}  ` +
              `ERROR - ${trunc(res.error || '', 120)}`,
          );
        }
      }
    }

    console.log(`\nPer-run results for ${model}`);
    console.log('─'.repeat(53));
    printRunsTable(modelRuns);

    const summary = summarize(model, modelRuns);
    summaries.push(summary);
    console.log(
      `Summary: ${trunc(model, 40)}  ok ${summary.ok}/${summary.runs}  ` +
        `median commitToFinal=${fmtMs(summary.medianCommitToFinalMs)}ms  ` +
        `mean error=${fmtPct(summary.meanErrorRate)}` +
        (summary.errors
          ? `  (${summary.errors} error${summary.errors === 1 ? '' : 's'}: ${trunc(summary.lastError || '', 80)})`
          : ''),
    );
  }

  console.log('\nSummary (median commitToFinal + mean transcript error over successful runs)');
  console.log('─'.repeat(53));
  printSummaryTable(summaries);

  // Full JSON results.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(OUT_DIR, `together-stt-${stamp}.json`);
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const payload = {
      meta: {
        timestamp: new Date().toISOString(),
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        runs: args.runs,
        models,
        timeoutMs: CONN_TIMEOUT_MS,
        wsBase: WS_BASE,
        intent: INTENT,
        inputAudioFormat: INPUT_AUDIO_FORMAT,
        turnDetection: TURN_DETECTION,
        chunkBytes: CHUNK_BYTES,
        chunkIntervalMs: CHUNK_INTERVAL_MS,
        fixtureSampleRate: FIXTURE_SAMPLE_RATE,
        fixtures: fixtures.map((f) => ({
          index: f.index,
          path: f.path,
          name: f.name,
          language: f.language,
          scoring: f.scoring,
          tts: f.tts,
          groundTruth: f.text,
          bytes: f.bytes,
          chunks: f.chunks.length,
        })),
        tts: {
          endpoint: TTS_ENDPOINT,
          responseFormat: 'raw',
          fixtureSampleRate: FIXTURE_SAMPLE_RATE,
          configsByLanguage: TTS_BY_LANGUAGE,
        },
      },
      models: summaries,
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
    console.log(`\nJSON written: ${file}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`\nFailed to write JSON: ${message}`);
  }

  const totalOk = summaries.reduce((s, m) => s + m.ok, 0);
  const totalErr = summaries.reduce((s, m) => s + m.errors, 0);
  console.log(
    `\nDone: ${totalOk} ok / ${totalErr} errors across ${summaries.length} models in ${(
      (Date.now() - startedAt) /
      1000
    ).toFixed(1)}s`,
  );
}

main().catch((e) => {
  console.error(`Fatal: ${e?.stack || e}`);
  process.exit(1);
});
