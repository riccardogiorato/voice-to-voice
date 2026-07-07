"use client";

import {
  Cpu,
  LoaderCircle,
  MessageCircle,
  Mic,
  SlidersHorizontal,
  Volume2,
  X,
} from "lucide-react";
import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";

type Phase = "idle" | "connecting" | "listening" | "thinking" | "speaking";

type Turn = {
  role: "user" | "assistant";
  text: string;
};

type ServerEvent =
  | { type: "state"; state: Phase }
  | { type: "transcript.delta"; text: string }
  | { type: "transcript.final"; text: string }
  | { type: "assistant.delta"; text: string }
  | { type: "audio.delta"; audio: string; sampleRate: number }
  | { type: "audio.done" }
  | { type: "audio.clear" }
  | { type: "error"; message: string };

const phaseCopy: Record<Phase, { label: string; detail: string }> = {
  idle: {
    label: "Tap to talk",
    detail: "Ask out loud.",
  },
  connecting: {
    label: "Connecting",
    detail: "Opening voice.",
  },
  listening: {
    label: "Listening",
    detail: "Go ahead.",
  },
  thinking: {
    label: "Thinking",
    detail: "Finding the words.",
  },
  speaking: {
    label: "Speaking",
    detail: "Answering now.",
  },
};

export default function Home() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [partial, setPartial] = useState("");
  const [assistantDraft, setAssistantDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const inputSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const playbackSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const nextPlayTimeRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");

  const isActive = phase !== "idle";
  const status = phaseCopy[phase];
  const visibleAssistant =
    assistantDraft ||
    [...turns].reverse().find((turn) => turn.role === "assistant")?.text ||
    "";
  const visibleUser =
    partial || [...turns].reverse().find((turn) => turn.role === "user")?.text || "";

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    return () => {
      stopConversation();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startConversation() {
    if (isActive) return;

    setError("");
    setPartial("");
    setAssistantDraft("");
    setPhase("connecting");

    try {
      const audioContext = new AudioContext({ latencyHint: "interactive" });
      audioContextRef.current = audioContext;
      await audioContext.resume();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      const socket = new WebSocket(getVoiceSocketUrl());
      socketRef.current = socket;

      socket.onopen = () => {
        socket.send(JSON.stringify({ type: "conversation.start" }));
        wireMicrophone(audioContext, stream, socket);
      };

      socket.onmessage = (message) => {
        handleServerEvent(JSON.parse(message.data) as ServerEvent);
      };

      socket.onerror = () => {
        setError("Voice socket failed. Try a deployed Vercel URL if local dev cannot upgrade WebSockets.");
        setPhase("idle");
      };

      socket.onclose = () => {
        tearDownAudio();
        setPhase("idle");
      };
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start the microphone.");
      setPhase("idle");
      tearDownAudio();
    }
  }

  function handleServerEvent(event: ServerEvent) {
    if (event.type === "state") {
      setPhase(event.state);
      return;
    }

    if (event.type === "transcript.delta") {
      setPartial((current) => current + event.text);
      return;
    }

    if (event.type === "transcript.final") {
      setPartial("");
      setAssistantDraft("");
      setTurns((current) => [...current.slice(-5), { role: "user", text: event.text }]);
      return;
    }

    if (event.type === "assistant.delta") {
      setAssistantDraft((current) => current + event.text);
      return;
    }

    if (event.type === "audio.delta") {
      playPcm16(event.audio, event.sampleRate);
      return;
    }

    if (event.type === "audio.done") {
      setAssistantDraft((draft) => {
        const text = draft.trim();
        if (text) {
          setTurns((current) => [...current.slice(-5), { role: "assistant", text }]);
        }
        return "";
      });
      return;
    }

    if (event.type === "audio.clear") {
      clearPlayback();
      return;
    }

    if (event.type === "error") {
      setError(event.message);
      setPhase("listening");
    }
  }

  function wireMicrophone(
    audioContext: AudioContext,
    stream: MediaStream,
    socket: WebSocket,
  ) {
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(2048, 1, 1);

    processor.onaudioprocess = (event) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (phaseRef.current === "speaking") return;

      const input = event.inputBuffer.getChannelData(0);
      socket.send(
        JSON.stringify({
          type: "audio.input",
          audio: float32ToBase64(input),
          sampleRate: audioContext.sampleRate,
        }),
      );
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
    inputSourceRef.current = source;
    processorRef.current = processor;
  }

  function cancelResponse() {
    clearPlayback();
    socketRef.current?.send(JSON.stringify({ type: "response.cancel" }));
    setAssistantDraft("");
    setPhase("listening");
  }

  function stopConversation() {
    socketRef.current?.send(JSON.stringify({ type: "conversation.stop" }));
    socketRef.current?.close();
    socketRef.current = null;
    tearDownAudio();
    setPhase("idle");
    setPartial("");
    setAssistantDraft("");
  }

  function tearDownAudio() {
    clearPlayback();
    processorRef.current?.disconnect();
    inputSourceRef.current?.disconnect();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    void audioContextRef.current?.close();

    processorRef.current = null;
    inputSourceRef.current = null;
    mediaStreamRef.current = null;
    audioContextRef.current = null;
    nextPlayTimeRef.current = 0;
  }

  function clearPlayback() {
    playbackSourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch {
        // Source may already have ended.
      }
    });
    playbackSourcesRef.current = [];
    nextPlayTimeRef.current = audioContextRef.current?.currentTime ?? 0;
  }

  function playPcm16(base64: string, sampleRate: number) {
    const audioContext = audioContextRef.current;
    if (!audioContext) return;

    const samples = base64Pcm16ToFloat32(base64);
    const buffer = audioContext.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

    const startAt = Math.max(audioContext.currentTime + 0.02, nextPlayTimeRef.current);
    source.start(startAt);
    nextPlayTimeRef.current = startAt + buffer.duration;

    playbackSourcesRef.current.push(source);
    source.onended = () => {
      playbackSourcesRef.current = playbackSourcesRef.current.filter(
        (item) => item !== source,
      );
    };
  }

  const transcriptItems = useMemo(
    () => [
      ...turns.slice(-4),
      ...(partial ? [{ role: "user" as const, text: partial }] : []),
      ...(assistantDraft
        ? [{ role: "assistant" as const, text: assistantDraft }]
        : []),
    ],
    [assistantDraft, partial, turns],
  );

  return (
    <main className="min-h-dvh overflow-hidden bg-[#faf9f6] text-[#050505]">
      <div className="relative flex min-h-dvh items-center justify-center px-4 py-6 sm:px-8">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_12%,rgba(198,168,244,0.34),transparent_26%),radial-gradient(circle_at_78%_18%,rgba(239,44,193,0.18),transparent_24%),radial-gradient(circle_at_54%_88%,rgba(252,76,2,0.16),transparent_30%)]" />

        <section className="phone-shell relative flex h-[min(860px,calc(100dvh-48px))] w-full max-w-[430px] flex-col overflow-hidden bg-[#fdfcf9] shadow-[0_0_0_10px_#050505,0_24px_70px_rgba(5,5,5,0.22)]">
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(198,168,244,0.18),rgba(255,255,255,0)_24%),radial-gradient(circle_at_100%_5%,rgba(239,44,193,0.12),transparent_24%),radial-gradient(circle_at_0%_95%,rgba(252,76,2,0.1),transparent_28%)]" />

          <header className="relative z-10 flex items-center justify-between px-7 pt-7 text-sm">
            <Image
              className="h-6 w-[110px] object-contain object-left"
              src="/together-logo.svg"
              alt="Together AI"
              width={110}
              height={24}
              priority
            />
            <button
              className="grid size-10 place-items-center rounded-full bg-white text-[#050505]/70 shadow-[0_0_0_1px_rgba(5,5,5,0.08),0_2px_8px_rgba(5,5,5,0.06)] transition-[box-shadow,scale] duration-150 hover:shadow-[0_0_0_1px_rgba(5,5,5,0.12),0_3px_12px_rgba(5,5,5,0.08)] active:scale-[0.96]"
              type="button"
              aria-expanded={settingsOpen}
              aria-label={settingsOpen ? "Close settings" : "Open settings"}
              title={settingsOpen ? "Close settings" : "Settings"}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <span className="relative grid size-4 place-items-center">
                <SlidersHorizontal
                  className={`absolute size-4 transition-[opacity,filter,scale] duration-200 ${
                    settingsOpen
                      ? "scale-[0.25] opacity-0 blur-[4px]"
                      : "scale-100 opacity-100 blur-0"
                  }`}
                  aria-hidden
                />
                <X
                  className={`absolute size-4 transition-[opacity,filter,scale] duration-200 ${
                    settingsOpen
                      ? "scale-100 opacity-100 blur-0"
                      : "scale-[0.25] opacity-0 blur-[4px]"
                  }`}
                  aria-hidden
                />
              </span>
            </button>
          </header>

          <div className="relative z-10 flex flex-1 flex-col px-7 pb-7 pt-6">
            {settingsOpen ? (
              <div className="absolute left-7 right-7 top-5 z-20 rounded-[24px] bg-white p-4 shadow-[0_0_0_1px_rgba(5,5,5,0.08),0_18px_44px_rgba(5,5,5,0.12)]">
                <div className="flex items-center gap-2 text-sm font-semibold text-[#050505]">
                  <Cpu className="size-4 text-[#ef2cc1]" aria-hidden />
                  Model stack
                </div>
                <dl className="mt-4 space-y-3 text-sm">
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-[#050505]/52">Speech to text</dt>
                    <dd className="font-medium text-[#050505]">Whisper large v3</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-[#050505]/52">Response</dt>
                    <dd className="font-medium text-[#050505]">Qwen3.5 9B</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-[#050505]/52">Voice</dt>
                    <dd className="font-medium text-[#050505]">Kokoro</dd>
                  </div>
                </dl>
              </div>
            ) : null}

            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8">
              <div className={`voice-orb voice-orb-${phase}`} aria-hidden>
                <div className="voice-orb-core" />
              </div>

              <div className="min-h-[116px] w-full text-center">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6b5a82]">
                  {status.label}
                </p>
                <h1 className="mt-3 text-balance font-[family-name:var(--font-manrope)] text-[34px] font-medium leading-[1.02] tracking-normal text-[#050505]">
                  {visibleAssistant || visibleUser || status.detail}
                </h1>
              </div>
            </div>

            <div className="space-y-4">
              <div className="h-[136px] overflow-hidden rounded-[26px] bg-white p-4 shadow-[0_0_0_1px_rgba(5,5,5,0.08),0_10px_26px_rgba(5,5,5,0.06)]">
                <div className="flex items-center gap-2 text-xs font-medium text-[#6b5a82]">
                  <MessageCircle className="size-4" aria-hidden />
                  Live transcript
                </div>
                <div className="mt-3 space-y-2">
                  {transcriptItems.length === 0 ? (
                    <p className="text-pretty text-sm leading-6 text-[#050505]/50">
                      Short turns work best: ask one thing, pause, and let the
                      assistant answer.
                    </p>
                  ) : (
                    transcriptItems.map((turn, index) => (
                      <p
                        className="line-clamp-2 text-pretty text-sm leading-6 text-[#050505]/70"
                        key={`${turn.role}-${index}-${turn.text}`}
                      >
                        <span className="font-semibold text-[#050505]">
                          {turn.role === "user" ? "You" : "AI"}:
                        </span>{" "}
                        {turn.text}
                      </p>
                    ))
                  )}
                </div>
              </div>

              {error ? (
                <p className="rounded-2xl bg-[#fff1ec] px-4 py-3 text-sm text-[#9a2c07] shadow-[0_0_0_1px_rgba(252,76,2,0.18)]">
                  {error}
                </p>
              ) : null}

              <div className="grid grid-cols-[52px_1fr_52px] items-center gap-4">
                <button
                  className="grid size-[52px] place-items-center rounded-full bg-white text-[#050505]/68 shadow-[0_0_0_1px_rgba(5,5,5,0.08),0_2px_10px_rgba(5,5,5,0.06)] transition-[box-shadow,scale,opacity] duration-150 hover:shadow-[0_0_0_1px_rgba(5,5,5,0.12),0_4px_14px_rgba(5,5,5,0.08)] active:scale-[0.96] disabled:opacity-40"
                  type="button"
                  aria-label="Cancel response"
                  title="Cancel response"
                  disabled={!isActive}
                  onClick={cancelResponse}
                >
                  <Volume2 className="size-5" aria-hidden />
                </button>

                <button
                  className={`mic-button ${isActive ? "mic-button-active" : ""}`}
                  type="button"
                  aria-label={isActive ? "Stop voice demo" : "Start voice demo"}
                  title={isActive ? "Stop" : "Start"}
                  onClick={isActive ? stopConversation : startConversation}
                >
                  {phase === "connecting" || phase === "thinking" ? (
                    <LoaderCircle className="size-7 animate-spin" aria-hidden />
                  ) : (
                    <Mic className="size-7" aria-hidden />
                  )}
                </button>

                <button
                  className="grid size-[52px] place-items-center rounded-full bg-white text-[#050505]/68 shadow-[0_0_0_1px_rgba(5,5,5,0.08),0_2px_10px_rgba(5,5,5,0.06)] transition-[box-shadow,scale,opacity] duration-150 hover:shadow-[0_0_0_1px_rgba(5,5,5,0.12),0_4px_14px_rgba(5,5,5,0.08)] active:scale-[0.96] disabled:opacity-40"
                  type="button"
                  aria-label="End call"
                  title="End"
                  disabled={!isActive}
                  onClick={stopConversation}
                >
                  <X className="size-5" aria-hidden />
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function getVoiceSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/voice`;
}

function float32ToBase64(input: Float32Array) {
  const bytes = new Uint8Array(input.length * 4);
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < input.length; i += 1) {
    view.setFloat32(i * 4, input[i], true);
  }

  return bytesToBase64(bytes);
}

function base64Pcm16ToFloat32(base64: string) {
  const bytes = base64ToBytes(base64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));

  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }

  return samples;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}
