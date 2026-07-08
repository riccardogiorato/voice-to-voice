#!/usr/bin/env node
// scripts/e2e-voice-latency.mjs
//
// End-to-end, protocol-level latency test for the voice assistant exposed at
// /api/voice (see app/api/voice/route.ts). It drives the full WebSocket turn —
// conversation.start -> streamed audio.input -> audio.commit -> wait for
// transcript.final -> assistant.delta -> audio.delta -> audio.done — and reports
// per-stage latencies measured from the commit instant, plus content/audio
// sanity assertions.
//
//   * Streams the test-fixtures/hello-16k.pcm fixture as 80 ms Float32
//     audio.input chunks paced in real time, then commits.
//   * Records first-occurrence timestamps for transcript.delta, transcript.final,
//     assistant.delta, audio.delta, audio.done and derives STT / TTFT /
//     first-audio / total latencies from audio.commit.
//   * Accumulates assistant text and decoded TTS audio (pcm16le @ 24 kHz) to
//     assert non-empty speech, >~0.5 s of audio, and a non-silent RMS.
//   * Prints an aligned summary table and writes full JSON to
//     bench-results/voice-e2e-<timestamp>.json.
//   * Exits 0 only if every assertion passes; 1 otherwise. A server {type:'error'}
//     event or a 60 s hard timeout is a failure.
//
// Only external dependency is 'ws' (already installed). Requires Node 20+.
//
// Usage:
//   node scripts/e2e-voice-latency.mjs https://your-app.vercel.app
//   node scripts/e2e-voice-latency.mjs wss://your-app.vercel.app/api/voice
//
// If test-fixtures/hello-16k.pcm is missing it is synthesized once via Together
// REST TTS (needs TOGETHER_API_KEY, auto-loaded from ./.env). Env overrides:
//   BUDGET_STT_MS=4000  BUDGET_FIRST_AUDIO_MS=7000  BUDGET_TOTAL_MS=20000

import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

// ---------- constants ----------

const FIXTURE_PATH = path.join('test-fixtures', 'hello-16k.pcm');
const TTS_TEXT = 'Hello! How are you doing today?';
const TTS_MODEL = 'hexgrad/Kokoro-82M';
const TTS_VOICE = 'af_heart';
const TTS_ENDPOINT = 'https://api.together.ai/v1/audio/speech';
// Kokoro-82M always returns 24 kHz s16le mono PCM regardless of the requested
// sample_rate; ensureFixture() requests 24000 and resamples down to 16 kHz.
const TTS_SYNTH_SAMPLE_RATE = 24000;
const FIXTURE_SAMPLE_RATE = 16000; // fixture + client-reported sample rate
const CHUNK_SAMPLES = 1280; // 80 ms of audio at 16 kHz
const CHUNK_INTERVAL_MS = 80; // stream chunks in real time

const HARD_TIMEOUT_MS = 60_000; // overall wall-clock cap for the whole run

// Output sample rate of the server's TTS audio.delta events (pcm16le). Used to
// convert accumulated audio bytes into seconds and to scale RMS samples.
const TTS_OUTPUT_SAMPLE_RATE = 24000;

// ---------- dotenv loader (matches scripts/benchmark-together-chat.mjs) ----------

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

// ---------- formatting helpers (aligned-column style of the chat benchmark) ----------

const fmtMs = (v) => (v == null ? '-' : `${Math.round(v)} ms`);
const fmt2 = (v) => (v == null ? '-' : v.toFixed(2));
const fmtBytes = (v) => (v == null ? '-' : v.toLocaleString('en-US'));
const trunc = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

function printTable(rows) {
  const cols = ['Metric', 'Value', 'Budget', 'Pass'];
  const data = rows.map((r) => [r.label, r.value, r.budget, r.pass]);
  const widths = cols.map((c, i) =>
    Math.max(c.length, ...data.map((r) => r[i].length)),
  );
  const pad = (cells) => cells.map((c, i) => String(c).padEnd(widths[i], ' ')).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  console.log(pad(cols));
  console.log(sep);
  for (const r of data) console.log(pad(r));
}

