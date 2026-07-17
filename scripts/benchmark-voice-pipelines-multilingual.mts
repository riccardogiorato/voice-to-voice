#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";

type Pipeline = "classic" | "inkling";
type Metric = "wer" | "cer";

type Fixture = {
  language: string;
  label: string;
  metric: Metric;
  text: string;
  voice: string;
};

type E2eResult = {
  meta: { language: string; pipeline: Pipeline };
  metrics: {
    firstAudioMs: number | null;
    sttMs: number | null;
    totalMs: number | null;
    transcriptErrorRate: number;
    transcriptMetric: Metric;
  };
  transcript: string;
  assistantText: string;
  pass: boolean;
  serverError: string | null;
};

const TTS_ENDPOINT = "https://api.together.ai/v1/audio/speech";
const TTS_MODEL = "cartesia/sonic-3";
const SAMPLE_RATE = 16_000;

// One matched semantic prompt per language. The subject is deliberately stable
// so the Classic tool loop does not add web-search latency to only one path.
const FIXTURES: Fixture[] = [
  {
    language: "en",
    label: "English",
    metric: "wer",
    text: "Hello, tell me one short fact about the moon.",
    voice: "nonfiction man",
  },
  {
    language: "it",
    label: "Italian",
    metric: "wer",
    text: "Ciao, dimmi un breve fatto sulla Luna.",
    voice: "italian calm man",
  },
  {
    language: "es",
    label: "Spanish",
    metric: "wer",
    text: "Hola, dime un dato breve sobre la Luna.",
    voice: "spanish narrator man",
  },
  {
    language: "fr",
    label: "French",
    metric: "wer",
    text: "Bonjour, donne-moi un fait court sur la Lune.",
    voice: "friendly french man",
  },
  {
    language: "de",
    label: "German",
    metric: "wer",
    text: "Hallo, nenne mir eine kurze Tatsache über den Mond.",
    voice: "friendly german man",
  },
  {
    language: "pt",
    label: "Portuguese",
    metric: "wer",
    text: "Olá, diga-me um fato breve sobre a Lua.",
    voice: "brazilian young man",
  },
  {
    language: "nl",
    label: "Dutch",
    metric: "wer",
    text: "Hallo, vertel me één kort feit over de maan.",
    voice: "dutch man",
  },
  {
    language: "pl",
    label: "Polish",
    metric: "wer",
    text: "Cześć, powiedz mi krótki fakt o Księżycu.",
    voice: "polish confident man",
  },
  {
    language: "zh",
    label: "Chinese",
    metric: "cer",
    text: "你好，请告诉我一个关于月球的简短事实。",
    voice: "chinese commercial man",
  },
  {
    language: "ja",
    label: "Japanese",
    metric: "cer",
    text: "こんにちは、月について短い事実を一つ教えてください。",
    voice: "japanese male conversational",
  },
];

async function main() {
  const targetUrl = process.argv[2];
  if (!targetUrl) {
    throw new Error(
      "Usage: bun scripts/benchmark-voice-pipelines-multilingual.mts <deployed-url>",
    );
  }
  const apiKey = process.env.TOGETHER_API_KEY?.trim();
  if (!apiKey) throw new Error("TOGETHER_API_KEY is required.");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.join(
    "bench-results",
    `voice-pipelines-multilingual-${stamp}`,
  );
  fs.mkdirSync(outputDir, { recursive: true });

  console.log("Preparing ten language-matched audio fixtures...");
  const prepared = [];
  for (const fixture of FIXTURES) {
    prepared.push({ fixture, pcmPath: await ensureFixture(fixture, apiKey) });
  }

  const results: E2eResult[] = [];
  for (let index = 0; index < prepared.length; index += 1) {
    const { fixture, pcmPath } = prepared[index];
    // Balance ordering across pairs so one pipeline is not always the warm run.
    const pipelines: Pipeline[] =
      index % 2 === 0 ? ["classic", "inkling"] : ["inkling", "classic"];

    for (const pipeline of pipelines) {
      const outputPath = path.join(outputDir, `${fixture.language}-${pipeline}.json`);
      console.log(
        `[${index + 1}/${prepared.length}] ${fixture.label.padEnd(10)} ${pipeline}`,
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "scripts/e2e-voice-latency.mjs",
          targetUrl,
          "--pipeline",
          pipeline,
          "--fixture",
          pcmPath,
          "--language",
          fixture.language,
          "--expected",
          fixture.text,
          "--output",
          outputPath,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            BUDGET_STT_MS: process.env.BUDGET_STT_MS ?? "8000",
            BUDGET_FIRST_AUDIO_MS:
              process.env.BUDGET_FIRST_AUDIO_MS ?? "12000",
            BUDGET_TOTAL_MS: process.env.BUDGET_TOTAL_MS ?? "30000",
          },
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      if (fs.existsSync(outputPath)) {
        const result = JSON.parse(fs.readFileSync(outputPath, "utf8")) as E2eResult;
        results.push(result);
        console.log(formatResult(result));
      } else {
        console.error(stdout.trim());
        console.error(stderr.trim());
        throw new Error(
          `${fixture.label} ${pipeline} produced no result (exit ${exitCode}).`,
        );
      }
    }
  }

  const payload = buildAggregatePayload(targetUrl, results);
  const aggregatePath = path.join(outputDir, "results.json");
  fs.writeFileSync(aggregatePath, `${JSON.stringify(payload, null, 2)}\n`);
  printSummary(payload);
  console.log(`\nJSON written: ${aggregatePath}`);
}

