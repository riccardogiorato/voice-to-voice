#!/usr/bin/env node
// scripts/benchmark-together-repair.mts
//
// Benchmarks Together serverless text-to-text/chat models for transcript
// repair: noisy speech-to-text text in, repaired user utterance out. Measures
// time-to-first-token, total completion time, output speed, and a simple
// task-specific quality score.
//
// Usage:
//   node scripts/benchmark-together-repair.mts
//   node scripts/benchmark-together-repair.mts --runs 3
//   node scripts/benchmark-together-repair.mts --models "Qwen/Qwen2.5-7B-Instruct-Turbo,meta-llama/Meta-Llama-3-8B-Instruct-Lite"

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

type CliArgs = {
  models: string[] | null;
  runs: number;
  help: boolean;
};

type Fixture = {
  raw: string;
  expect: string;
  acceptable?: string[];
};

type RunResult = {
  model: string;
  run: number;
  raw: string;
  expect: string;
  output: string;
  reasoningChars: number;
  status: 'ok' | 'error';
  ttftMs: number | null;
  totalMs: number | null;
  charsPerSec: number | null;
  quality: number;
  error: string | null;
};

type Summary = {
  model: string;
  runs: number;
  ok: number;
  errors: number;
  medianTtftMs: number | null;
  medianTotalMs: number | null;
  meanCharsPerSec: number | null;
  quality: number;
  maxQuality: number;
};

// Together serverless text-to-text/chat catalog from /v1/models, verified
// 2026-07-08. Keep this list broad so the default benchmark is a complete
// repair-model bakeoff; use --models only for ad hoc subsets.
const DEFAULT_MODELS = [
  'zai-org/GLM-5.2', // GLM 5.2
  'MiniMaxAI/MiniMax-M3', // MiniMax M3
  'moonshotai/Kimi-K2.7-Code', // Kimi K2.7 Code
  'deepseek-ai/DeepSeek-V4-Pro', // Deepseek V4 Pro
  'zai-org/GLM-5.1', // GLM 5.1 FP4
  'nvidia/nemotron-3-ultra-550b-a55b', // NVIDIA Nemotron 3 Ultra 550B A55B
  'moonshotai/Kimi-K2.6', // Kimi K2.6 FP4
  'MiniMaxAI/MiniMax-M2.7', // MiniMax M2.7 FP4
  'Qwen/Qwen3.7-Max', // Qwen3.7 Max
  'google/gemma-4-31B-it', // Gemma 4 31B-it FP8
  'pearl-ai/gemma-4-31b-it', // Pearl-ai Gemma-4-31B-it-pearl
  'openai/gpt-oss-120b', // OpenAI GPT-OSS 120B
  'openai/gpt-oss-20b', // OpenAI GPT-OSS 20B
  'Qwen/Qwen3.5-9B', // Qwen3.5 9B FP8
  'Qwen/Qwen3-235B-A22B-Instruct-2507-tput', // Qwen3 235B A22B Instruct 2507 throughput
  'Qwen/Qwen2.5-7B-Instruct-Turbo', // Qwen2.5 7B Instruct Turbo
  'meta-llama/Llama-3.3-70B-Instruct-Turbo', // Meta Llama 3.3 70B Instruct Turbo
  'meta-llama/Meta-Llama-3-8B-Instruct-Lite', // Meta Llama 3 8B Instruct Lite
  'google/gemma-3n-E4B-it', // Gemma 3N E4B Instruct
  'arize-ai/qwen-2-1.5b-instruct', // Arize AI Qwen 2 1.5B Instruct
  'LiquidAI/LFM2-24B-A2B', // LFM2-24B-A2B
  'deepcogito/cogito-v2-1-671b', // Cogito v2.1 671B
  'Qwen/Qwen3.6-Plus', // Qwen3.6 Plus
  'Qwen/Qwen3.7-Plus', // Qwen3.7 Plus
];

const FIXTURES: Fixture[] = [
  { raw: 'hello what doing you', expect: 'Hello, what are you doing?' },
  {
    raw: 'can you show me weather tomorrow rome',
    expect: 'Can you show me the weather in Rome tomorrow?',
    acceptable: [
      'Can you show me the weather tomorrow in Rome?',
      'Can you show me the weather for Rome tomorrow?',
    ],
  },
  {
    raw: 'what is together ai and why fast',
    expect: 'What is Together AI, and why is it fast?',
  },
  { raw: 'yes', expect: 'yes' },
  { raw: 'stop', expect: 'stop' },
  {
    raw: 'i need write email my landlord about sink leaking',
    expect: 'I need to write an email to my landlord about the sink leaking.',
    acceptable: [
      'I need to write an email to my landlord about a leaking sink.',
      'I need to write an email to my landlord about my sink leaking.',
    ],
  },
];

