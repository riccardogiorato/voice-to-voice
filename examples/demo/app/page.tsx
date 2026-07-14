"use client";

import {
  OpenAIRealtimeWebSocket,
  RealtimeAgent,
  RealtimeSession,
  tool,
} from "@openai/agents/realtime";
import { DEMO_VOICE } from "@/lib/voice";
import { useCallback, useRef, useState } from "react";
import { z } from "zod";

type LogEntry = { id: number; text: string };

const getLocalTime = tool({
  name: "get_local_time",
  description: "Get the current local time in a requested IANA time zone.",
  parameters: z.object({ timeZone: z.string().default("Europe/Rome") }),
  async execute({ timeZone }) {
    return new Intl.DateTimeFormat("en", {
      timeZone,
      dateStyle: "full",
      timeStyle: "long",
    }).format(new Date());
  },
});

const agent = new RealtimeAgent({
  name: "Together Voice",
  instructions:
    "You are a warm, concise voice assistant running on Together AI. Reply in one or two natural sentences. Use get_local_time for current time questions.",
  tools: [getLocalTime],
});

export default function Home() {
  const sessionRef = useRef<RealtimeSession | null>(null);
  const captureRef = useRef<Awaited<ReturnType<typeof startCapture>> | null>(null);
  const playbackRef = useRef<PcmPlayback | null>(null);
  const [status, setStatus] = useState("Disconnected");
  const [manual, setManual] = useState(false);
  const [muted, setMuted] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const log = useCallback((text: string) => {
    setLogs((current) => [...current.slice(-30), { id: Date.now() + Math.random(), text }]);
  }, []);

  const connect = useCallback(async () => {
    if (sessionRef.current) return;
    setStatus("Connecting");
    const secretResponse = await fetch("/api/realtime/client_secrets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: 120 },
        session: {
          type: "realtime",
          model: "together-realtime",
          audio: {
            input: { turn_detection: manual ? null : { type: "server_vad", create_response: true, interrupt_response: true } },
            output: { voice: DEMO_VOICE },
          },
        },
      }),
    });
    if (!secretResponse.ok) throw new Error(await secretResponse.text());
    const secret = (await secretResponse.json()) as { value: string };
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/api/realtime?model=together-realtime`;
    const transport = new OpenAIRealtimeWebSocket({ url });
    const session = new RealtimeSession(agent, {
      transport,
      model: "together-realtime" as never,
      tracingDisabled: true,
      config: {
        audio: {
          input: {
            format: "pcm16",
            transcription: null,
            turnDetection: manual
              ? null
              : { type: "server_vad", createResponse: true, interruptResponse: true },
          },
          output: { format: "pcm16", voice: DEMO_VOICE },
        },
      },
    });
    session.transport.on("*", (event) => {
      const type = (event as { type?: string }).type;
      if (type) log(type);
    });
    playbackRef.current = new PcmPlayback();
    session.on("audio", (event) => playbackRef.current?.push(event.data));
    session.on("error", (event) => log(`SDK error: ${String(event)}`));
    await session.connect({ apiKey: secret.value });
    sessionRef.current = session;
    if (new URLSearchParams(window.location.search).get("smoke") === "1") {
      setStatus("Connected (no microphone)");
      return;
    }
    try {
      captureRef.current = await startCapture((audio) => {
        if (!muted) session.sendAudio(audio);
      });
      setStatus("Listening");
    } catch (error) {
      session.close();
      sessionRef.current = null;
      playbackRef.current?.close();
      playbackRef.current = null;
      throw error;
    }
  }, [log, manual, muted]);

  const disconnect = useCallback(() => {
    captureRef.current?.stop();
    captureRef.current = null;
    playbackRef.current?.close();
    playbackRef.current = null;
    sessionRef.current?.close();
    sessionRef.current = null;
    setStatus("Disconnected");
  }, []);

  const commit = useCallback(() => {
    sessionRef.current?.transport.sendEvent({ type: "input_audio_buffer.commit" });
    sessionRef.current?.transport.sendEvent({ type: "response.create" });
  }, []);

  return (
    <main>
      <section className="hero">
        <div className="eyebrow">
          <img className="together-logo" src="/together-logo.svg" alt="Together AI" />
          <span>Realtime v2</span>
        </div>
        <h1>Same OpenAI voice agent.<br />Now on Together.</h1>
        <p className="lede">Keep <code>@openai/agents/realtime</code>, your agent, and your tools. Change two URLs to run the same realtime voice flow on Together.</p>
        <ol className="switches" aria-label="Two changes to use Together">
          <li><span>1</span><div><strong>Client secret</strong><code>/api/realtime/client_secrets</code></div></li>
          <li><span>2</span><div><strong>WebSocket</strong><code>/api/realtime</code></div></li>
        </ol>
        <div className="controls">
          {status === "Disconnected" ? (
            <button className="primary" onClick={() => void connect().catch((error) => { setStatus("Failed"); log(String(error)); })}>Connect microphone</button>
          ) : (
            <button className="primary live" onClick={disconnect}>End session</button>
          )}
          <button onClick={() => setMuted((value) => !value)} disabled={!sessionRef.current}>{muted ? "Unmute" : "Mute"}</button>
          <button onClick={commit} disabled={!manual || !sessionRef.current}>Commit turn</button>
        </div>
        <label className="mode">
          <input type="checkbox" checked={manual} disabled={status !== "Disconnected"} onChange={(event) => setManual(event.target.checked)} />
          Manual commit (server VAD is the default)
        </label>
      </section>
      <aside>
        <div className="status"><span className={status === "Listening" ? "dot active" : "dot"} />{status}</div>
        <h2>Protocol events</h2>
        <div className="log">
          {logs.length === 0 ? <p>Connect to see the live event stream.</p> : logs.map((entry) => <code key={entry.id}>{entry.text}</code>)}
        </div>
        <p className="hint">Try: “What time is it in Tokyo?” The tool runs locally in your browser.</p>
      </aside>
    </main>
  );
}

async function startCapture(onAudio: (audio: ArrayBuffer) => void) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const context = new AudioContext({ latencyHint: "interactive" });
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(2048, 1, 1);
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const ratio = context.sampleRate / 24000;
    const output = new Int16Array(Math.floor(input.length / ratio));
    for (let index = 0; index < output.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, input[Math.floor(index * ratio)] ?? 0));
      output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    onAudio(output.buffer);
  };
  source.connect(processor);
  processor.connect(context.destination);
  return {
    stop() {
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void context.close();
    },
  };
}

class PcmPlayback {
  private readonly context = new AudioContext({ sampleRate: 24000, latencyHint: "interactive" });
  private cursor = 0;

  push(data: ArrayBuffer) {
    const pcm = new Int16Array(data);
    const buffer = this.context.createBuffer(1, pcm.length, 24000);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < pcm.length; index += 1) channel[index] = (pcm[index] ?? 0) / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    this.cursor = Math.max(this.cursor, this.context.currentTime);
    source.start(this.cursor);
    this.cursor += buffer.duration;
  }

  close() {
    void this.context.close();
  }
}
