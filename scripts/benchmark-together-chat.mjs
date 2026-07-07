#!/usr/bin/env node
// scripts/benchmark-together-chat.mjs
//
// Standalone latency benchmark for Together serverless chat models, tuned to a
// latency-sensitive voice path: user transcript -> short assistant text.
//
//   * Streams completions (stream:true) and measures time-to-first-content-token.
//   * Disables reasoning via both `reasoning:{enabled:false}` and
//     `chat_template_kwargs` (enable_thinking / thinking = false) where reasonable.
//   * Captures per-request: HTTP status/error, TTFT (ms), total elapsed (ms),
//     approximate output token count, characters, tokens/sec after first token
//     and total tokens/sec.
//   * Runs configurable repetitions, concurrency, timeout and prompt.
//   * Prints progress + a final table sorted by median TTFT then median tok/s.
//   * Writes JSON results to bench-results/together-chat-<timestamp>.json
//     unless --no-json. Model errors never abort the whole run.
//
// No external dependencies. Requires Node 18+ (global fetch, ReadableStream,
// AbortController, performance, TextDecoder).
//
// Usage:
//   TOGETHER_API_KEY=... node scripts/benchmark-together-chat.mjs
//   node scripts/benchmark-together-chat.mjs --models "a,b" --runs 3 --concurrency 2
//   node scripts/benchmark-together-chat.mjs --prompt "Hi" --max-tokens 32 --no-json
//
// Reads TOGETHER_API_KEY from process.env. Also tries to load ./.env when the key
// is not already exported, so the project's gitignored .env works out of the box.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_API_BASE = 'https://api.together.ai/v1';
const API_PATH = '/chat/completions';

const DEFAULT_SYSTEM_PROMPT =
  'You are a concise voice assistant. Reply with a single short spoken sentence. ' +
  'No markdown, no lists, no preamble.';

const DEFAULT_USER_PROMPT =
  'The user just said: "Can you set a ten minute timer for my pasta?" ' +
  'Respond out loud in one short sentence.';

// Default Together serverless chat model catalog (override with --models).
const DEFAULT_MODELS = [
  'MiniMaxAI/MiniMax-M3',
  'MiniMaxAI/MiniMax-M2.7',
  'Qwen/Qwen3.7-Max',
  'Qwen/Qwen3.6-Plus',
  'Qwen/Qwen3.5-9B',
  'moonshotai/Kimi-K2.7-Code',
  'moonshotai/Kimi-K2.6',
  'zai-org/GLM-5.2',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'deepseek-ai/DeepSeek-V4-Pro',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  'Qwen/Qwen2.5-7B-Instruct-Turbo',
  'google/gemma-4-31B-it',
  'pearl-ai/gemma-4-31b-it',
  'LiquidAI/LFM2-24B-A2B',
  'deepcogito/cogito-v2-1-671b',
  'Qwen/Qwen3.7-Plus',
  'google/gemma-3n-E4B-it',
  'meta-llama/Meta-Llama-3-8B-Instruct-Lite',
  'Qwen/Qwen3-235B-A22B-Instruct-2507-tput',
  'zai-org/GLM-5.1',
];

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
    concurrency: 1,
    timeout: 60000,
    maxTokens: 64,
    prompt: DEFAULT_USER_PROMPT,
    system: DEFAULT_SYSTEM_PROMPT,
    apiBase: DEFAULT_API_BASE,
    noJson: false,
    outDir: 'bench-results',
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
      case '--concurrency':
        a.concurrency = parseInt(need('--concurrency'), 10);
        break;
      case '--timeout':
        a.timeout = parseInt(need('--timeout'), 10);
        break;
      case '--max-tokens':
        a.maxTokens = parseInt(need('--max-tokens'), 10);
        break;
      case '--prompt':
        a.prompt = need('--prompt');
        break;
      case '--system':
        a.system = need('--system');
        break;
      case '--api-base':
        a.apiBase = need('--api-base');
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
  console.log(`benchmark-together-chat.mjs - Together serverless chat latency benchmark

Usage:
  node scripts/benchmark-together-chat.mjs [options]

Options:
  --models "a,b,c"   Comma-separated model ids to benchmark (default: built-in catalog)
  --runs N           Repetitions per model (default 3)
  --concurrency N    Parallel in-flight requests across all model/run tasks (default 1).
                     Higher values speed up the run but may affect latency measurements.
  --timeout MS       Per-request timeout in ms (default 60000)
  --max-tokens N     Max output tokens per request (default 64, small for a voice path)
  --prompt TEXT      User prompt / transcript (default: a short timer request)
  --system TEXT      System prompt (default: concise voice assistant)
  --api-base URL     API base (default ${DEFAULT_API_BASE})
  --out-dir DIR      JSON output directory (default bench-results)
  --no-json          Skip writing JSON results file

Env:
  TOGETHER_API_KEY   Required. Also auto-loaded from ./.env if not exported.

Notes:
  Streams with reasoning disabled (reasoning.enabled=false and
  chat_template_kwargs enable_thinking/thinking=false). Errors per model are
  reported and never abort the run. Final table sorts by median TTFT (asc)
  then median tokens/sec after first token (desc).
`);
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((x, y) => x + y, 0) / arr.length;
}

