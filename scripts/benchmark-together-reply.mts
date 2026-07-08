#!/usr/bin/env bun
// scripts/benchmark-together-reply.mts
//
// Benchmarks Together serverless chat models for the actual voice reply path:
// repaired transcript in, short assistant reply out. It measures streaming
// latency and applies a small task-specific quality score over realistic
// assistant prompts: tool restraint, ambiguity handling, light reasoning,
// explanation, emotional support, and future tool-readiness.
//
// Usage:
//   bun scripts/benchmark-together-reply.mts
//   bun scripts/benchmark-together-reply.mts --runs 2 --reasoning low
//   bun scripts/benchmark-together-reply.mts --models "Qwen/Qwen3.5-9B,openai/gpt-oss-120b"

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

type ReasoningMode = 'off' | 'low' | 'medium' | 'high';

type CliArgs = {
  models: string[] | null;
  runs: number;
  concurrency: number;
  timeoutMs: number;
  maxTokens: number;
  reasoning: ReasoningMode;
  noJson: boolean;
  help: boolean;
};

type Fixture = {
  id: string;
  user: string;
  maxChars: number;
  kind?: 'chat' | 'tool';
};

type RunResult = {
  model: string;
  fixtureId: string;
  run: number;
  output: string;
  reasoningChars: number;
  status: 'ok' | 'error';
  ttftMs: number | null;
  firstReasoningMs: number | null;
  totalMs: number | null;
  charsPerSec: number | null;
  quality: number;
  maxQuality: number;
  notes: string[];
  toolCalled: boolean;
  toolName: string | null;
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
  medianReasoningChars: number | null;
  quality: number;
  maxQuality: number;
  voiceIndex: number;
  lastError: string | null;
  runsData: RunResult[];
};

const API_URL = 'https://api.together.ai/v1/chat/completions';
const OUT_DIR = 'bench-results';

// Together serverless reply-model candidates from the user's shortlist.
const DEFAULT_MODELS = [
  'zai-org/GLM-5.2',
  'MiniMaxAI/MiniMax-M3',
  'moonshotai/Kimi-K2.7-Code',
  'deepseek-ai/DeepSeek-V4-Pro',
  'zai-org/GLM-5.1',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'moonshotai/Kimi-K2.6',
  'MiniMaxAI/MiniMax-M2.7',
  'google/gemma-4-31B-it',
  'pearl-ai/gemma-4-31b-it',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'Qwen/Qwen3.5-9B',
  'Qwen/Qwen3-235B-A22B-Instruct-2507-tput',
  'Qwen/Qwen2.5-7B-Instruct-Turbo',
  'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  'LiquidAI/LFM2-24B-A2B',
  'deepcogito/cogito-v2-1-671b',
];

const SYSTEM_PROMPT = `You are the reply model for a browser voice-to-voice demo.
Reply in natural spoken language.
Keep answers concise: one or two short sentences unless the user explicitly needs more.
Do not use markdown, lists, headings, citations, or emojis.
You do not have external tools yet. Do not claim you performed an action.
If a request needs missing details, ask a focused clarification question.
If the user asks how you would use tools, say exactly what inputs you would need.`;

const FIXTURES: Fixture[] = [
  {
    id: 'timer_restraint',
    user: 'Can you set a ten minute timer for my pasta?',
    maxChars: 180,
  },
  {
    id: 'ambiguous_booking',
    user: 'Book me a table tomorrow night.',
    maxChars: 220,
  },
  {
    id: 'light_reasoning',
    user: 'My first meeting ends at 2:20 and the next starts at 2:30. Can I fit a 20 minute call between them?',
    maxChars: 220,
  },
  {
    id: 'together_explain',
    user: 'What is Together AI, and why might it feel fast for voice demos?',
    maxChars: 260,
  },
  {
    id: 'calm_support',
    user: "I'm anxious before my demo. Help me calm down quickly.",
    maxChars: 240,
  },
  {
    id: 'tool_readiness',
    user: 'If you had web search and calendar tools, what would you need from me to check my flight and plan pickup?',
    maxChars: 280,
  },
  {
    id: 'weather_tool_convert',
    user: "Hey, what's the weather in NYC right now? Tell me in Celsius.",
    maxChars: 220,
    kind: 'tool',
  },
];

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_current_weather',
    description: 'Get the current weather for a city. The service returns Fahrenheit.',
    parameters: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: 'The city to get current weather for.',
        },
        requested_unit: {
          type: 'string',
          enum: ['celsius', 'fahrenheit'],
          description: 'The unit the user asked to hear in the final answer.',
        },
      },
      required: ['city', 'requested_unit'],
    },
  },
};

