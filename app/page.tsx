"use client";

import {
  Cpu,
  LoaderCircle,
  Mic,
  SlidersHorizontal,
  X,
} from "lucide-react";
import Image from "next/image";
import type { MutableRefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

type Phase = "idle" | "connecting" | "listening" | "thinking" | "speaking";

type Turn = {
  role: "user" | "assistant";
  text: string;
};

type TranscriptItem = Turn & {
  live?: boolean;
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
    detail: "Ready",
  },
  connecting: {
    label: "Connecting",
    detail: "Opening",
  },
  listening: {
    label: "Listening",
    detail: "Live",
  },
  thinking: {
    label: "Thinking",
    detail: "Working",
  },
  speaking: {
    label: "Speaking",
    detail: "Mic paused",
  },
};

const SPEECH_RMS_THRESHOLD = 0.018;
const SPEECH_HOLD_MS = 360;
const MIN_AUDIO_CHUNK_MS = 80;

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
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const inputSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const playbackSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const nextPlayTimeRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  const micBufferRef = useRef<Float32Array[]>([]);
  const micBufferSamplesRef = useRef(0);
  const lastSpeechAtRef = useRef(Number.NEGATIVE_INFINITY);
  const speechOpenRef = useRef(false);
  const pcmLeftoverRef = useRef<Uint8Array | null>(null);

  const isActive = phase !== "idle";
  const status = phaseCopy[phase];

  function updatePhase(nextPhase: Phase) {
    phaseRef.current = nextPhase;
    setPhase(nextPhase);
  }

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
    updatePhase("connecting");

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

      socket.onopen = async () => {
        socket.send(JSON.stringify({ type: "conversation.start" }));
        try {
          await wireMicrophone(audioContext, stream, socket);
        } catch (reason) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not start microphone streaming.",
          );
          stopConversation();
        }
      };

      socket.onmessage = (message) => {
        handleServerEvent(JSON.parse(message.data) as ServerEvent);
      };

      socket.onerror = () => {
        setError("Voice socket failed. Try a deployed Vercel URL if local dev cannot upgrade WebSockets.");
        updatePhase("idle");
      };

      socket.onclose = () => {
        tearDownAudio();
        updatePhase("idle");
      };
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start the microphone.");
      updatePhase("idle");
      tearDownAudio();
    }
  }

  function handleServerEvent(event: ServerEvent) {
    if (event.type === "state") {
      updatePhase(event.state);
      return;
    }

    if (event.type === "transcript.delta") {
      setPartial(event.text);
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
      updatePhase("listening");
    }
  }

  async function wireMicrophone(
    audioContext: AudioContext,
    stream: MediaStream,
    socket: WebSocket,
  ) {
    const source = audioContext.createMediaStreamSource(stream);

    if (audioContext.audioWorklet) {
      await audioContext.audioWorklet.addModule(createMicWorkletUrl());
      const worklet = new AudioWorkletNode(audioContext, "mic-capture");
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      const minChunkSamples = Math.round(
        audioContext.sampleRate * (MIN_AUDIO_CHUNK_MS / 1000),
      );

      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        sendSpeechAudio(event.data, audioContext.sampleRate, minChunkSamples, socket);
      };

      source.connect(worklet);
      worklet.connect(silentGain);
      silentGain.connect(audioContext.destination);
      inputSourceRef.current = source;
      workletRef.current = worklet;
      silentGainRef.current = silentGain;
      return;
    }

    const processor = audioContext.createScriptProcessor(2048, 1, 1);
    const minChunkSamples = Math.round(
      audioContext.sampleRate * (MIN_AUDIO_CHUNK_MS / 1000),
    );

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      sendSpeechAudio(input, audioContext.sampleRate, minChunkSamples, socket);
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
    inputSourceRef.current = source;
    processorRef.current = processor;
  }

  function stopConversation() {
    socketRef.current?.send(JSON.stringify({ type: "conversation.stop" }));
    socketRef.current?.close();
    socketRef.current = null;
    tearDownAudio();
    updatePhase("idle");
    setPartial("");
    setAssistantDraft("");
  }

  function tearDownAudio() {
    clearPlayback();
    workletRef.current?.disconnect();
    workletRef.current?.port.close();
    silentGainRef.current?.disconnect();
    processorRef.current?.disconnect();
    inputSourceRef.current?.disconnect();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    void audioContextRef.current?.close();

    processorRef.current = null;
    workletRef.current = null;
    silentGainRef.current = null;
    inputSourceRef.current = null;
    mediaStreamRef.current = null;
    audioContextRef.current = null;
    nextPlayTimeRef.current = 0;
    micBufferRef.current = [];
    micBufferSamplesRef.current = 0;
    lastSpeechAtRef.current = Number.NEGATIVE_INFINITY;
    speechOpenRef.current = false;
    pcmLeftoverRef.current = null;
  }

  function sendSpeechAudio(
    input: Float32Array,
    sampleRate: number,
    minChunkSamples: number,
    socket: WebSocket,
  ) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (phaseRef.current !== "listening") {
      resetMicGate();
      return;
    }

    const now = performance.now();
    if (rms(input) >= SPEECH_RMS_THRESHOLD) {
      lastSpeechAtRef.current = now;
      speechOpenRef.current = true;
    }

    const inSpeechTail = now - lastSpeechAtRef.current <= SPEECH_HOLD_MS;
    if (!inSpeechTail) {
      flushSpeechAudio(socket, sampleRate);
      if (speechOpenRef.current) {
        socket.send(JSON.stringify({ type: "audio.commit" }));
        speechOpenRef.current = false;
      }
      micBufferRef.current = [];
      micBufferSamplesRef.current = 0;
      return;
    }

    const copy = new Float32Array(input);
    micBufferRef.current.push(copy);
    micBufferSamplesRef.current += copy.length;

    if (micBufferSamplesRef.current < minChunkSamples) return;

    flushSpeechAudio(socket, sampleRate);
  }

  function resetMicGate() {
    micBufferRef.current = [];
    micBufferSamplesRef.current = 0;
    lastSpeechAtRef.current = Number.NEGATIVE_INFINITY;
    speechOpenRef.current = false;
  }

  function flushSpeechAudio(socket: WebSocket, sampleRate: number) {
    if (micBufferSamplesRef.current === 0) return;

    const chunk = concatFloat32(micBufferRef.current, micBufferSamplesRef.current);
    micBufferRef.current = [];
    micBufferSamplesRef.current = 0;

    socket.send(
      JSON.stringify({
        type: "audio.input",
        audio: float32ToBase64(chunk),
        sampleRate,
      }),
    );
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
    pcmLeftoverRef.current = null;
  }

  function playPcm16(base64: string, sampleRate: number) {
    const audioContext = audioContextRef.current;
    if (!audioContext) return;

    const samples = base64Pcm16ToFloat32(base64, pcmLeftoverRef);
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

  const transcriptItems = useMemo<TranscriptItem[]>(() => {
    const liveItems: TranscriptItem[] = [
      ...(partial ? [{ role: "user" as const, text: partial, live: true }] : []),
      ...(assistantDraft
        ? [{ role: "assistant" as const, text: assistantDraft, live: true }]
        : []),
    ];

    return [...turns.slice(liveItems.length ? -2 : -3), ...liveItems].slice(-4);
  }, [assistantDraft, partial, turns]);

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
                    <dd className="font-medium text-[#050505]">Qwen2.5 7B</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-[#050505]/52">Voice</dt>
                    <dd className="font-medium text-[#050505]">Kokoro</dd>
                  </div>
                </dl>
              </div>
            ) : null}

            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 pb-6">
              <div className={`voice-orb voice-orb-${phase}`} aria-hidden>
                <div className="voice-orb-core" />
              </div>

              <div className="rounded-full bg-white/38 px-4 py-2 text-center shadow-[0_0_0_1px_rgba(255,255,255,0.55),0_10px_28px_rgba(90,43,103,0.08)] backdrop-blur-xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#6b5a82]">
                  {status.label} · {status.detail}
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="conversation-stream">
                <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-10 bg-gradient-to-b from-[#fdfcf9]/80 to-transparent" />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-[#fdfcf9]/72 to-transparent" />
                <div className="flex h-full flex-col justify-end gap-1.5 px-1 py-3">
                  {transcriptItems.length === 0 ? (
                    <p className="self-center rounded-full bg-white/34 px-3 py-1.5 text-sm leading-5 text-[#6b5a82]/72 shadow-[0_0_0_1px_rgba(255,255,255,0.56)] backdrop-blur-xl">
                      Tap to start
                    </p>
                  ) : (
                    transcriptItems.map((turn, index) => (
                      <p
                        className={`line-clamp-2 max-w-[86%] text-pretty rounded-[18px] px-3 py-1.5 text-sm leading-5 shadow-[0_8px_22px_rgba(42,26,52,0.07)] transition-[opacity,filter,transform] duration-300 ease-out ${
                          turn.role === "user"
                            ? "self-end bg-[#050505]/88 text-white backdrop-blur-xl"
                            : "self-start bg-white/48 text-[#33253d] shadow-[0_0_0_1px_rgba(255,255,255,0.5),0_8px_22px_rgba(42,26,52,0.06)] backdrop-blur-xl"
                        } ${turn.live ? "opacity-100" : ""}`}
                        style={{
                          opacity: turn.live
                            ? 1
                            : Math.max(0.2, 0.82 - (transcriptItems.length - index - 1) * 0.22),
                          filter: turn.live
                            ? "blur(0)"
                            : `blur(${Math.min(1.4, (transcriptItems.length - index - 1) * 0.35)}px)`,
                          transform: `translateY(${turn.live ? 0 : Math.max(-10, (index - transcriptItems.length + 1) * 3)}px)`,
                        }}
                        key={`${turn.role}-${index}-${turn.text}`}
                      >
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

              <div className="flex items-center justify-center">
                <button
                  className={`mic-button ${isActive ? "mic-button-active" : ""}`}
                  type="button"
                  aria-label={isActive ? "Stop voice demo" : "Start voice demo"}
                  title={isActive ? "Stop" : "Start"}
                  onClick={isActive ? stopConversation : startConversation}
                >
                  {phase === "connecting" || phase === "thinking" ? (
                    <LoaderCircle className="size-7 animate-spin" aria-hidden />
                  ) : isActive ? (
                    <X className="size-7" aria-hidden />
                  ) : (
                    <Mic className="size-7" aria-hidden />
                  )}
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

function createMicWorkletUrl() {
  const source = `
    class MicCaptureProcessor extends AudioWorkletProcessor {
      process(inputs) {
        const input = inputs[0] && inputs[0][0];
        if (input && input.length) {
          const copy = new Float32Array(input);
          this.port.postMessage(copy, [copy.buffer]);
        }
        return true;
      }
    }

    registerProcessor("mic-capture", MicCaptureProcessor);
  `;

  return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}

function float32ToBase64(input: Float32Array) {
  const bytes = new Uint8Array(input.length * 4);
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < input.length; i += 1) {
    view.setFloat32(i * 4, input[i], true);
  }

  return bytesToBase64(bytes);
}

function rms(input: Float32Array) {
  let sum = 0;

  for (let i = 0; i < input.length; i += 1) {
    sum += input[i] * input[i];
  }

  return Math.sqrt(sum / Math.max(1, input.length));
}

function concatFloat32(chunks: Float32Array[], totalLength: number) {
  const output = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

function base64Pcm16ToFloat32(
  base64: string,
  leftoverRef: MutableRefObject<Uint8Array | null>,
) {
  let bytes = base64ToBytes(base64);

  if (leftoverRef.current) {
    bytes = concatBytes(leftoverRef.current, bytes);
    leftoverRef.current = null;
  }

  if (bytes.byteLength % 2 === 1) {
    leftoverRef.current = bytes.subarray(bytes.byteLength - 1);
    bytes = bytes.subarray(0, bytes.byteLength - 1);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));

  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }

  return samples;
}

function concatBytes(left: Uint8Array, right: Uint8Array) {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left, 0);
  output.set(right, left.byteLength);
  return output;
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
