"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  base64Pcm16ToFloat32,
  BrowserTenVad,
  concatFloat32,
  createMicWorkletUrl,
  float32ToBase64,
  getVoiceSocketUrl,
  loadBrowserTenVad,
  clamp01,
  normalizeRange,
  rms,
} from "@/app/_lib/client-audio";

type Phase = "idle" | "connecting" | "listening" | "thinking" | "speaking";

type Turn = {
  role: "user" | "assistant";
  text: string;
};

type TranscriptItem = Turn & {
  live?: boolean;
};

type PartialTranscript = {
  text: string;
  baseText?: string;
};

type ServerEvent =
  | { type: "state"; state: Phase }
  | { type: "transcript.delta"; text: string; baseText?: string; merged?: boolean }
  | { type: "transcript.final"; text: string; merged?: boolean; repaired?: boolean }
  | { type: "transcript.ignored"; text?: string }
  | { type: "assistant.delta"; text: string }
  | { type: "audio.delta"; audio: string; sampleRate: number }
  | { type: "audio.done" }
  | { type: "audio.clear" }
  | { type: "error"; message: string };

const SPEECH_RMS_THRESHOLD = 0.024;
const BARGE_IN_RMS_THRESHOLD = 0.12;
const BARGE_IN_HOLD_MS = 260;
const ASSISTANT_AUDIO_TAIL_MS = 850;
const VAD_SPEECH_HOLD_MS = 250;
const RMS_SPEECH_HOLD_MS = 360;
const MIN_SPEECH_MS = 380;
const MIN_AUDIO_CHUNK_MS = 80;
const PRE_ROLL_MS = 320;
const VAD_OPEN_THRESHOLD = 0.76;
const VAD_CLOSE_THRESHOLD = 0.46;

