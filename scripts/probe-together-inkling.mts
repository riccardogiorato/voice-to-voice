#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import {
  buildInklingAudioRequest,
  createInklingAudioCompletion,
  getTogetherModelAvailability,
  readPcmWavMetadata,
  TOGETHER_INKLING_MODEL,
} from "../app/api/voice/inkling";

type ProbeMode = "reply" | "transcribe";

type CliArgs = {
  audioPath: string | null;
  force: boolean;
  help: boolean;
  mode: ProbeMode;
  model: string;
};

const REPLY_INSTRUCTION =
  "Listen to the audio and answer the speaker's request directly. Reply in the same language as the speaker. Return only one or two concise, natural spoken sentences with no markdown.";
const TRANSCRIBE_INSTRUCTION =
  "Transcribe this speech exactly. Return only the transcript.";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const apiKey = process.env.TOGETHER_API_KEY?.trim();
  if (!apiKey) throw new Error("TOGETHER_API_KEY is required.");

  const availability = await getTogetherModelAvailability({
    apiKey,
    model: args.model,
  });
  if (!availability.available && !args.force) {
    console.log(`NOT LIVE: ${args.model} is absent from Together /v1/models.`);
    console.log("No inference request was sent. Re-run this probe after the serverless launch.");
    return;
  }

  if (availability.available) {
    console.log(`LIVE: ${args.model} is present in Together /v1/models.`);
  } else {
    console.log(`FORCED: ${args.model} is absent from the catalog; testing it anyway.`);
  }

  if (!args.audioPath) {
    console.log("Pass --audio /absolute/path/to/pcm16.wav to test audio input.");
    return;
  }

  const audioPath = path.resolve(args.audioPath);
  if (path.extname(audioPath).toLowerCase() !== ".wav") {
    throw new Error("The Inkling probe currently accepts PCM16 .wav files only.");
  }

  const wav = new Uint8Array(fs.readFileSync(audioPath));
  const metadata = readPcmWavMetadata(wav);
  const request = buildInklingAudioRequest({
    audio: {
      data: Buffer.from(wav).toString("base64"),
      format: "wav",
      numFrames: metadata.numFrames,
      sampleRate: metadata.sampleRate,
    },
    instruction:
      args.mode === "transcribe" ? TRANSCRIBE_INSTRUCTION : REPLY_INSTRUCTION,
    maxTokens: args.mode === "transcribe" ? 400 : 600,
    model: args.model,
  });

  const startedAt = performance.now();
  const content = await createInklingAudioCompletion({ apiKey, request });
  const elapsedMs = Math.round(performance.now() - startedAt);
  console.log(`MODE: ${args.mode}`);
  console.log(`AUDIO: ${metadata.numFrames} frames at ${metadata.sampleRate} Hz`);
  console.log(`TOTAL: ${elapsedMs} ms`);
  console.log(`OUTPUT: ${content}`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    audioPath: null,
    force: false,
    help: false,
    mode: "reply",
    model: process.env.TOGETHER_INKLING_MODEL?.trim() || TOGETHER_INKLING_MODEL,
  };
  const rest = [...argv];
  const need = (name: string) => {
    const value = rest.shift();
    if (!value) throw new Error(`Missing value for ${name}.`);
    return value;
  };

  while (rest.length > 0) {
    const arg = rest.shift();
    switch (arg) {
      case "--audio":
        args.audioPath = need("--audio");
        break;
      case "--force":
        args.force = true;
        break;
      case "--mode": {
        const mode = need("--mode");
        if (mode !== "reply" && mode !== "transcribe") {
          throw new Error("--mode must be reply or transcribe.");
        }
        args.mode = mode;
        break;
      }
      case "--model":
        args.model = need("--model");
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`probe-together-inkling.mts - check and sample Together Inkling

Usage:
  bun scripts/probe-together-inkling.mts
  bun scripts/probe-together-inkling.mts --audio ./sample.wav --mode reply

Options:
  --audio PATH            PCM16 WAV input; omit for a catalog-only check
  --mode MODE             reply or transcribe (default: reply)
  --model ID              Together model id (default: ${TOGETHER_INKLING_MODEL})
  --force                 Try inference even when the model is absent from /v1/models
  -h, --help              Show this help

Env:
  TOGETHER_API_KEY        Required; Bun loads it from .env
  TOGETHER_INKLING_MODEL  Optional model-id override
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