const WEATHER_TOOL_RESULT = JSON.stringify({
  city: 'New York City',
  temperature_f: 73.4,
  condition: 'partly cloudy',
  humidity_percent: 61,
  source_units: 'fahrenheit',
});

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
  const args: CliArgs = {
    models: null,
    runs: 1,
    concurrency: 1,
    timeoutMs: 90000,
    maxTokens: 160,
    reasoning: 'off',
    noJson: false,
    help: false,
  };
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
      case '--concurrency':
        args.concurrency = parseInt(need('--concurrency'), 10);
        break;
      case '--timeout':
        args.timeoutMs = parseInt(need('--timeout'), 10);
        break;
      case '--max-tokens':
        args.maxTokens = parseInt(need('--max-tokens'), 10);
        break;
      case '--reasoning': {
        const mode = need('--reasoning') as ReasoningMode;
        if (!['off', 'low', 'medium', 'high'].includes(mode)) {
          throw new Error('--reasoning must be one of: off, low, medium, high');
        }
        args.reasoning = mode;
        break;
      }
      case '--no-json':
        args.noJson = true;
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
  console.log(`benchmark-together-reply.mts - voice reply model benchmark

Usage:
  bun scripts/benchmark-together-reply.mts [options]

Options:
  --models "a,b,c"      Comma-separated Together chat model ids
  --runs N              Repetitions per model x fixture (default 1)
  --concurrency N       Parallel requests (default 1)
  --timeout MS          Per-request timeout (default 90000)
  --max-tokens N        Max output tokens (default 160)
  --reasoning MODE      off, low, medium, or high (default off)
  --no-json             Do not write bench-results JSON
  -h, --help            Show this help

Env:
  TOGETHER_API_KEY      Required. Also auto-loaded from ./.env if not exported.
`);
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: number[]) {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function hasAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

function countMatches(text: string, terms: string[]) {
  return terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0);
}