export function useVoiceConversation() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [partial, setPartial] = useState<PartialTranscript | null>(null);
  const [assistantDraft, setAssistantDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [micActivity, setMicActivity] = useState(0);

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
  const bargeInSentRef = useRef(false);
  const bargeInStartedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const assistantAudioBlockUntilRef = useRef(Number.NEGATIVE_INFINITY);
  const pcmLeftoverRef = useRef<Uint8Array | null>(null);
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const preRollRef = useRef<Float32Array[]>([]);
  const preRollSamplesRef = useRef(0);
  const noiseFloorRef = useRef(0.008);
  const pendingPhaseRef = useRef<Phase | null>(null);
  const mutedRef = useRef(false);
  const micActivityRef = useRef(0);
  const lastMicActivityPaintRef = useRef(0);
  const speechOpenedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const tenVadRef = useRef<BrowserTenVad | null>(null);
  const tenVadPromiseRef = useRef<Promise<BrowserTenVad | null> | null>(null);

  const isActive = phase !== "idle";

  function resetConversation() {
    clearPlayback();
    setTurns([]);
    setPartial(null);
    setAssistantDraft("");
    setError("");
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "conversation.reset" }));
    }
  }

  function toggleMute() {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (next) resetMicGate();
  }

  function updatePhase(nextPhase: Phase) {
    phaseRef.current = nextPhase;
    if (nextPhase === "idle" || nextPhase === "listening") {
      bargeInSentRef.current = false;
      bargeInStartedAtRef.current = Number.NEGATIVE_INFINITY;
    }
    setPhase(nextPhase);
  }

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);


  async function startConversation() {
    if (isActive) return;

    void ensureTenVad();
    setError("");
    setPartial(null);
    setAssistantDraft("");
    mutedRef.current = false;
    setMuted(false);
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
        socket.send(
          JSON.stringify({ type: "conversation.start", history: turns }),
        );
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
        const wasActive = phaseRef.current !== "idle";
        tearDownAudio();
        updatePhase("idle");
        if (wasActive) setError("Session ended. Tap the mic to reconnect.");
      };
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start the microphone.");
      updatePhase("idle");
      tearDownAudio();
    }
  }

  function handleServerEvent(event: ServerEvent) {
    if (event.type === "state") {
      deferPhaseUntilPlayback(event.state);
      return;
    }

    if (event.type === "transcript.delta") {
      setPartial(
        isDisplayableTranscriptText(event.text)
          ? {
              text: event.text,
              baseText: isDisplayableTranscriptText(event.baseText ?? "")
                ? event.baseText
                : undefined,
            }
          : null,
      );
      return;
    }

    if (event.type === "transcript.final") {
      setPartial(null);
      setAssistantDraft("");
      setTurns((current) => {
        const next = current.slice(-5);
        if (!event.merged) return [...next, { role: "user", text: event.text }];

        if (next.at(-1)?.role === "assistant") next.pop();
        const lastUserIndex = findLastTurnIndex(next, "user");
        if (lastUserIndex === -1) return [...next, { role: "user", text: event.text }];

        next[lastUserIndex] = { role: "user", text: event.text };
        return next;
      });
      return;
    }

    if (event.type === "transcript.ignored") {
      setPartial(null);
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
      deferPhaseUntilPlayback("listening");
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
    setPartial(null);
    setAssistantDraft("");
    setMicActivity(0);
  }

  useEffect(() => {
    return () => {
      stopConversation();
    };
  }, []);

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
    micActivityRef.current = 0;
    lastMicActivityPaintRef.current = 0;
    setMicActivity(0);
    nextPlayTimeRef.current = 0;
    micBufferRef.current = [];
    micBufferSamplesRef.current = 0;
    lastSpeechAtRef.current = Number.NEGATIVE_INFINITY;
    speechOpenRef.current = false;
    bargeInStartedAtRef.current = Number.NEGATIVE_INFINITY;
    assistantAudioBlockUntilRef.current = Number.NEGATIVE_INFINITY;
    pcmLeftoverRef.current = null;
    preRollRef.current = [];
    preRollSamplesRef.current = 0;
    noiseFloorRef.current = 0.008;
    pendingPhaseRef.current = null;
    speechOpenedAtRef.current = Number.NEGATIVE_INFINITY;
    tenVadRef.current?.destroy();
    tenVadRef.current = null;
    tenVadPromiseRef.current = null;
  }

  function isAssistantAudioActive() {
    if (playbackSourcesRef.current.length > 0) return true;
    const audioContext = audioContextRef.current;
    if (!audioContext) return false;
    return nextPlayTimeRef.current > audioContext.currentTime;
  }

  function isAssistantAudioBlockingMic(now: number) {
    return isAssistantAudioActive() || now < assistantAudioBlockUntilRef.current;
  }

  function sendSpeechAudio(
    input: Float32Array,
    sampleRate: number,
    minChunkSamples: number,
    socket: WebSocket,
  ) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (mutedRef.current || phaseRef.current === "idle" || phaseRef.current === "connecting") {
      resetMicGate();
      return;
    }

    const now = performance.now();
    if (isAssistantAudioBlockingMic(now) || phaseRef.current === "speaking") {
      const level = rms(input);
      if (level < BARGE_IN_RMS_THRESHOLD) {
        resetMicGate();
        bargeInStartedAtRef.current = Number.NEGATIVE_INFINITY;
        // Speaker leakage must not reach the server while the assistant talks.
        return;
      }

      if (bargeInStartedAtRef.current === Number.NEGATIVE_INFINITY) {
        bargeInStartedAtRef.current = now;
        resetMicGate();
        return;
      }

      if (now - bargeInStartedAtRef.current < BARGE_IN_HOLD_MS) {
        resetMicGate();
        return;
      }

      if (!bargeInSentRef.current) {
        socket.send(JSON.stringify({ type: "response.cancel" }));
        clearPlayback();
        setAssistantDraft("");
        bargeInSentRef.current = true;
      }
    }

    const level = rms(input);
    const vad = tenVadRef.current;
    const vadDecision = vad?.process(input, sampleRate) ?? null;
    const vadSpeech = vadDecision
      ? vadDecision.probability >=
        (speechOpenRef.current ? VAD_CLOSE_THRESHOLD : VAD_OPEN_THRESHOLD)
      : null;
    const openThreshold = Math.max(SPEECH_RMS_THRESHOLD, noiseFloorRef.current * 3);
    const hasSpeech = vadSpeech ?? level >= openThreshold;
    updateMicActivity(
      vadDecision
        ? normalizeRange(vadDecision.probability, 0.18, 0.92)
        : normalizeRange(level, openThreshold * 0.35, openThreshold * 1.8),
    );

    if (hasSpeech) {
      // Pre-roll must lead the opening frame or speech onsets are clipped.
      if (!speechOpenRef.current) {
        socket.send(JSON.stringify({ type: "speech.started" }));
        micBufferRef.current.push(...preRollRef.current);
        micBufferSamplesRef.current += preRollSamplesRef.current;
        preRollRef.current = [];
        preRollSamplesRef.current = 0;
        speechOpenedAtRef.current = now;
      }
      lastSpeechAtRef.current = now;
      speechOpenRef.current = true;
    } else if (!speechOpenRef.current) {
      preRollRef.current.push(new Float32Array(input));
      preRollSamplesRef.current += input.length;
      const maxPreRollSamples = Math.round(sampleRate * (PRE_ROLL_MS / 1000));
      while (preRollSamplesRef.current > maxPreRollSamples) {
        const oldest = preRollRef.current.shift();
        if (!oldest) break;
        preRollSamplesRef.current -= oldest.length;
      }
      noiseFloorRef.current = Math.min(
        0.02,
        Math.max(0.004, noiseFloorRef.current * 0.95 + level * 0.05),
      );
    }

    const holdMs = vad ? VAD_SPEECH_HOLD_MS : RMS_SPEECH_HOLD_MS;
    const inSpeechTail = now - lastSpeechAtRef.current <= holdMs;
    if (!inSpeechTail) {
      const speechDuration = now - speechOpenedAtRef.current;
      if (speechOpenRef.current) {
        if (speechDuration >= MIN_SPEECH_MS) {
          flushSpeechAudio(socket, sampleRate);
          socket.send(JSON.stringify({ type: "audio.commit" }));
        }
        speechOpenRef.current = false;
      }
      micBufferRef.current = [];
      micBufferSamplesRef.current = 0;
      speechOpenedAtRef.current = Number.NEGATIVE_INFINITY;
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
    preRollRef.current = [];
    preRollSamplesRef.current = 0;
    speechOpenedAtRef.current = Number.NEGATIVE_INFINITY;
    updateMicActivity(0, true);
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
    assistantAudioBlockUntilRef.current = Number.NEGATIVE_INFINITY;
    bargeInStartedAtRef.current = Number.NEGATIVE_INFINITY;
    pcmLeftoverRef.current = null;
    if (pendingPhaseRef.current) {
      updatePhase(pendingPhaseRef.current);
      pendingPhaseRef.current = null;
    }
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
    assistantAudioBlockUntilRef.current = Math.max(
      assistantAudioBlockUntilRef.current,
      performance.now() +
        Math.max(0, nextPlayTimeRef.current - audioContext.currentTime) * 1000 +
        ASSISTANT_AUDIO_TAIL_MS,
    );

    playbackSourcesRef.current.push(source);
    source.onended = () => {
      playbackSourcesRef.current = playbackSourcesRef.current.filter(
        (item) => item !== source,
      );
      if (pendingPhaseRef.current && !isAssistantAudioActive()) {
        updatePhase(pendingPhaseRef.current);
        pendingPhaseRef.current = null;
      }
    };
  }

  function deferPhaseUntilPlayback(nextPhase: Phase) {
    if (
      nextPhase === "listening" &&
      audioContextRef.current &&
      nextPlayTimeRef.current > audioContextRef.current.currentTime + 0.05
    ) {
      pendingPhaseRef.current = "listening";
      return;
    }

    pendingPhaseRef.current = null;
    updatePhase(nextPhase);
  }

  function ensureTenVad() {
    if (tenVadRef.current) return tenVadRef.current;
    if (!tenVadPromiseRef.current) {
      tenVadPromiseRef.current = loadBrowserTenVad()
        .then((vad) => {
          tenVadRef.current = vad;
          return vad;
        })
        .catch(() => null);
    }
    return tenVadPromiseRef.current;
  }

  function updateMicActivity(next: number, immediate = false) {
    const smoothed = immediate
      ? next
      : micActivityRef.current * 0.72 + clamp01(next) * 0.28;
    micActivityRef.current = smoothed;

    const now = performance.now();
    if (!immediate && now - lastMicActivityPaintRef.current < 70) return;

    lastMicActivityPaintRef.current = now;
    setMicActivity(smoothed);
  }

  const transcriptItems = useMemo<TranscriptItem[]>(() => {
    const items: TranscriptItem[] = turns.slice();
    if (partial) {
      const liveUserText = mergeLiveTranscript(partial.baseText, partial.text);
      const baseUserIndex = partial.baseText
        ? findMatchingUserTurnIndex(items, partial.baseText)
        : -1;

      if (baseUserIndex === -1) {
        items.push({ role: "user", text: liveUserText, live: true });
      } else {
        items[baseUserIndex] = {
          role: "user",
          text: liveUserText,
          live: true,
        };
      }
    }

    const liveItems: TranscriptItem[] = [
      ...(assistantDraft
        ? [{ role: "assistant" as const, text: assistantDraft, live: true }]
        : []),
    ];

    return [...items, ...liveItems].slice(-8);
  }, [assistantDraft, partial, turns]);

  useEffect(() => {
    const el = conversationScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcriptItems]);

  return {
    conversationScrollRef,
    error,
    isActive,
    micActivity,
    muted,
    phase,
    resetConversation,
    startConversation,
    stopConversation,
    toggleMute,
    transcriptItems,
    turns,
  };
}


function findLastTurnIndex(turns: Turn[], role: Turn["role"]) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].role === role) return index;
  }
  return -1;
}

function findMatchingUserTurnIndex(turns: Turn[], text: string) {
  const normalizedText = normalizeTranscriptText(text);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].role !== "user") continue;
    if (normalizeTranscriptText(turns[index].text) === normalizedText) return index;
  }
  return -1;
}

function mergeLiveTranscript(baseText = "", nextText: string) {
  const trimmedBase = baseText.trim();
  const trimmedNext = nextText.trim();
  if (!trimmedBase) return trimmedNext;
  if (!trimmedNext) return trimmedBase;
  return `${trimmedBase.replace(/[.?!,;:\s]+$/u, "")} ${trimmedNext}`;
}

function normalizeTranscriptText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDisplayableTranscriptText(text: string) {
  return /[\p{L}\p{N}]/u.test(text);
}