// ---------- url handling ----------

// Normalize the target URL to a ws(s) URL pointing at /api/voice.
//   https://host        -> wss://host/api/voice
//   https://host/api/x  -> wss://host/api/x   (path kept)
//   wss://host/api/voice-> wss://host/api/voice
function normalizeTargetUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }

  if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol !== 'wss:' && u.protocol !== 'ws:') {
    throw new Error(
      `Unsupported protocol ${u.protocol}; pass an https:// or wss:// URL.`,
    );
  }

  if (u.pathname === '' || u.pathname === '/') u.pathname = '/api/voice';
  return u;
}

// ---------- fixture synthesis ----------

// Synthesize the 16 kHz signed-16-bit little-endian mono PCM fixture once via
// the Together REST TTS endpoint. response_format:'raw' returns raw PCM bytes;
// for hexgrad/Kokoro-82M the API always returns pcm_s16le. The Together API
// reference documents that Kokoro always outputs 24 kHz regardless of the
// requested sample_rate, so the script requests 24000 explicitly and resamples
// the 24 kHz s16le response down to 16 kHz (linear interpolation, mirroring
// resample() in app/api/voice/route.ts) before saving — guaranteeing a true
// 16 kHz fixture rather than 24 kHz content mislabeled as 16 kHz.
async function ensureFixture(apiKey) {
  if (fs.existsSync(FIXTURE_PATH)) return;

  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });

  const res = await fetch(TTS_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: TTS_TEXT,
      voice: TTS_VOICE,
      response_format: 'raw',
      sample_rate: TTS_SYNTH_SAMPLE_RATE,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `TTS synthesis failed (HTTP ${res.status}): ${detail.slice(0, 300)}`,
    );
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error('TTS synthesis returned no audio bytes');

  // Kokoro returns 24 kHz s16le mono PCM regardless of sample_rate. Decode to
  // Float32, linear-interpolate down to 16 kHz (mirroring resample() in
  // app/api/voice/route.ts), then re-encode to s16le so the saved fixture is a
  // true 16 kHz file instead of 24 kHz content mislabeled as 16 kHz.
  const inputSamples = Math.floor(bytes.length / 2);
  const input = new Float32Array(inputSamples);
  for (let i = 0; i < inputSamples; i += 1) {
    input[i] = bytes.readInt16LE(i * 2) / 32768;
  }

  const ratio = TTS_SYNTH_SAMPLE_RATE / FIXTURE_SAMPLE_RATE; // 1.5
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

  fs.writeFileSync(FIXTURE_PATH, pcm16);
  console.log(
    `Synthesized fixture: ${FIXTURE_PATH} (${bytes.length} bytes -> resampled ${pcm16.length} bytes @ ${FIXTURE_SAMPLE_RATE} Hz)`,
  );
}

// Read the fixture (signed 16-bit little-endian PCM) and split it into 80 ms
// chunks of Float32 samples encoded as little-endian bytes + base64.
function buildChunks() {
  const pcm16 = fs.readFileSync(FIXTURE_PATH);
  const sampleCount = Math.floor(pcm16.byteLength / 2); // 2 bytes per s16le sample
  const chunks = [];
  for (let off = 0; off < sampleCount; off += CHUNK_SAMPLES) {
    const n = Math.min(CHUNK_SAMPLES, sampleCount - off);
    const float32 = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      // s16le -> [-1, 1]; 32768 keeps the range symmetric like the server's decoder.
      float32[i] = pcm16.readInt16LE((off + i) * 2) / 32768;
    }
    const buf = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i += 1) buf.writeFloatLE(float32[i], i * 4);
    chunks.push(buf.toString('base64'));
  }
  return chunks;
}

// ---------- metrics ----------