const fmtMs = (v) => (v == null ? '-' : Math.round(v).toLocaleString('en-US'));
const fmt1 = (v) => (v == null ? '-' : v.toFixed(1));
const fmtInt = (v) => (v == null ? '-' : String(Math.round(v)));

function trunc(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + '\u2026';
}

// ---------- core request ----------

async function runOne(model, opts, apiKey, apiUrl) {
  const body = {
    model,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.prompt },
    ],
    stream: true,
    max_tokens: opts.maxTokens,
    temperature: 0,
    stream_options: { include_usage: true },
    // Disable reasoning/thinking wherever the model supports it. Unsupported
    // keys are generally ignored by the Together API; if a model rejects them,
    // the error is captured per-model without aborting the run.
    reasoning: { enabled: false },
    chat_template_kwargs: { enable_thinking: false, thinking: false },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout);
  const start = performance.now();

  let httpStatus = 0;
  let firstContentAt = null;
  let contentText = '';
  let usageTokens = null;
  let error = null;

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    httpStatus = res.status;

    if (!res.ok) {
      let detail = '';
      try {
        detail = await res.text();
      } catch {}
      error = `HTTP ${res.status}: ${detail.slice(0, 300)}`;
      return {
        model,
        status: 'error',
        httpStatus,
        error,
        totalElapsed: performance.now() - start,
      };
    }

    if (!res.body) {
      error = 'No response body';
      return {
        model,
        status: 'error',
        httpStatus,
        error,
        totalElapsed: performance.now() - start,
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue; // partial / keepalive line
        }
        const delta = json.choices?.[0]?.delta;
        if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
          if (firstContentAt === null) firstContentAt = performance.now();
          contentText += delta.content;
        }
        const u = json.usage;
        if (u && typeof u.completion_tokens === 'number') {
          usageTokens = u.completion_tokens;
        }
      }
    }

    const totalElapsed = performance.now() - start;

    if (firstContentAt === null) {
      error = error || `No content tokens received (status ${httpStatus})`;
      return { model, status: 'error', httpStatus, error, totalElapsed };
    }

    const ttft = firstContentAt - start;
    const tokenCount =
      usageTokens != null ? usageTokens : Math.max(1, Math.round(contentText.length / 4));
    const genSec = Math.max(0.001, (totalElapsed - ttft) / 1000);
    const totalSec = Math.max(0.001, totalElapsed / 1000);
    const tpsGen = tokenCount / genSec;
    const tpsTotal = tokenCount / totalSec;

    return {
      model,
      status: 'ok',
      httpStatus,
      ttft,
      totalElapsed,
      tokenCount,
      chars: contentText.length,
      tpsGen,
      tpsTotal,
      text: contentText,
    };
  } catch (e) {
    if (e?.name === 'AbortError') error = `Timeout after ${opts.timeout}ms`;
    else error = e?.message ? `${e.name}: ${e.message}` : String(e);
    return {
      model,
      status: 'error',
      httpStatus,
      error,
      totalElapsed: performance.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- concurrency pool ----------

async function runPool(tasks, concurrency, worker) {
  const results = new Array(tasks.length);
  let cursor = 0;
  async function loop() {
    while (cursor < tasks.length) {
      const i = cursor++;
      results[i] = await worker(tasks[i], i);
    }
  }
  const n = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: n }, () => loop()));
  return results;
}

// ---------- aggregation / reporting ----------

function summarize(model, runs) {
  const ok = runs.filter((r) => r.status === 'ok');
  const errs = runs.filter((r) => r.status === 'error');
  const pick = (k) => ok.map((r) => r[k]).filter((v) => v != null);
  return {
    model,
    runs: runs.length,
    ok: ok.length,
    errors: errs.length,
    medianTTFT: median(pick('ttft')),
    meanTTFT: mean(pick('ttft')),
    medianTotal: median(pick('totalElapsed')),
    meanTotal: mean(pick('totalElapsed')),
    medianTokens: median(pick('tokenCount')),
    medianChars: median(pick('chars')),
    medianTpsGen: median(pick('tpsGen')),
    medianTpsTotal: median(pick('tpsTotal')),
    lastError: errs.length ? errs[errs.length - 1].error : null,
    runsData: runs,
  };
}

function rank(a, b) {
  // Successful models first: by median TTFT asc, then median tok/s gen desc.
  const aOk = a.ok > 0;
  const bOk = b.ok > 0;
  if (aOk !== bOk) return aOk ? -1 : 1;
  if (!aOk && !bOk) return a.model.localeCompare(b.model);
  const ta = a.medianTTFT ?? Infinity;
  const tb = b.medianTTFT ?? Infinity;
  if (ta !== tb) return ta - tb;
  const ga = a.medianTpsGen ?? -Infinity;
  const gb = b.medianTpsGen ?? -Infinity;
  return gb - ga;
}

