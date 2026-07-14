import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import { DEMO_VOICE } from "../lib/voice.js";

const packageRoot = process.cwd();
const repoRoot = resolve(packageRoot, "../..");
try { process.loadEnvFile(resolve(repoRoot, ".env")); } catch {}

if (!process.env.TOGETHER_API_KEY) {
  throw new Error(
    "pnpm test:e2e requires TOGETHER_API_KEY (export it or add it to the repository .env). This is an explicit paid/network suite.",
  );
}

const port = Number.parseInt(process.env.E2E_PORT ?? "3210", 10);
const baseUrl = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`;
const websocketUrl = baseUrl.replace(/^http/, "ws") + "/api/realtime?model=together-realtime";
let server: ChildProcess | undefined;
const results: Array<{ name: string; durationMs: number; detail: Record<string, unknown> }> = [];

async function main() {
try {
  if (!process.env.E2E_BASE_URL) server = await startServer(port);
  await waitForServer(baseUrl);
  const audio = await loadFixtureAt24Khz();

  await run("manual PCM16 STT to reply to streamed TTS", async () => {
    const client = await BrowserLikeClient.connect(baseUrl, websocketUrl, {
      audio: { input: { turn_detection: null }, output: { voice: DEMO_VOICE } },
    });
    await client.waitFor("session.created");
    client.send({
      type: "session.update",
      session: {
        type: "realtime",
        model: "together-realtime",
        instructions: "Reply in one short sentence.",
        audio: {
          input: { format: { type: "audio/pcm", rate: 24000 }, transcription: null, turn_detection: null },
          output: { format: { type: "audio/pcm", rate: 24000 }, voice: DEMO_VOICE, speed: 1 },
        },
      },
    });
    await client.waitFor("session.updated");
    await client.streamAudio(audio, true);
    client.send({ type: "input_audio_buffer.commit" });
    client.send({ type: "response.create" });
    const done = await client.waitFor("response.done", 45_000);
    const types = client.events.map((event) => event.type);
    try {
      assertOrdered(types, [
        "input_audio_buffer.committed",
        "conversation.item.input_audio_transcription.completed",
        "response.created",
        "response.output_audio_transcript.delta",
        "response.output_audio.delta",
        "response.done",
      ]);
    } catch (error) {
      const providerErrors = client.events.filter((event) => event.type === "error");
      throw new Error(`${String(error)} Provider errors: ${JSON.stringify(providerErrors)}`);
    }
    const audioBytes = client.audioBytes();
    assert(audioBytes > 12_000, `Expected streamed TTS audio, received ${audioBytes} bytes.`);
    assert((done.response as Record<string, unknown>)?.status === "completed", "Manual response did not complete.");
    const transcript = client.last("conversation.item.input_audio_transcription.completed")?.transcript;
    client.close();
    return { transcript, audioBytes, eventCount: types.length };
  });

  await run("Together server VAD without manual commit", async () => {
    const client = await BrowserLikeClient.connect(baseUrl, websocketUrl, {
      audio: {
        input: {
          turn_detection: {
            type: "server_vad",
            create_response: true,
            interrupt_response: true,
            silence_duration_ms: 500,
          },
        },
        output: { voice: DEMO_VOICE },
      },
    });
    await client.waitFor("session.created");
    client.send({
      type: "session.update",
      session: {
        type: "realtime",
        model: "together-realtime",
        instructions: "Reply in one short sentence.",
        audio: {
          input: {
            transcription: null,
            turn_detection: {
              type: "server_vad",
              create_response: true,
              interrupt_response: true,
              silence_duration_ms: 500,
            },
          },
          output: { voice: DEMO_VOICE },
        },
      },
    });
    await client.waitFor("session.updated");
    await client.streamAudio(withTrailingSilence(audio, 900), true);
    await client.waitFor("input_audio_buffer.speech_started", 15_000);
    await client.waitFor("input_audio_buffer.speech_stopped", 15_000);
    await client.waitFor("response.done", 45_000);
    assert(!client.events.some((event) => event.type === "input_audio_buffer.committed"), "Server VAD unexpectedly required a client commit.");
    const audioBytes = client.audioBytes();
    assert(audioBytes > 12_000, "Server VAD response did not stream audio.");
    client.close();
    return { audioBytes, eventCount: client.events.length };
  });

  await run("client function tool and result resume", async () => {
    const client = await BrowserLikeClient.connect(baseUrl, websocketUrl, {});
    await client.waitFor("session.created");
    client.send({
      type: "session.update",
      session: {
        type: "realtime",
        model: "together-realtime",
        instructions: "Always call get_magic_number for this request, then state its result in one short sentence.",
        tools: [{
          type: "function",
          name: "get_magic_number",
          description: "Return the magic number.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        }],
        tool_choice: "required",
        audio: { input: { transcription: null, turn_detection: null }, output: { voice: DEMO_VOICE } },
      },
    });
    await client.waitFor("session.updated");
    client.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: "What is the magic number?" }] },
    });
    client.send({ type: "response.create" });
    const call = await client.waitFor("response.function_call_arguments.done", 45_000);
    assert(call.name === "get_magic_number", `Unexpected tool call: ${String(call.name)}`);
    client.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ number: 42 }) },
    });
    client.send({ type: "session.update", session: { tool_choice: "auto" } });
    await client.waitFor("session.updated");
    client.send({ type: "response.create" });
    await client.waitFor("response.output_audio.delta", 45_000);
    await client.waitFor("response.done", 45_000, 2);
    client.close();
    return { callId: call.call_id, audioBytes: client.audioBytes() };
  });

  await run("server-VAD barge-in cancels active output", async () => {
    const client = await BrowserLikeClient.connect(baseUrl, websocketUrl, {});
    await client.waitFor("session.created");
    client.send({
      type: "session.update",
      session: {
        type: "realtime",
        model: "together-realtime",
        instructions: "Give a long spoken answer of at least ten sentences.",
        audio: {
          input: { transcription: null, turn_detection: { type: "server_vad", create_response: true, interrupt_response: true } },
          output: { voice: DEMO_VOICE },
        },
      },
    });
    await client.waitFor("session.updated");
    client.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: "Explain the history of computing." }] },
    });
    client.send({ type: "response.create" });
    await client.waitFor("response.output_audio.delta", 45_000);
    await client.streamAudio(withTrailingSilence(audio, 600), true);
    await client.waitFor("input_audio_buffer.speech_started", 15_000);
    const cancelled = await client.waitForWhere(
      (event) => event.type === "response.done" && (event.response as Record<string, unknown>)?.status === "cancelled",
      15_000,
    );
    assert(Boolean(cancelled), "Barge-in did not cancel the active response.");
    client.close();
    return { cancelled: true };
  });

  await run("protocol errors remain nonfatal when state is valid", async () => {
    const client = await BrowserLikeClient.connect(baseUrl, websocketUrl, {});
    await client.waitFor("session.created");
    client.send({ type: "session.update", session: { model: "client-selected-model" } });
    const error = await client.waitFor("error");
    assert((error.error as Record<string, unknown>)?.code === "invalid_request_error", "Expected invalid_request_error.");
    client.send({ type: "session.update", session: { model: "together-realtime", instructions: "Still connected" } });
    await client.waitFor("session.updated");
    client.close();
    return { code: (error.error as Record<string, unknown>)?.code };
  });

  const report = { passed: results.length, baseUrl, testedAt: new Date().toISOString(), results };
  await mkdir(resolve(repoRoot, "e2e-results"), { recursive: true });
  const reportPath = resolve(repoRoot, "e2e-results", `realtime-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nPaid black-box suite passed (${results.length}/${results.length}).`);
  console.log(`Report: ${reportPath}`);
} finally {
  server?.kill("SIGTERM");
}
}

async function run(name: string, test: () => Promise<Record<string, unknown>>) {
  const started = Date.now();
  process.stdout.write(`\n[paid/network] ${name} ... `);
  const detail = await test();
  const durationMs = Date.now() - started;
  results.push({ name, durationMs, detail });
  console.log(`ok (${durationMs} ms)`);
}

class BrowserLikeClient {
  events: Record<string, unknown>[] = [];
  private waiters = new Set<() => void>();

  private constructor(private socket: WebSocket) {
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString()) as Record<string, unknown>;
      this.events.push(event);
      for (const notify of this.waiters) notify();
    });
  }

  static async connect(base: string, url: string, session: Record<string, unknown>) {
    const response = await fetch(`${base}/api/realtime/client_secrets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 180 }, session }),
    });
    if (!response.ok) throw new Error(`Client-secret request failed: ${response.status} ${await response.text()}`);
    const secret = (await response.json()) as { value: string };
    const socket = new WebSocket(url, ["realtime", `openai-insecure-api-key.${secret.value}`, "openai-beta.realtime-v1"]);
    await new Promise<void>((resolveOpen, reject) => {
      socket.once("open", resolveOpen);
      socket.once("error", reject);
    });
    return new BrowserLikeClient(socket);
  }

  send(event: Record<string, unknown>) { this.socket.send(JSON.stringify(event)); }
  close() { this.socket.close(); }
  last(type: string) { return [...this.events].reverse().find((event) => event.type === type); }
  audioBytes() {
    return this.events
      .filter((event) => event.type === "response.output_audio.delta" && typeof event.delta === "string")
      .reduce((total, event) => total + Buffer.from(event.delta as string, "base64").byteLength, 0);
  }

  async streamAudio(audio: Buffer, pace: boolean) {
    const chunkBytes = 24000 * 2 * 0.08;
    for (let offset = 0; offset < audio.length; offset += chunkBytes) {
      this.send({ type: "input_audio_buffer.append", audio: audio.subarray(offset, offset + chunkBytes).toString("base64") });
      if (pace) await delay(80);
    }
  }

  waitFor(type: string, timeoutMs = 10_000, occurrence = 1) {
    return this.waitForWhere((event) => event.type === type, timeoutMs, occurrence);
  }

  async waitForWhere(
    predicate: (event: Record<string, unknown>) => boolean,
    timeoutMs: number,
    occurrence = 1,
  ) {
    const find = () => this.events.filter(predicate)[occurrence - 1];
    const existing = find();
    if (existing) return existing;
    return new Promise<Record<string, unknown>>((resolveEvent, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`Timed out after ${timeoutMs} ms. Last events: ${this.events.slice(-8).map((event) => event.type).join(", ")}`));
      }, timeoutMs);
      const check = () => {
        const event = find();
        if (!event) return;
        clearTimeout(timeout);
        this.waiters.delete(check);
        resolveEvent(event);
      };
      this.waiters.add(check);
    });
  }
}