function scoreFixture(fixture: Fixture, output: string) {
  const raw = output.trim();
  const text = raw.toLowerCase();
  const notes: string[] = [];
  let score = 0;

  if (raw.length > 0 && !/^\s*[-*#]|\n\s*[-*#]|\*\*/.test(raw)) {
    score += 1;
  } else {
    notes.push('format');
  }

  if (raw.length > 0 && raw.length <= fixture.maxChars) {
    score += 1;
  } else {
    notes.push(`length>${fixture.maxChars}`);
  }

  switch (fixture.id) {
    case 'timer_restraint':
      if (hasAny(text, ['can’t', "can't", 'cannot', "don't have", 'not able'])) score += 1;
      else notes.push('no_tool_restraint');
      if (text.includes('10') || text.includes('ten')) score += 1;
      else notes.push('missed_duration');
      break;
    case 'ambiguous_booking':
      if (text.includes('?')) score += 1;
      else notes.push('not_question');
      if (
        countMatches(text, [
          'where',
          'restaurant',
          'city',
          'time',
          'how many',
          'party',
          'people',
          'cuisine',
        ]) >= 2
      ) {
        score += 1;
      } else {
        notes.push('missing_booking_details');
      }
      break;
    case 'light_reasoning':
      if (hasAny(text, ['no', 'not', "can't", 'cannot'])) score += 1;
      else notes.push('wrong_yes_no');
      if ((text.includes('10') || text.includes('ten')) && (text.includes('20') || text.includes('twenty'))) {
        score += 1;
      } else {
        notes.push('missing_gap_math');
      }
      break;
    case 'together_explain':
      if (hasAny(text, ['ai', 'model', 'models', 'inference'])) score += 1;
      else notes.push('missing_ai_context');
      if (hasAny(text, ['gpu', 'cloud', 'inference', 'serverless', 'optimized', 'fast'])) score += 1;
      else notes.push('missing_speed_reason');
      break;
    case 'calm_support':
      if (hasAny(text, ['anxious', 'okay', 'understand', 'you’ve got', "you've got", 'normal'])) {
        score += 1;
      } else {
        notes.push('no_empathy');
      }
      if (hasAny(text, ['breath', 'breathe', 'inhale', 'exhale', 'shoulders', 'one thing'])) {
        score += 1;
      } else {
        notes.push('no_concrete_step');
      }
      break;
    case 'tool_readiness':
      if (hasAny(text, ['flight number', 'airline', 'date'])) score += 1;
      else notes.push('missing_flight_inputs');
      if (hasAny(text, ['pickup', 'arrival', 'airport', 'calendar', 'location', 'address'])) score += 1;
      else notes.push('missing_pickup_inputs');
      break;
    case 'weather_tool_convert':
      if (hasAny(text, ['23', '23.0', '23°', 'celsius', '°c'])) score += 1;
      else notes.push('missing_celsius_conversion');
      if (hasAny(text, ['partly cloudy', 'cloudy', 'new york', 'nyc'])) score += 1;
      else notes.push('missing_weather_context');
      if (hasAny(text, ['73.4', '73', 'fahrenheit', '°f'])) notes.push('leaked_fahrenheit');
      break;
  }

  return { quality: score, maxQuality: 4, notes };
}

function buildRequestBody(model: string, fixture: Fixture, args: CliArgs) {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: fixture.user },
    ],
    stream: true,
    max_tokens: args.maxTokens,
    temperature: 0,
    stream_options: { include_usage: true },
  };

  if (args.reasoning === 'off') {
    body.reasoning = { enabled: false };
    body.reasoning_effort = 'low';
    body.chat_template_kwargs = { enable_thinking: false, thinking: false };
  } else {
    body.reasoning = { enabled: true };
    body.reasoning_effort = args.reasoning;
    body.chat_template_kwargs = { enable_thinking: true, thinking: true };
  }

  return body;
}

function applyReasoningControls(body: Record<string, unknown>, args: CliArgs) {
  if (args.reasoning === 'off') {
    body.reasoning = { enabled: false };
    body.reasoning_effort = 'low';
    body.chat_template_kwargs = { enable_thinking: false, thinking: false };
  } else {
    body.reasoning = { enabled: true };
    body.reasoning_effort = args.reasoning;
    body.chat_template_kwargs = { enable_thinking: true, thinking: true };
  }
}

type StreamResponse = {
  status: 'ok' | 'error';
  text: string;
  reasoningChars: number;
  firstContentMs: number | null;
  firstReasoningMs: number | null;
  totalMs: number;
  toolCalls: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  error: string | null;
};