function printTable(rows) {
  const cols = [
    'Model',
    'OK',
    'TTFT(ms)',
    'Total(ms)',
    'Tok',
    'Chars',
    'tok/s(gen)',
    'tok/s(tot)',
  ];
  const data = rows.map((s) => [
    trunc(s.model, 46),
    `${s.ok}/${s.runs}`,
    s.ok > 0 ? fmtMs(s.medianTTFT) : 'ERR',
    s.ok > 0 ? fmtMs(s.medianTotal) : '-',
    s.ok > 0 ? fmtInt(s.medianTokens) : '-',
    s.ok > 0 ? fmtInt(s.medianChars) : '-',
    s.ok > 0 ? fmt1(s.medianTpsGen) : '-',
    s.ok > 0 ? fmt1(s.medianTpsTotal) : '-',
  ]);
  const widths = cols.map((c, i) =>
    Math.max(c.length, ...data.map((r) => r[i].length))
  );
  const pad = (cells) =>
    cells.map((c, i) => String(c).padEnd(widths[i], ' ')).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  console.log(pad(cols));
  console.log(sep);
  for (const r of data) console.log(pad(r));
  for (const s of rows.filter((x) => x.errors > 0)) {
    console.log(`  ! ${s.model}: ${s.errors}/${s.runs} failed - ${s.lastError}`);
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
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) args.concurrency = 1;
  if (!Number.isFinite(args.timeout) || args.timeout < 1000) args.timeout = 60000;
  if (!Number.isFinite(args.maxTokens) || args.maxTokens < 1) args.maxTokens = 64;

  const models = args.models && args.models.length ? args.models : DEFAULT_MODELS;

  if (!process.env.TOGETHER_API_KEY) {
    loadDotEnv(path.join(process.cwd(), '.env'));
  }
  const apiKey = process.env.TOGETHER_API_KEY;
  if (!apiKey) {
    console.error('TOGETHER_API_KEY is not set. Export it or put it in ./.env .');
    process.exit(1);
  }

  const apiUrl = args.apiBase.replace(/\/+$/, '') + API_PATH;

  const tasks = [];
  for (const model of models) {
    for (let r = 1; r <= args.runs; r++) tasks.push({ model, runIndex: r });
  }

  console.log('Together chat latency benchmark');
  console.log('\u2500'.repeat(53));
  console.log(`Models      : ${models.length}`);
  console.log(`Runs/model  : ${args.runs}`);
  console.log(`Concurrency : ${args.concurrency}`);
  console.log(`Timeout     : ${args.timeout} ms`);
  console.log(`Max tokens  : ${args.maxTokens}`);
  console.log(`Endpoint    : ${apiUrl}`);
  console.log(`System      : ${trunc(args.system, 80)}`);
  console.log(`Prompt      : ${trunc(args.prompt, 80)}`);
  console.log(`Total reqs  : ${tasks.length}`);
  console.log('\u2500'.repeat(53));

  const startedAt = Date.now();
  let doneCount = 0;

  const results = await runPool(tasks, args.concurrency, async (task) => {
    const r = await runOne(task.model, args, apiKey, apiUrl);
    doneCount++;
    if (r.status === 'ok') {
      console.log(
        `[${doneCount}/${tasks.length}] run ${task.runIndex}/${args.runs} ` +
          `${trunc(task.model, 40)}  ok ${r.httpStatus}  ` +
          `ttft=${fmtMs(r.ttft)}ms total=${fmtMs(r.totalElapsed)}ms ` +
          `tok=${r.tokenCount} tok/s(gen)=${fmt1(r.tpsGen)}`
      );
    } else {
      console.log(
        `[${doneCount}/${tasks.length}] run ${task.runIndex}/${args.runs} ` +
          `${trunc(task.model, 40)}  ERROR ${r.httpStatus || '?'} - ${trunc(r.error || '', 120)}`
      );
    }
    return r;
  });

  // Group by model preserving task order, then summarize + rank.
  const byModel = new Map();
  for (const r of results) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }
  const summaries = models.map((m) => summarize(m, byModel.get(m) || []));
  summaries.sort(rank);

  console.log('\nResults (sorted by median TTFT, then median tok/s gen)');
  console.log('\u2500'.repeat(53));
  printTable(summaries);

  if (!args.noJson) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(args.outDir, `together-chat-${stamp}.json`);
    try {
      fs.mkdirSync(args.outDir, { recursive: true });
      const payload = {
        meta: {
          timestamp: new Date().toISOString(),
          startedAt: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
          apiBase: args.apiBase,
          endpoint: apiUrl,
          runs: args.runs,
          concurrency: args.concurrency,
          timeoutMs: args.timeout,
          maxTokens: args.maxTokens,
          system: args.system,
          prompt: args.prompt,
          models,
        },
        models: summaries,
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
    `\nDone: ${totalOk} ok / ${totalErr} errors across ${summaries.length} models in ${(
      (Date.now() - startedAt) /
      1000
    ).toFixed(1)}s`
  );
}

main().catch((e) => {
  console.error(`Fatal: ${e?.stack || e}`);
  process.exit(1);
});