function newMetrics() {
  return {
    tCommit: null,
    tFirstTranscriptDelta: null,
    tFinal: null,
    tFirstAssistant: null,
    tFirstAudio: null,
    tAudioDone: null,
    finalTranscript: '',
    assistantText: '',
    totalAudioBytes: 0,
    audioSamples: [], // decoded s16le samples, for RMS
    error: null,
  };
}

function computeMetrics(m) {
  const sttMs = m.tFinal != null && m.tCommit != null ? m.tFinal - m.tCommit : null;
  const ttftMs =
    m.tFirstAssistant != null && m.tFinal != null
      ? m.tFirstAssistant - m.tFinal
      : null;
  const firstAudioMs =
    m.tFirstAudio != null && m.tCommit != null ? m.tFirstAudio - m.tCommit : null;
  const totalMs =
    m.tAudioDone != null && m.tCommit != null ? m.tAudioDone - m.tCommit : null;
  const audioSeconds =
    m.totalAudioBytes / 2 / TTS_OUTPUT_SAMPLE_RATE; // 2 bytes per s16le sample

  // RMS over all decoded TTS samples, normalized to [-1, 1].
  let sumSq = 0;
  for (const s of m.audioSamples) sumSq += (s / 32768) ** 2;
  const audioRms = m.audioSamples.length
    ? Math.sqrt(sumSq / m.audioSamples.length)
    : 0;

  return { sttMs, ttftMs, firstAudioMs, totalMs, audioSeconds, audioRms };
}

// ---------- main ----------