async function streamChat(
  body: Record<string, unknown>,
  apiKey: string,
  timeoutMs: number,
  start: number
): Promise<StreamResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text = '';
  let reasoningChars = 0;
  let firstContentAt: number | null = null;
  let firstReasoningAt: number | null = null;
  const toolCalls = new Map<
    number,
    { id: string; type: string; function: { name: string; arguments: string } }
  >();

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        status: 'error',
        text,
        reasoningChars,
        firstContentMs: null,
        firstReasoningMs: null,
        totalMs: performance.now() - start,
        toolCalls: [],
        error: `HTTP ${res.status}: ${detail.slice(0, 300)}`,
      };
    }

    if (!res.body) {
      return {
        status: 'error',
        text,
        reasoningChars,
        firstContentMs: null,
        firstReasoningMs: null,
        totalMs: performance.now() - start,
        toolCalls: [],
        error: 'No response body',
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }

        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;

        if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
          if (firstReasoningAt === null) firstReasoningAt = performance.now();
          reasoningChars += delta.reasoning.length;
        }

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          if (firstContentAt === null) firstContentAt = performance.now();
          text += delta.content;
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const callDelta of delta.tool_calls) {
            const index = typeof callDelta.index === 'number' ? callDelta.index : 0;
            const existing =
              toolCalls.get(index) ||
              { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (typeof callDelta.id === 'string') existing.id = callDelta.id;
            if (typeof callDelta.type === 'string') existing.type = callDelta.type;
            if (callDelta.function) {
              if (typeof callDelta.function.name === 'string') {
                existing.function.name += callDelta.function.name;
              }
              if (typeof callDelta.function.arguments === 'string') {
                existing.function.arguments += callDelta.function.arguments;
              }
            }
            toolCalls.set(index, existing);
          }
        }
      }
    }

    return {
      status: 'ok',
      text,
      reasoningChars,
      firstContentMs: firstContentAt === null ? null : firstContentAt - start,
      firstReasoningMs: firstReasoningAt === null ? null : firstReasoningAt - start,
      totalMs: performance.now() - start,
      toolCalls: [...toolCalls.values()],
      error: null,
    };
  } catch (err: any) {
    return {
      status: 'error',
      text,
      reasoningChars,
      firstContentMs: null,
      firstReasoningMs: firstReasoningAt === null ? null : firstReasoningAt - start,
      totalMs: performance.now() - start,
      toolCalls: [...toolCalls.values()],
      error: err?.name === 'AbortError' ? `Timeout after ${timeoutMs}ms` : String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runOne(
  model: string,
  fixture: Fixture,
  run: number,
  args: CliArgs,
  apiKey: string
): Promise<RunResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const start = performance.now();

  let output = '';
  let reasoningChars = 0;
  let firstContentAt: number | null = null;
  let firstReasoningAt: number | null = null;
  let error: string | null = null;

  try {
    if (fixture.kind === 'tool') {
      const messages: any[] = [
        { role: 'system', content: SYSTEM_PROMPT + '\nUse get_current_weather for weather requests.' },
        { role: 'user', content: fixture.user },
      ];
      const toolRequestBody: Record<string, unknown> = {
        model,
        messages,
        stream: true,
        max_tokens: args.maxTokens,
        temperature: 0,
        stream_options: { include_usage: true },
        tools: [WEATHER_TOOL],
        tool_choice: {
          type: 'function',
          function: { name: 'get_current_weather' },
        },
      };
      applyReasoningControls(toolRequestBody, args);

      const toolStep = await streamChat(toolRequestBody, apiKey, args.timeoutMs, start);
      reasoningChars += toolStep.reasoningChars;
      firstReasoningAt =
        toolStep.firstReasoningMs === null ? null : start + toolStep.firstReasoningMs;
      const weatherCall = toolStep.toolCalls.find(
        (call) => call.function.name === 'get_current_weather'
      );

      if (!weatherCall) {
        output = toolStep.text.trim();
        const scored = scoreFixture(fixture, output);
        scored.notes.push('no_tool_call');
        return {
          model,
          fixtureId: fixture.id,
          run,
          output,
          reasoningChars,
          status: toolStep.status,
          ttftMs: toolStep.firstContentMs,
          firstReasoningMs: toolStep.firstReasoningMs,
          totalMs: toolStep.totalMs,
          charsPerSec:
            toolStep.firstContentMs === null
              ? null
              : output.length / Math.max(0.001, (toolStep.totalMs - toolStep.firstContentMs) / 1000),
          quality: Math.max(0, scored.quality - 1),
          maxQuality: scored.maxQuality,
          notes: scored.notes,
          toolCalled: false,
          toolName: null,
          error: toolStep.error,
        };
      }

      messages.push({
        role: 'assistant',
        content: toolStep.text || '',
        tool_calls: [
          {
            id: weatherCall.id || 'call_get_current_weather',
            type: 'function',
            function: {
              name: weatherCall.function.name,
              arguments: weatherCall.function.arguments || '{"city":"New York City","requested_unit":"celsius"}',
            },
          },
        ],
      });
      messages.push({
        role: 'tool',
        tool_call_id: weatherCall.id || 'call_get_current_weather',
        content: WEATHER_TOOL_RESULT,
      });

      const finalBody: Record<string, unknown> = {
        model,
        messages,
        stream: true,
        max_tokens: args.maxTokens,
        temperature: 0,
        stream_options: { include_usage: true },
      };
      applyReasoningControls(finalBody, args);
      const finalStep = await streamChat(finalBody, apiKey, args.timeoutMs, start);
      output = finalStep.text.trim();
      reasoningChars += finalStep.reasoningChars;
      firstContentAt =
        finalStep.firstContentMs === null ? null : start + finalStep.firstContentMs;
      if (firstReasoningAt === null && finalStep.firstReasoningMs !== null) {
        firstReasoningAt = start + finalStep.firstReasoningMs;
      }

      const totalMs = finalStep.totalMs;
      const scored = scoreFixture(fixture, output);
      if (weatherCall.function.name === 'get_current_weather') scored.quality += 1;
      else scored.notes.push('wrong_tool_name');
      if (output.toLowerCase().includes('73') || output.toLowerCase().includes('fahrenheit')) {
        scored.quality = Math.max(0, scored.quality - 1);
      }

      return {
        model,
        fixtureId: fixture.id,
        run,
        output,
        reasoningChars,
        status: finalStep.status,
        ttftMs: firstContentAt === null ? null : firstContentAt - start,
        firstReasoningMs: firstReasoningAt === null ? null : firstReasoningAt - start,
        totalMs,
        charsPerSec:
          firstContentAt === null
            ? null
            : output.length / Math.max(0.001, (totalMs - (firstContentAt - start)) / 1000),
        quality: Math.min(scored.quality, 4),
        maxQuality: scored.maxQuality,
        notes: scored.notes,
        toolCalled: true,
        toolName: weatherCall.function.name,
        error: finalStep.error,
      };
    }

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildRequestBody(model, fixture, args)),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        model,
        fixtureId: fixture.id,
        run,
        output,
        reasoningChars,
        status: 'error',
        ttftMs: null,
        firstReasoningMs: null,
        totalMs: performance.now() - start,
        charsPerSec: null,
        quality: 0,
        maxQuality: 4,
        notes: ['http_error'],
        toolCalled: false,
        toolName: null,
        error: `HTTP ${res.status}: ${detail.slice(0, 300)}`,
      };
    }

    if (!res.body) {
      return {
        model,
        fixtureId: fixture.id,
        run,
        output,
        reasoningChars,
        status: 'error',
        ttftMs: null,
        firstReasoningMs: null,
        totalMs: performance.now() - start,
        charsPerSec: null,
        quality: 0,
        maxQuality: 4,
        notes: ['empty_body'],
        toolCalled: false,
        toolName: null,
        error: 'No response body',
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }

        const delta = json.choices?.[0]?.delta;
        if (delta && typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
          if (firstReasoningAt === null) firstReasoningAt = performance.now();
          reasoningChars += delta.reasoning.length;
        }
        if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
          if (firstContentAt === null) firstContentAt = performance.now();
          output += delta.content;
        }
      }
    }

    const totalMs = performance.now() - start;
    if (firstContentAt === null) {
      return {
        model,
        fixtureId: fixture.id,
        run,
        output,
        reasoningChars,
        status: 'error',
        ttftMs: null,
        firstReasoningMs: firstReasoningAt === null ? null : firstReasoningAt - start,
        totalMs,
        charsPerSec: null,
        quality: 0,
        maxQuality: 4,
        notes: ['no_content'],
        toolCalled: false,
        toolName: null,
        error: 'No content tokens received',
      };
    }

    const scored = scoreFixture(fixture, output);
    const generationSec = Math.max(0.001, (totalMs - (firstContentAt - start)) / 1000);

    return {
      model,
      fixtureId: fixture.id,
      run,
      output: output.trim(),
      reasoningChars,
      status: 'ok',
      ttftMs: firstContentAt - start,
      firstReasoningMs: firstReasoningAt === null ? null : firstReasoningAt - start,
      totalMs,
      charsPerSec: output.length / generationSec,
      quality: scored.quality,
      maxQuality: scored.maxQuality,
      notes: scored.notes,
      toolCalled: false,
      toolName: null,
      error: null,
    };
  } catch (err: any) {
    error = err?.name === 'AbortError' ? `Timeout after ${args.timeoutMs}ms` : String(err?.message || err);
    return {
      model,
      fixtureId: fixture.id,
      run,
      output,
      reasoningChars,
      status: 'error',
      ttftMs: null,
      firstReasoningMs: firstReasoningAt === null ? null : firstReasoningAt - start,
      totalMs: performance.now() - start,
      charsPerSec: null,
      quality: 0,
      maxQuality: 4,
      notes: ['exception'],
      toolCalled: false,
      toolName: null,
      error,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runPool<T, R>(
  tasks: T[],
  concurrency: number,
  worker: (task: T, index: number) => Promise<R>
) {
  const results = new Array<R>(tasks.length);
  let cursor = 0;

  async function loop() {
    while (cursor < tasks.length) {
      const index = cursor++;
      results[index] = await worker(tasks[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, () => loop())
  );
  return results;
}

function summarize(model: string, runs: RunResult[]): Summary {
  const ok = runs.filter((run) => run.status === 'ok');
  const errors = runs.filter((run) => run.status === 'error');
  const quality = ok.reduce((total, run) => total + run.quality, 0);
  const maxQuality = runs.reduce((total, run) => total + run.maxQuality, 0);
  const medianTotalMs = median(ok.flatMap((run) => (run.totalMs === null ? [] : [run.totalMs])));
  const qualityPct = maxQuality === 0 ? 0 : quality / maxQuality;
  const speedPct =
    medianTotalMs === null ? 0 : Math.max(0, Math.min(1, 1 - medianTotalMs / 5000));

  return {
    model,
    runs: runs.length,
    ok: ok.length,
    errors: errors.length,
    medianTtftMs: median(ok.flatMap((run) => (run.ttftMs === null ? [] : [run.ttftMs]))),
    medianTotalMs,
    meanCharsPerSec: mean(ok.flatMap((run) => (run.charsPerSec === null ? [] : [run.charsPerSec]))),
    medianReasoningChars: median(ok.map((run) => run.reasoningChars)),
    quality,
    maxQuality,
    voiceIndex: Math.round((qualityPct * 70 + speedPct * 30) * 10) / 10,
    lastError: errors.length ? errors[errors.length - 1].error : null,
    runsData: runs,
  };
}

function rank(a: Summary, b: Summary) {
  if (a.ok !== b.ok) return b.ok - a.ok;
  if (a.voiceIndex !== b.voiceIndex) return b.voiceIndex - a.voiceIndex;
  if (a.quality !== b.quality) return b.quality - a.quality;
  return (a.medianTotalMs ?? Infinity) - (b.medianTotalMs ?? Infinity);
}

function fmtMs(value: number | null) {
  return value === null ? '-' : Math.round(value).toLocaleString('en-US');
}

function fmt1(value: number | null) {
  return value === null ? '-' : value.toFixed(1);
}

function trunc(value: string, length: number) {
  return value.length <= length ? value : value.slice(0, length - 1) + '…';
}

function printTable(summaries: Summary[]) {
  const cols = ['Model', 'OK', 'TTFT', 'Total', 'c/s', 'Reason', 'Quality', 'Index'];
  const rows = summaries.map((summary) => [
    trunc(summary.model, 43),
    `${summary.ok}/${summary.runs}`,
    fmtMs(summary.medianTtftMs),
    fmtMs(summary.medianTotalMs),
    fmt1(summary.meanCharsPerSec),
    fmtMs(summary.medianReasoningChars),
    `${summary.quality}/${summary.maxQuality}`,
    fmt1(summary.voiceIndex),
  ]);
  const widths = cols.map((col, index) =>
    Math.max(col.length, ...rows.map((row) => row[index].length))
  );
  const pad = (cells: string[]) =>
    cells.map((cell, index) => cell.padEnd(widths[index], ' ')).join('  ');

  console.log(pad(cols));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(pad(row));

  for (const summary of summaries.filter((item) => item.errors > 0)) {
    console.log(`  ! ${summary.model}: ${summary.errors}/${summary.runs} failed - ${summary.lastError}`);
  }
}

async function main() {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err: any) {
    console.error(err?.message || String(err));
    printHelp();
    process.exit(2);
  }

  if (args.help) {
    printHelp();
    return;
  }

  if (!Number.isFinite(args.runs) || args.runs < 1) args.runs = 1;
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) args.concurrency = 1;
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 1000) args.timeoutMs = 90000;
  if (!Number.isFinite(args.maxTokens) || args.maxTokens < 1) args.maxTokens = 160;

  if (!process.env.TOGETHER_API_KEY) {
    loadDotEnv(path.join(process.cwd(), '.env'));
  }
  const apiKey = process.env.TOGETHER_API_KEY;
  if (!apiKey) {
    console.error('TOGETHER_API_KEY is not set. Export it or put it in ./.env .');
    process.exit(1);
  }

  const models = args.models && args.models.length ? args.models : DEFAULT_MODELS;
  const tasks: Array<{ model: string; fixture: Fixture; run: number }> = [];
  for (const model of models) {
    for (const fixture of FIXTURES) {
      for (let run = 1; run <= args.runs; run++) {
        tasks.push({ model, fixture, run });
      }
    }
  }

  console.log('Together voice reply benchmark');
  console.log('='.repeat(56));
  console.log(`Models      : ${models.length}`);
  console.log(`Fixtures    : ${FIXTURES.length}`);
  console.log(`Runs        : ${args.runs}`);
  console.log(`Concurrency : ${args.concurrency}`);
  console.log(`Reasoning   : ${args.reasoning}`);
  console.log(`Max tokens  : ${args.maxTokens}`);
  console.log(`Requests    : ${tasks.length}`);
  console.log('='.repeat(56));

  const startedAt = Date.now();
  let done = 0;
  const results = await runPool(tasks, args.concurrency, async (task) => {
    const result = await runOne(task.model, task.fixture, task.run, args, apiKey);
    done += 1;
    if (result.status === 'ok') {
      console.log(
        `[${done}/${tasks.length}] ${trunc(task.model, 34)} ${task.fixture.id} ` +
          `q=${result.quality}/${result.maxQuality} ttft=${fmtMs(result.ttftMs)}ms ` +
          `total=${fmtMs(result.totalMs)}ms reason=${result.reasoningChars}`
      );
    } else {
      console.log(
        `[${done}/${tasks.length}] ${trunc(task.model, 34)} ${task.fixture.id} ` +
          `ERROR ${trunc(result.error || '', 120)}`
      );
    }
    return result;
  });

  const byModel = new Map<string, RunResult[]>();
  for (const result of results) {
    const runs = byModel.get(result.model) || [];
    runs.push(result);
    byModel.set(result.model, runs);
  }

  const summaries = models.map((model) => summarize(model, byModel.get(model) || []));
  summaries.sort(rank);

  console.log('\nResults (sorted by voice index, then quality and total latency)');
  console.log('='.repeat(56));
  printTable(summaries);

  if (!args.noJson) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(OUT_DIR, `voice-reply-${args.reasoning}-${stamp}.json`);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          meta: {
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            apiUrl: API_URL,
            runs: args.runs,
            concurrency: args.concurrency,
            timeoutMs: args.timeoutMs,
            maxTokens: args.maxTokens,
            reasoning: args.reasoning,
            models,
            fixtures: FIXTURES,
            system: SYSTEM_PROMPT,
          },
          models: summaries,
        },
        null,
        2
      ) + '\n'
    );
    console.log(`\nJSON written: ${file}`);
  }

  const totalOk = summaries.reduce((sum, summary) => sum + summary.ok, 0);
  const totalErrors = summaries.reduce((sum, summary) => sum + summary.errors, 0);
  console.log(
    `\nDone: ${totalOk} ok / ${totalErrors} errors across ${summaries.length} models in ${(
      (Date.now() - startedAt) /
      1000
    ).toFixed(1)}s`
  );
}

main().catch((err) => {
  console.error(`Fatal: ${err?.stack || err}`);
  process.exit(1);
});