const REPAIR_SYSTEM_PROMPT = `Rewrite speech-to-text transcripts as the most likely intended user utterance.
Rules:
- Fix obvious ASR errors, missing small words, punctuation, casing, and grammar.
- Preserve the user's meaning and language.
- Do not answer the user.
- Do not add facts, names, or details that are not strongly implied.
- Preserve short commands like "yes", "no", "stop", "cancel" exactly.
- If the transcript is already clear or the intended wording is uncertain, return it unchanged.
- Return only the repaired utterance.`;

const OUT_DIR = 'bench-results';

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
  const args: CliArgs = { models: null, runs: 2, help: false };
  const rest = [...argv];
  const need = (name: string) => {
    const value = rest.shift();
    if (value === undefined) throw new Error(`Missing value for ${name}`);
    return value;
  };

  while (rest.length) {
    const arg = rest.shift();
    switch (arg) {
      case '--models':
        args.models = need('--models')
          .split(',')
          .map((model) => model.trim())
          .filter(Boolean);
        break;
      case '--runs':
        args.runs = parseInt(need('--runs'), 10);
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`benchmark-together-repair.mts - transcript repair model benchmark

Usage:
  node scripts/benchmark-together-repair.mts [options]

Options:
  --models "a,b,c"   Comma-separated Together chat model ids
                     (default: ${DEFAULT_MODELS.join(',')})
  --runs N           Repetitions per model x fixture (default 2)
  -h, --help         Show this help

Env:
  TOGETHER_API_KEY   Required. Also auto-loaded from ./.env if not exported.

Output:
  Prints per-run rows plus a cross-model summary, then writes full JSON to
  ${OUT_DIR}/transcript-repair-<timestamp>.json.
`);
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function qualityScore(fixture: Fixture, output: string) {
  const trimmed = output.trim();
  if (!trimmed) return 0;
  if (/^(here|sure|the repaired|rewritten|answer|output)\b/i.test(trimmed)) return 0;

  const shortCommands = new Set(['yes', 'no', 'stop', 'cancel']);
  if (shortCommands.has(fixture.raw) && trimmed !== fixture.raw) return 0;

  const acceptable = [fixture.expect, ...(fixture.acceptable ?? [])];
  if (acceptable.some((expected) => normalize(trimmed) === normalize(expected))) return 2;
  if (normalize(trimmed) === normalize(fixture.raw)) return fixture.raw === fixture.expect ? 2 : 1;
  return 1;
}

async function runRepair(model: string, fixture: Fixture, run: number): Promise<RunResult> {
  const started = performance.now();
  const response = await fetch('https://api.together.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.TOGETHER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: REPAIR_SYSTEM_PROMPT },
        { role: 'user', content: fixture.raw },
      ],
      max_tokens: 80,
      temperature: 0,
      reasoning: { enabled: false },
      reasoning_effort: 'low',
      chat_template_kwargs: { enable_thinking: false, thinking: false },
      stream: true,
    }),
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(`${response.status}${text ? `: ${compact(text, 300)}` : ''}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  let reasoningChars = 0;
  let firstTokenAt: number | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;

      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') {
        return finishRun(model, fixture, run, started, firstTokenAt, output, reasoningChars);
      }

      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.text ?? '';
        const reasoning = json.choices?.[0]?.delta?.reasoning ?? '';
        if (typeof reasoning === 'string') reasoningChars += reasoning.length;
        if (typeof delta === 'string' && delta.length > 0) {
          firstTokenAt ??= performance.now();
          output += delta;
        }
      } catch {
        // Ignore partial or non-JSON SSE lines.
      }
    }
  }

  return finishRun(model, fixture, run, started, firstTokenAt, output, reasoningChars);
}

function finishRun(
  model: string,
  fixture: Fixture,
  run: number,
  started: number,
  firstTokenAt: number | null,
  output: string,
  reasoningChars: number,
): RunResult {
  const ended = performance.now();
  const text = output.trim();
  const generatedSeconds = (ended - (firstTokenAt ?? started)) / 1000;
  return {
    model,
    run,
    raw: fixture.raw,
    expect: fixture.expect,
    output: text,
    reasoningChars,
    status: 'ok',
    ttftMs: firstTokenAt == null ? null : firstTokenAt - started,
    totalMs: ended - started,
    charsPerSec: text.length / Math.max(0.001, generatedSeconds),
    quality: qualityScore(fixture, text),
    error: null,
  };
}

function median(values: Array<number | null>) {
  const xs = values.filter((value): value is number => Number.isFinite(value)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function mean(values: Array<number | null>) {
  const xs = values.filter((value): value is number => Number.isFinite(value));
  return xs.length ? xs.reduce((total, value) => total + value, 0) / xs.length : null;
}

function summarize(results: RunResult[]): Summary[] {
  const byModel = new Map<string, RunResult[]>();
  for (const result of results) {
    const rows = byModel.get(result.model) ?? [];
    rows.push(result);
    byModel.set(result.model, rows);
  }

  return [...byModel.entries()]
    .map(([model, rows]) => {
      const ok = rows.filter((row) => row.status === 'ok' && row.ttftMs != null);
      return {
        model,
        runs: rows.length,
        ok: ok.length,
        errors: rows.length - ok.length,
        medianTtftMs: median(ok.map((row) => row.ttftMs)),
        medianTotalMs: median(ok.map((row) => row.totalMs)),
        meanCharsPerSec: mean(ok.map((row) => row.charsPerSec)),
        quality: rows.reduce((total, row) => total + row.quality, 0),
        maxQuality: rows.length * 2,
      };
    })
    .sort(
      (a, b) =>
        b.quality / b.maxQuality - a.quality / a.maxQuality ||
        (a.medianTotalMs ?? Infinity) - (b.medianTotalMs ?? Infinity),
    );
}

function fmtMs(value: number | null) {
  return value == null ? '-' : Math.round(value).toLocaleString('en-US');
}

function fmtRate(value: number | null) {
  return value == null ? '-' : Math.round(value).toLocaleString('en-US');
}

function compact(value: string, limit: number) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

async function main() {
  loadDotEnv(path.join(process.cwd(), '.env'));

  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!process.env.TOGETHER_API_KEY) {
    throw new Error('Missing TOGETHER_API_KEY. Export it or add it to ./.env.');
  }
  if (!Number.isFinite(args.runs) || args.runs < 1) {
    throw new Error('--runs must be a positive integer.');
  }

  const models = args.models ?? DEFAULT_MODELS;
  const results: RunResult[] = [];

  for (const model of models) {
    console.log(`\n## ${model}`);
    for (let run = 1; run <= args.runs; run += 1) {
      for (const fixture of FIXTURES) {
        try {
          const result = await runRepair(model, fixture, run);
          results.push(result);
          console.log(
            `${run} | ttft=${fmtMs(result.ttftMs)} total=${fmtMs(result.totalMs)} ` +
              `q=${result.quality}/2 | ${JSON.stringify(fixture.raw)} -> ${JSON.stringify(result.output)}`,
          );
        } catch (error) {
          const result: RunResult = {
            model,
            run,
            raw: fixture.raw,
            expect: fixture.expect,
            output: '',
            reasoningChars: 0,
            status: 'error',
            ttftMs: null,
            totalMs: null,
            charsPerSec: null,
            quality: 0,
            error: error instanceof Error ? error.message : String(error),
          };
          results.push(result);
          console.log(
            `${run} | ERROR | ${JSON.stringify(fixture.raw)} | ${compact(result.error ?? '', 220)}`,
          );
        }
      }
    }
  }

  const summary = summarize(results);
  console.log('\n# SUMMARY');
  for (const row of summary) {
    console.log(
      `${row.model}\tok=${row.ok}\terrors=${row.errors}` +
        `\tmedianTTFT=${fmtMs(row.medianTtftMs)}ms` +
        `\tmedianTotal=${fmtMs(row.medianTotalMs)}ms` +
        `\tchars/s=${fmtRate(row.meanCharsPerSec)}` +
        `\tquality=${row.quality}/${row.maxQuality}`,
    );
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(
    OUT_DIR,
    `transcript-repair-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        models,
        fixtures: FIXTURES,
        results,
        summary,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${outFile}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