async function main() {
  const rawUrl = process.argv[2];
  if (!rawUrl) {
    console.error('Usage: node scripts/e2e-voice-latency.mjs <url>');
    console.error('  <url> is the deployed endpoint, e.g. https://your-app.vercel.app');
    console.error('  or a full wss URL: wss://your-app.vercel.app/api/voice');
    process.exit(2);
  }

  let target;
  try {
    target = normalizeTargetUrl(rawUrl);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  // Same-host Origin so the server's origin check passes (it compares the
  // Origin host against the request Host header).
  const origin = `https://${target.host}`;

  // Load .env if TOGETHER_API_KEY is not already exported (needed only to
  // synthesize the fixture on first run).
  if (!process.env.TOGETHER_API_KEY) {
    loadDotEnv(path.join(process.cwd(), '.env'));
  }
  const apiKey = process.env.TOGETHER_API_KEY;

  if (!fs.existsSync(FIXTURE_PATH)) {
    if (!apiKey) {
      console.error(
        `Fixture ${FIXTURE_PATH} not found and TOGETHER_API_KEY is not set.\n` +
          'Set TOGETHER_API_KEY (or put it in ./.env) to synthesize it on first run.',
      );
      process.exit(1);
    }
    try {
      await ensureFixture(apiKey);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  }

  const chunks = buildChunks();

  console.log('End-to-end voice latency test');
  console.log('─'.repeat(53));
  console.log(`Endpoint    : ${target.href}`);
  console.log(`Origin      : ${origin}`);
  console.log(`Fixture     : ${FIXTURE_PATH} (${fs.statSync(FIXTURE_PATH).size} bytes)`);
  console.log(`Chunks      : ${chunks.length} x ${CHUNK_SAMPLES} samples @ ${FIXTURE_SAMPLE_RATE} Hz (${CHUNK_INTERVAL_MS} ms each)`);
  console.log(`Timeout     : ${HARD_TIMEOUT_MS} ms`);
  console.log('─'.repeat(53));

  const m = newMetrics();
  const startedAt = Date.now();

  const result = await runTurn(target.href, origin, chunks, m, startedAt);

  // Build the assertion list.
  const { sttMs, ttftMs, firstAudioMs, totalMs, audioSeconds, audioRms } =
    computeMetrics(m);

  const budgetStt = Number(process.env.BUDGET_STT_MS ?? 4000);
  const budgetFirstAudio = Number(process.env.BUDGET_FIRST_AUDIO_MS ?? 7000);
  const budgetTotal = Number(process.env.BUDGET_TOTAL_MS ?? 20000);

  const transcriptOk = /hello|how are you/i.test(m.finalTranscript);
  const assistantOk = m.assistantText.trim().length > 0;
  const audioBytesOk = m.totalAudioBytes > 24000;
  const rmsOk = audioRms > 0.005;
  const sttOk = sttMs != null && sttMs <= budgetStt;
  const firstAudioOk = firstAudioMs != null && firstAudioMs <= budgetFirstAudio;
  const totalOk = totalMs != null && totalMs <= budgetTotal;

  const pass = (ok) => (ok ? 'PASS' : 'FAIL');
  const tableRows = [
    { label: 'transcript.final', value: trunc(m.finalTranscript || '(none)', 40), budget: '/hello|how are you/i', pass: pass(transcriptOk) },
    { label: 'assistant text', value: trunc(m.assistantText || '(none)', 40), budget: 'non-empty', pass: pass(assistantOk) },
    { label: 'audio bytes', value: `${fmtBytes(m.totalAudioBytes)} (${fmt2(audioSeconds)}s)`, budget: '> 24000', pass: pass(audioBytesOk) },
    { label: 'audio RMS', value: fmt2(audioRms), budget: '> 0.005', pass: pass(rmsOk) },
    { label: 'STT latency', value: fmtMs(sttMs), budget: `<= ${budgetStt} ms`, pass: pass(sttOk) },
    { label: 'first audio latency', value: fmtMs(firstAudioMs), budget: `<= ${budgetFirstAudio} ms`, pass: pass(firstAudioOk) },
    { label: 'total latency', value: fmtMs(totalMs), budget: `<= ${budgetTotal} ms`, pass: pass(totalOk) },
    { label: 'TTFT (assistant)', value: fmtMs(ttftMs), budget: '-', pass: '-' },
  ];

  console.log('\nResults');
  console.log('─'.repeat(53));
  printTable(tableRows);

  if (m.error) console.log(`\nServer error: ${m.error}`);
  if (result.timedOut) console.log('\nTIMEOUT: audio.done was not received in time.');

  // Write JSON results.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = 'bench-results';
  const file = path.join(outDir, `voice-e2e-${stamp}.json`);
  const allPass =
    transcriptOk &&
    assistantOk &&
    audioBytesOk &&
    rmsOk &&
    sttOk &&
    firstAudioOk &&
    totalOk &&
    !m.error &&
    !result.timedOut;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const payload = {
      meta: {
        timestamp: new Date().toISOString(),
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        endpoint: target.href,
        origin,
        fixture: FIXTURE_PATH,
        fixtureBytes: fs.statSync(FIXTURE_PATH).size,
        chunkSamples: CHUNK_SAMPLES,
        chunkIntervalMs: CHUNK_INTERVAL_MS,
        fixtureSampleRate: FIXTURE_SAMPLE_RATE,
        hardTimeoutMs: HARD_TIMEOUT_MS,
        budgets: { sttMs: budgetStt, firstAudioMs: budgetFirstAudio, totalMs: budgetTotal },
      },
      metrics: { sttMs, ttftMs, firstAudioMs, totalMs, audioSeconds, audioRms },
      transcript: m.finalTranscript,
      assistantText: m.assistantText,
      totalAudioBytes: m.totalAudioBytes,
      assertions: {
        transcriptMatches: transcriptOk,
        assistantNonEmpty: assistantOk,
        audioBytes: audioBytesOk,
        audioRms: rmsOk,
        sttWithinBudget: sttOk,
        firstAudioWithinBudget: firstAudioOk,
        totalWithinBudget: totalOk,
      },
      serverError: m.error,
      timedOut: result.timedOut,
      pass: allPass,
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
    console.log(`\nJSON written: ${file}`);
  } catch (e) {
    console.error(`\nFailed to write JSON: ${e.message}`);
  }

  console.log(
    `\nDone in ${((Date.now() - startedAt) / 1000).toFixed(1)}s -> ${allPass ? 'PASS' : 'FAIL'}`,
  );
  process.exit(allPass ? 0 : 1);
}

// Drive a single voice turn over a fresh WebSocket. Resolves once audio.done is
// received, the server errors, the socket closes, or the hard timeout elapses.
function runTurn(url, origin, chunks, m, startedAt) {
  return new Promise((resolve) => {
    const state = { timedOut: false, finished: false };
    const finish = (timedOut = false) => {
      if (state.finished) return;
      state.finished = true;
      state.timedOut = timedOut;
      clearTimeout(timer);
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          safeSend(ws, { type: 'conversation.stop' });
          ws.close(1000, 'client done');
        }
      } catch {}
      // Give the socket a moment to flush the stop frame before resolving.
      setTimeout(() => resolve(state), 50);
    };

    const timer = setTimeout(() => finish(true), HARD_TIMEOUT_MS);

    const ws = new WebSocket(url, { headers: { Origin: origin } });

    const send = (obj) => safeSend(ws, obj);
    let listening = false;
    let committed = false;

    const onMessage = async (data) => {
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }

      switch (event.type) {
        case 'state':
          if (event.state === 'listening' && !listening) listening = true;
          return;
        case 'transcript.delta':
          if (m.tFirstTranscriptDelta === null)
            m.tFirstTranscriptDelta = performance.now();
          return;
        case 'transcript.final':
          if (m.tFinal === null) m.tFinal = performance.now();
          if (typeof event.text === 'string') m.finalTranscript = event.text;
          return;
        case 'assistant.delta':
          if (m.tFirstAssistant === null) m.tFirstAssistant = performance.now();
          if (typeof event.text === 'string') m.assistantText += event.text;
          return;
        case 'audio.delta':
          if (m.tFirstAudio === null) m.tFirstAudio = performance.now();
          if (typeof event.audio === 'string') {
            const buf = Buffer.from(event.audio, 'base64');
            m.totalAudioBytes += buf.byteLength;
            // Collect decoded s16le samples for the RMS check.
            const n = Math.floor(buf.byteLength / 2);
            for (let i = 0; i < n; i += 1) m.audioSamples.push(buf.readInt16LE(i * 2));
          }
          return;
        case 'audio.done':
          if (m.tAudioDone === null) m.tAudioDone = performance.now();
          finish(false);
          return;
        case 'audio.clear':
          return;
        case 'error':
          m.error = typeof event.message === 'string' ? event.message : 'unknown error';
          finish(false);
          return;
        default:
          return;
      }
    };

    const stream = async () => {
      // Wait until the server signals it is listening (STT ready) before
      // streaming audio, matching the protocol's intended ordering.
      while (!listening && !state.finished) await delay(20);
      if (state.finished) return;

      for (const b64 of chunks) {
        if (state.finished) return;
        send({ type: 'audio.input', audio: b64, sampleRate: FIXTURE_SAMPLE_RATE });
        await delay(CHUNK_INTERVAL_MS);
      }
      if (state.finished) return;
      send({ type: 'audio.commit' });
      m.tCommit = performance.now();
      committed = true;
    };

    ws.on('open', () => {
      send({ type: 'conversation.start' });
      stream().catch((e) => {
        m.error = `stream failure: ${e?.message || e}`;
        finish(false);
      });
    });
    ws.on('message', onMessage);
    ws.on('error', (err) => {
      if (!committed) m.error = m.error || `socket error: ${err?.message || err}`;
      finish(false);
    });
    ws.on('close', () => {
      // A clean close before audio.done without an explicit error is a failure
      // (the turn did not complete); surface it if we have nothing better.
      if (!state.finished) {
        if (!m.error) m.error = 'socket closed before audio.done';
        finish(false);
      }
    });
  });
}

function safeSend(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    /* socket gone; ignore */
  }
}

main().catch((e) => {
  console.error(`Fatal: ${e?.stack || e}`);
  process.exit(1);
});