async function startServer(serverPort: number) {
  const child = spawn("pnpm", ["exec", "tsx", "server.ts"], {
    cwd: packageRoot,
    env: { ...process.env, PORT: String(serverPort), NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[demo] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[demo] ${chunk}`));
  child.once("exit", (code) => {
    if (code && code !== 0) console.error(`Demo server exited with code ${code}.`);
  });
  return child;
}

async function waitForServer(url: string) {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    try {
      const response = await fetch(`${url}/api/realtime`);
      if (response.status === 426) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Demo server did not become ready at ${url}.`);
}

async function loadFixtureAt24Khz() {
  const bytes = await readFile(resolve(repoRoot, "test-fixtures/hello-16k.pcm"));
  const input = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const output = new Int16Array(Math.floor(input.length * 1.5));
  for (let index = 0; index < output.length; index += 1) {
    const position = index / 1.5;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const mix = position - left;
    output[index] = Math.round((input[left] ?? 0) * (1 - mix) + (input[right] ?? 0) * mix);
  }
  return Buffer.from(output.buffer);
}

function withTrailingSilence(audio: Buffer, durationMs: number) {
  return Buffer.concat([audio, Buffer.alloc(Math.floor(24000 * 2 * durationMs / 1000))]);
}

function assertOrdered(types: unknown[], expected: string[]) {
  let cursor = -1;
  for (const type of expected) {
    const next = types.indexOf(type, cursor + 1);
    assert(next >= 0, `Missing ordered event ${type}. Received: ${types.join(", ")}`);
    cursor = next;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function delay(ms: number) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

await main();