async function ensureFixture(fixture: Fixture, apiKey: string) {
  const pcmPath = path.join(
    "test-fixtures",
    `voice-paired-${fixture.language}.pcm`,
  );
  const metaPath = `${pcmPath}.json`;
  const meta = readJson(metaPath);
  if (
    fs.existsSync(pcmPath) &&
    meta?.text === fixture.text &&
    meta?.voice === fixture.voice &&
    meta?.model === TTS_MODEL &&
    meta?.sampleRate === SAMPLE_RATE
  ) {
    return pcmPath;
  }

  const response = await fetch(TTS_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: fixture.text,
      voice: fixture.voice,
      language: fixture.language,
      response_format: "raw",
      response_encoding: "pcm_s16le",
      sample_rate: SAMPLE_RATE,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `TTS fixture ${fixture.language} failed (${response.status}): ${detail.slice(0, 300)}`,
    );
  }

  const pcm = Buffer.from(await response.arrayBuffer());
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new Error(`TTS fixture ${fixture.language} returned invalid PCM16.`);
  }
  fs.mkdirSync(path.dirname(pcmPath), { recursive: true });
  fs.writeFileSync(pcmPath, pcm);
  fs.writeFileSync(wavPath(pcmPath), buildWav(pcm));
  fs.writeFileSync(
    metaPath,
    `${JSON.stringify(
      {
        language: fixture.language,
        label: fixture.label,
        metric: fixture.metric,
        text: fixture.text,
        model: TTS_MODEL,
        voice: fixture.voice,
        sampleRate: SAMPLE_RATE,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `  ${fixture.label.padEnd(10)} ${Math.round(pcm.byteLength / 32) / 1000}s (${fixture.voice})`,
  );
  return pcmPath;
}

function buildAggregatePayload(targetUrl: string, results: E2eResult[]) {
  const byLanguage = FIXTURES.map((fixture) => ({
    language: fixture.language,
    label: fixture.label,
    expectedTranscript: fixture.text,
    metric: fixture.metric,
    classic: results.find(
      (result) =>
        result.meta.language === fixture.language &&
        result.meta.pipeline === "classic",
    ),
    inkling: results.find(
      (result) =>
        result.meta.language === fixture.language &&
        result.meta.pipeline === "inkling",
    ),
  }));

  return {
    meta: {
      timestamp: new Date().toISOString(),
      targetUrl,
      fixtureModel: TTS_MODEL,
      sampleRate: SAMPLE_RATE,
      languages: FIXTURES.map((fixture) => fixture.language),
      matchedPairs: FIXTURES.length,
      turns: results.length,
    },
    summary: {
      classic: summarize(results, "classic"),
      inkling: summarize(results, "inkling"),
    },
    byLanguage,
  };
}

function summarize(results: E2eResult[], pipeline: Pipeline) {
  const rows = results.filter((result) => result.meta.pipeline === pipeline);
  return {
    turns: rows.length,
    passed: rows.filter((row) => row.pass).length,
    meanTranscriptErrorRate: mean(
      rows.map((row) => row.metrics.transcriptErrorRate),
    ),
    medianTranscriptMs: median(rows.map((row) => row.metrics.sttMs)),
    medianFirstAudioMs: median(rows.map((row) => row.metrics.firstAudioMs)),
    medianTotalMs: median(rows.map((row) => row.metrics.totalMs)),
  };
}

function printSummary(payload: ReturnType<typeof buildAggregatePayload>) {
  console.log("\nMatched multilingual summary");
  console.log("pipeline  pass   mean error  transcript  first audio  total");
  console.log("--------  -----  ----------  ----------  -----------  -----");
  for (const pipeline of ["classic", "inkling"] as const) {
    const row = payload.summary[pipeline];
    console.log(
      `${pipeline.padEnd(8)}  ${`${row.passed}/${row.turns}`.padEnd(5)}  ${formatPercent(row.meanTranscriptErrorRate).padEnd(10)}  ${formatMs(row.medianTranscriptMs).padEnd(10)}  ${formatMs(row.medianFirstAudioMs).padEnd(11)}  ${formatMs(row.medianTotalMs)}`,
    );
  }
}

function formatResult(result: E2eResult) {
  return (
    `  transcript=${formatPercent(result.metrics.transcriptErrorRate)} ` +
    `text=${formatMs(result.metrics.sttMs)} ` +
    `audio=${formatMs(result.metrics.firstAudioMs)} ` +
    `total=${formatMs(result.metrics.totalMs)} ` +
    `${result.pass ? "PASS" : "FAIL"}`
  );
}

function formatMs(value: number | null) {
  return value == null ? "-" : `${Math.round(value)}ms`;
}

function formatPercent(value: number | null) {
  return value == null ? "-" : `${(value * 100).toFixed(1)}%`;
}

function median(values: Array<number | null>) {
  const sorted = values
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values: number[]) {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
}

function wavPath(pcmPath: string) {
  return pcmPath.replace(/\.pcm$/, ".wav");
}

function buildWav(pcm: Buffer) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
