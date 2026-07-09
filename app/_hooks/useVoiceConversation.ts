"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  base64Pcm16ToFloat32,
  BrowserTenVad,
  concatFloat32,
  createMicWorkletUrl,
  createThinkingSound,
  float32ToBase64,
  getVoiceSocketUrl,
  loadBrowserTenVad,
  clamp01,
  normalizeRange,
  rms,
  type ThinkingSoundHandle,
} from "@/app/_lib/client-audio";

type Phase = "idle" | "connecting" | "listening" | "thinking" | "speaking";

export type Turn = {
  role: "user" | "assistant";
  text: string;
  // User turns render in a "drafting" style until repair lands or the
  // settle window passes; after that the text never changes again.
  settled?: boolean;
};

type TranscriptItem = Turn & {
  live?: boolean;
};

type DebugEntry = {
  at: string;
  direction: "client" | "server" | "system";
  type: string;
  payload?: unknown;
};

export type PartialTranscript = {
  text: string;
  baseText?: string;
};

export type AssistantWordTiming = {
  word: string;
  startSeconds: number;
  endSeconds: number;
};

export type AssistantWordTrack = {
  startedAt: number;
  timings: AssistantWordTiming[];
};

type ServerEvent =
  | { type: "state"; state: Phase }
  | { type: "transcript.delta"; text: string; baseText?: string; merged?: boolean }
  | { type: "transcript.final"; text: string; merged?: boolean }
  | { type: "transcript.updated"; text: string }
  | { type: "transcript.ignored"; text?: string }
  | { type: "assistant.delta"; text: string }
  | {
      type: "assistant.words";
      itemId: string;
      words: string[];
      startSeconds: number[];
      endSeconds: number[];
    }
  | { type: "audio.delta"; audio: string; sampleRate: number; itemId?: string }
  | { type: "audio.done" }
  | { type: "audio.clear" }
  | { type: "error"; message: string };

type ClientEvent =
  | { type: "conversation.start"; history?: Turn[] }
  | { type: "conversation.reset" }
  | { type: "conversation.stop" }
  | { type: "response.cancel" }
  | { type: "speech.started" }
  | { type: "audio.commit" }
  | { type: "audio.input"; audio: string; sampleRate: number };

const BARGE_IN_VAD_THRESHOLD = 0.72;
const BARGE_IN_LEVEL_THRESHOLD = 0.035;
const BARGE_IN_SUSTAIN_MS = 1_000;
const BARGE_IN_CAPTURE_HOLD_MS = 1_500;
const ASSISTANT_AUDIO_TAIL_MS = 850;
const SPEAKING_WATCHDOG_MS = 20_000;
const VAD_SPEECH_HOLD_MS = 700;
const MAX_SPEECH_SEGMENT_MS = 8_000;
const VAD_DEBUG_INTERVAL_MS = 1_000;
const MIC_ACTIVITY_RMS_FLOOR = 0.024;
const MIN_SPEECH_MS = 380;
const MIN_AUDIO_CHUNK_MS = 80;
const PRE_ROLL_MS = 320;
// Server caps repair at 800ms; after this window the bubble solidifies and
// its text never changes again.
const TRANSCRIPT_SETTLE_MS = 1000;
const MAX_COMMITTED_TURNS = 24;
const MAX_VISIBLE_TRANSCRIPT_ITEMS = 8;

export function useVoiceConversation() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [partial, setPartial] = useState<PartialTranscript | null>(null);
  const [assistantDraft, setAssistantDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [micActivity, setMicActivity] = useState(0);
  const [debugCopied, setDebugCopied] = useState(false);
  const [debugVersion, setDebugVersion] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const inputSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const playbackSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const thinkingSoundRef = useRef<ThinkingSoundHandle | null>(null);
  const assistantDraftRef = useRef("");
  const assistantGeneratedTextRef = useRef("");
  const ttsAudioStartsRef = useRef(new Map<string, number>());
  const ttsWordTimingsRef = useRef(new Map<string, AssistantWordTiming[]>());
  const wordSyncFrameRef = useRef<number | null>(null);
  const nextPlayTimeRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  const micBufferRef = useRef<Float32Array[]>([]);
  const micBufferSamplesRef = useRef(0);
  const lastSpeechAtRef = useRef(Number.NEGATIVE_INFINITY);
  const speechOpenRef = useRef(false);
  const bargeInStartedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const bargeInCaptureUntilRef = useRef(Number.NEGATIVE_INFINITY);
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
  const debugLogRef = useRef<DebugEntry[]>([]);
  const lastDebugPaintRef = useRef(0);
  const lastVadDebugAtRef = useRef(Number.NEGATIVE_INFINITY);
  const lastVadDebugRef = useRef<Record<string, unknown> | null>(null);
  const pendingPlaybackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speakingWatchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assistantFinalizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isActive = phase !== "idle";

  function resetConversation() {
    clearPlayback();
    resetAssistantSpeechTracking();
    setTurns([]);
    setPartial(null);
    setAssistantDraft("");
    setError("");
    clearDebugLog();
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      sendClientEvent({ type: "conversation.reset" });
    }
  }

  async function copyDebugLog() {
    const snapshot = {
      copiedAt: new Date().toISOString(),
      phase: phaseRef.current,
      muted: mutedRef.current,
      turns,
      partial,
      assistantDraft,
      vad: {
        loaded: Boolean(tenVadRef.current),
        speechOpen: speechOpenRef.current,
        last: lastVadDebugRef.current,
      },
      entries: debugLogRef.current,
    };

    await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
    setDebugCopied(true);
    window.setTimeout(() => setDebugCopied(false), 1400);
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
      bargeInStartedAtRef.current = Number.NEGATIVE_INFINITY;
    }
    if (nextPhase === "thinking") {
      startThinkingSound();
    } else {
      stopThinkingSound();
    }
    if (nextPhase === "speaking") {
      scheduleSpeakingWatchdog();
    } else {
      clearSpeakingWatchdog();
    }
    setPhase(nextPhase);
  }

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);


  async function startConversation() {
    if (isActive) return;

    clearDebugLog();
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
      const vad = await ensureTenVad();
      if (!vad) throw new Error("Voice detection failed to load.");

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
        appendDebug("system", "socket.open", { url: getVoiceSocketUrl() });
        sendClientEvent({ type: "conversation.start", history: turns });
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
        appendDebug("system", "socket.error");
        setError("Voice socket failed. Try a deployed Vercel URL if local dev cannot upgrade WebSockets.");
        updatePhase("idle");
      };

      socket.onclose = () => {
        appendDebug("system", "socket.close");
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
    appendDebug("server", event.type, event);

    if (event.type === "state") {
      if (event.state === "thinking") {
        resetAssistantSpeechTracking();
      }
      deferPhaseUntilPlayback(event.state);
      return;
    }

    if (event.type === "transcript.delta") {
      setPartial(getTranscriptPartialFromDelta(event));
      return;
    }

    if (event.type === "transcript.final") {
      setPartial(null);
      setTurns((current) => applyTranscriptFinalToTurns(current, event));
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        setTurns((current) => settleLastUserTurn(current));
      }, TRANSCRIPT_SETTLE_MS);
      return;
    }

    if (event.type === "transcript.updated") {
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      setTurns((current) => applyTranscriptUpdateToTurns(current, event.text));
      return;
    }

    if (event.type === "transcript.ignored") {
      setPartial(null);
      return;
    }

    if (event.type === "assistant.delta") {
      scheduleSpeakingWatchdog();
      assistantGeneratedTextRef.current += event.text;
      return;
    }

    if (event.type === "assistant.words") {
      storeAssistantWordTimings(event);
      return;
    }

    if (event.type === "audio.delta") {
      scheduleSpeakingWatchdog();
      playPcm16(event.audio, event.sampleRate, event.itemId);
      return;
    }

    if (event.type === "audio.done") {
      scheduleAssistantFinalizeAfterPlayback();
      deferPhaseUntilPlayback("listening");
      return;
    }

    if (event.type === "audio.clear") {
      commitInterruptedAssistantDraft();
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
    sendClientEvent({ type: "conversation.stop" });
    socketRef.current?.close();
    socketRef.current = null;
    tearDownAudio();
    updatePhase("idle");
    setPartial(null);
    resetAssistantSpeechTracking();
    setMicActivity(0);
  }

  useEffect(() => {
    void ensureTenVad();

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
    stopThinkingSound();
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
    clearPendingPlaybackTimer();
    clearSpeakingWatchdog();
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

  function isLocalAppAudioActive() {
    return Boolean(thinkingSoundRef.current) || isAssistantAudioActive();
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
    const level = rms(input);
    const vad = tenVadRef.current;
    const vadDecision = vad?.process(input, sampleRate) ?? null;
    const vadSpeech = vadDecision?.isSpeech ?? null;
    const hasSpeech = detectOpenSpeech({
      vadSpeech,
    });
    const hasBargeInSpeech = detectBargeInSpeech({
      level,
      vadProbability: vadDecision?.probability ?? null,
    });
    const assistantBlocking = isAssistantAudioBlockingMic(now) || phaseRef.current === "speaking";
    const bargeInReady = detectSustainedBargeIn({
      hasBargeInSpeech,
      startedAt: bargeInStartedAtRef.current,
      now,
    });
    let bufferedSpeech = detectBufferedSpeech({
      hasSpeech,
      hasBargeInSpeech,
      bargeInCaptureActive: now < bargeInCaptureUntilRef.current,
    });

    appendVadDebug({
      now,
      level,
      vadProbability: vadDecision?.probability ?? null,
      vadSpeech,
      hasSpeech,
      hasBargeInSpeech,
      bargeInReady,
      bufferedSpeech,
      speechOpen: speechOpenRef.current,
      sampleRate,
    });

    if (assistantBlocking) {
      if (!hasBargeInSpeech) {
        resetMicGate();
        bargeInStartedAtRef.current = Number.NEGATIVE_INFINITY;
        return;
      }

      if (bargeInStartedAtRef.current === Number.NEGATIVE_INFINITY) {
        bargeInStartedAtRef.current = now;
        resetMicGate();
        return;
      }

      if (!bargeInReady) {
        resetMicGate();
        return;
      }

      sendClientEvent({ type: "response.cancel" }, socket);
      commitInterruptedAssistantDraft();
      clearPlayback();
      updatePhase("listening");
      bargeInCaptureUntilRef.current = now + BARGE_IN_CAPTURE_HOLD_MS;
      bufferedSpeech = true;
    }

    updateMicActivity(
      vadDecision
        ? normalizeRange(vadDecision.probability, 0.18, 0.92)
        : normalizeRange(
            level,
            MIC_ACTIVITY_RMS_FLOOR * 0.35,
            MIC_ACTIVITY_RMS_FLOOR * 1.8,
          ),
    );

    if (bufferedSpeech) {
      if (hasBargeInSpeech) {
        bargeInCaptureUntilRef.current = now + BARGE_IN_CAPTURE_HOLD_MS;
      }
      // Pre-roll must lead the opening frame or speech onsets are clipped.
      if (!speechOpenRef.current) {
        const nextPhase = getPhaseAfterLocalSpeechStart(phaseRef.current);
        if (nextPhase !== phaseRef.current) updatePhase(nextPhase);
        sendClientEvent({ type: "speech.started" }, socket);
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

    const inSpeechTail = shouldKeepSpeechOpen({
      now,
      lastSpeechAt: lastSpeechAtRef.current,
    });
    const speechDuration = now - speechOpenedAtRef.current;
    const segmentTimedOut =
      speechOpenRef.current && speechDuration >= MAX_SPEECH_SEGMENT_MS;
    if (!inSpeechTail || segmentTimedOut) {
      if (speechOpenRef.current) {
        if (speechDuration >= MIN_SPEECH_MS) {
          if (segmentTimedOut && bufferedSpeech) {
            const copy = new Float32Array(input);
            micBufferRef.current.push(copy);
            micBufferSamplesRef.current += copy.length;
          }
          flushSpeechAudio(socket, sampleRate);
          sendClientEvent({ type: "audio.commit" }, socket);
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
    bargeInCaptureUntilRef.current = Number.NEGATIVE_INFINITY;
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

    sendClientEvent(
      {
        type: "audio.input",
        audio: float32ToBase64(chunk),
        sampleRate,
      },
      socket,
    );
  }

  function sendClientEvent(event: ClientEvent, socket = socketRef.current) {
    appendDebug("client", event.type, event);
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(event));
    }
  }

  function appendVadDebug({
    now,
    level,
    vadProbability,
    vadSpeech,
    hasSpeech,
    hasBargeInSpeech,
    bargeInReady,
    bufferedSpeech,
    speechOpen,
    sampleRate,
  }: {
    now: number;
    level: number;
    vadProbability: number | null;
    vadSpeech: boolean | null;
    hasSpeech: boolean;
    hasBargeInSpeech: boolean;
    bargeInReady: boolean;
    bufferedSpeech: boolean;
    speechOpen: boolean;
    sampleRate: number;
  }) {
    const speechDurationMs =
      speechOpenedAtRef.current === Number.NEGATIVE_INFINITY
        ? 0
        : Math.max(0, Math.round(now - speechOpenedAtRef.current));
    const payload = {
      probability:
        vadProbability === null ? null : Number(vadProbability.toFixed(3)),
      isSpeech: vadSpeech,
      hasSpeech,
      hasBargeInSpeech,
      bargeInReady,
      bufferedSpeech,
      speechOpen,
      speechDurationMs,
      level: Number(level.toFixed(5)),
      sampleRate,
    };
    lastVadDebugRef.current = payload;
    if (now - lastVadDebugAtRef.current < VAD_DEBUG_INTERVAL_MS) return;
    lastVadDebugAtRef.current = now;
    appendDebug("system", "vad.summary", payload);
  }

  function appendDebug(
    direction: DebugEntry["direction"],
    type: string,
    payload?: unknown,
  ) {
    if ((type === "audio.input" || type === "audio.delta") && !shouldKeepAudioDebug()) {
      return;
    }

    const entry: DebugEntry = {
      at: new Date().toISOString(),
      direction,
      type,
      ...(payload === undefined ? {} : { payload: sanitizeDebugPayload(payload) }),
    };
    debugLogRef.current = [...debugLogRef.current.slice(-299), entry];
    if (type !== "audio.input") {
      console.debug("[voice-debug]", entry);
    }

    const now = performance.now();
    if (now - lastDebugPaintRef.current < 250) return;
    lastDebugPaintRef.current = now;
    setDebugVersion((version) => version + 1);
  }

  function shouldKeepAudioDebug() {
    const last = debugLogRef.current.at(-1);
    if (!last || (last.type !== "audio.input" && last.type !== "audio.delta")) return true;

    const elapsedMs = Date.now() - Date.parse(last.at);
    return Number.isNaN(elapsedMs) || elapsedMs > 1000;
  }

  function clearDebugLog() {
    debugLogRef.current = [];
    lastDebugPaintRef.current = 0;
    lastVadDebugAtRef.current = Number.NEGATIVE_INFINITY;
    lastVadDebugRef.current = null;
    setDebugCopied(false);
    setDebugVersion((version) => version + 1);
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
    bargeInCaptureUntilRef.current = Number.NEGATIVE_INFINITY;
    pcmLeftoverRef.current = null;
    if (pendingPhaseRef.current) {
      flushPendingPhase();
    }
  }

  function setAssistantDraftText(text: string) {
    assistantDraftRef.current = text;
    setAssistantDraft(text);
  }

  function storeAssistantWordTimings(event: Extract<ServerEvent, { type: "assistant.words" }>) {
    const timings = event.words
      .map((word, index) => ({
        word,
        startSeconds: Number(event.startSeconds[index]),
        endSeconds: Number(event.endSeconds[index]),
      }))
      .filter(
        (timing) =>
          timing.word.trim().length > 0 &&
          Number.isFinite(timing.startSeconds) &&
          Number.isFinite(timing.endSeconds),
      );

    if (timings.length === 0 || !event.itemId) return;

    if (
      ttsWordTimingsRef.current.size === 0 &&
      assistantDraftRef.current.trim() === assistantGeneratedTextRef.current.trim()
    ) {
      setAssistantDraftText("");
    }

    ttsWordTimingsRef.current.set(
      event.itemId,
      mergeAssistantWordTimings(
        ttsWordTimingsRef.current.get(event.itemId) ?? [],
        timings,
        getPlaybackElapsedForItem(event.itemId),
      ),
    );
    const receivedText = buildReceivedWordText([
      ...ttsWordTimingsRef.current.values(),
    ]);
    const nextDraft = selectAssistantDraftText(
      assistantDraftRef.current,
      receivedText,
    );
    if (nextDraft !== assistantDraftRef.current) setAssistantDraftText(nextDraft);
    startAssistantWordSync();
  }

  function getPlaybackElapsedForItem(itemId: string) {
    const audioContext = audioContextRef.current;
    const startedAt = ttsAudioStartsRef.current.get(itemId);
    if (!audioContext || startedAt === undefined) return undefined;
    return Math.max(0, audioContext.currentTime - startedAt);
  }

  function scheduleAssistantWordsForItem(itemId: string) {
    if (!ttsAudioStartsRef.current.has(itemId)) return;
    if (!ttsWordTimingsRef.current.has(itemId)) return;
    startAssistantWordSync();
  }

  function startAssistantWordSync() {
    if (wordSyncFrameRef.current !== null) return;

    const tick = () => {
      wordSyncFrameRef.current = null;
      updateAssistantDraftFromPlaybackClock();
      if (ttsWordTimingsRef.current.size > 0 && isAssistantAudioActive()) {
        wordSyncFrameRef.current = requestAnimationFrame(tick);
      }
    };

    wordSyncFrameRef.current = requestAnimationFrame(tick);
  }

  function updateAssistantDraftFromPlaybackClock() {
    const audioContext = audioContextRef.current;
    if (!audioContext) return;

    const tracks: AssistantWordTrack[] = [];
    for (const [itemId, timings] of ttsWordTimingsRef.current) {
      const startedAt = ttsAudioStartsRef.current.get(itemId);
      if (startedAt === undefined) continue;
      tracks.push({ startedAt, timings });
    }

    const spokenText = buildSpokenTextAtTime(tracks, audioContext.currentTime);
    const nextDraft = selectAssistantDraftText(
      assistantDraftRef.current,
      spokenText,
    );
    if (nextDraft !== assistantDraftRef.current) {
      setAssistantDraftText(nextDraft);
    }
  }

  function scheduleAssistantFinalizeAfterPlayback() {
    clearAssistantFinalizeTimer();
    const audioContext = audioContextRef.current;
    const delayMs = audioContext
      ? Math.max(0, nextPlayTimeRef.current - audioContext.currentTime) * 1000 + 80
      : 0;

    assistantFinalizeTimerRef.current = setTimeout(() => {
      assistantFinalizeTimerRef.current = null;
      commitCompletedAssistantDraft();
    }, delayMs);
  }

  function commitCompletedAssistantDraft() {
    const text =
      selectCompletedAssistantText(
        assistantDraftRef.current,
        assistantGeneratedTextRef.current,
      );
    commitAssistantText(text);
    resetAssistantSpeechTracking();
  }

  function commitInterruptedAssistantDraft() {
    const text = assistantDraftRef.current.trim();
    commitAssistantText(text);
    resetAssistantSpeechTracking();
  }

  function commitAssistantText(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setTurns((current) => appendAssistantTurn(current, trimmed));
  }

  function resetAssistantSpeechTracking() {
    clearAssistantFinalizeTimer();
    clearAssistantWordSync();
    assistantGeneratedTextRef.current = "";
    ttsAudioStartsRef.current.clear();
    ttsWordTimingsRef.current.clear();
    setAssistantDraftText("");
  }

  function clearAssistantFinalizeTimer() {
    if (!assistantFinalizeTimerRef.current) return;
    clearTimeout(assistantFinalizeTimerRef.current);
    assistantFinalizeTimerRef.current = null;
  }

  function clearAssistantWordSync() {
    if (wordSyncFrameRef.current === null) return;
    cancelAnimationFrame(wordSyncFrameRef.current);
    wordSyncFrameRef.current = null;
  }

  function startThinkingSound() {
    const audioContext = audioContextRef.current;
    if (!audioContext || thinkingSoundRef.current) return;

    thinkingSoundRef.current = createThinkingSound(audioContext);
  }

  function stopThinkingSound() {
    const sound = thinkingSoundRef.current;
    if (!sound) return;
    thinkingSoundRef.current = null;
    sound.stop();
  }

  function playPcm16(base64: string, sampleRate: number, itemId?: string) {
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
    if (itemId && !ttsAudioStartsRef.current.has(itemId)) {
      ttsAudioStartsRef.current.set(itemId, startAt);
      scheduleAssistantWordsForItem(itemId);
    }
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
        flushPendingPhase();
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
      schedulePendingPlaybackFallback();
      return;
    }

    clearPendingPlaybackTimer();
    pendingPhaseRef.current = null;
    updatePhase(nextPhase);
  }

  function schedulePendingPlaybackFallback() {
    clearPendingPlaybackTimer();
    const audioContext = audioContextRef.current;
    if (!audioContext) return;

    const delayMs =
      Math.max(0, nextPlayTimeRef.current - audioContext.currentTime) * 1000 +
      ASSISTANT_AUDIO_TAIL_MS +
      80;

    pendingPlaybackTimerRef.current = setTimeout(() => {
      if (!pendingPhaseRef.current) return;
      clearPlayback();
      assistantAudioBlockUntilRef.current = Number.NEGATIVE_INFINITY;
      pendingPhaseRef.current = null;
      updatePhase("listening");
    }, delayMs);
  }

  function flushPendingPhase() {
    const nextPhase = pendingPhaseRef.current;
    if (!nextPhase) return;
    clearPendingPlaybackTimer();
    pendingPhaseRef.current = null;
    updatePhase(nextPhase);
  }

  function clearPendingPlaybackTimer() {
    if (!pendingPlaybackTimerRef.current) return;
    clearTimeout(pendingPlaybackTimerRef.current);
    pendingPlaybackTimerRef.current = null;
  }

  function scheduleSpeakingWatchdog() {
    clearSpeakingWatchdog();
    speakingWatchdogTimerRef.current = setTimeout(() => {
      if (phaseRef.current !== "speaking") return;
      clearPlayback();
      assistantAudioBlockUntilRef.current = Number.NEGATIVE_INFINITY;
      pendingPhaseRef.current = null;
      updatePhase("listening");
    }, SPEAKING_WATCHDOG_MS);
  }

  function clearSpeakingWatchdog() {
    if (!speakingWatchdogTimerRef.current) return;
    clearTimeout(speakingWatchdogTimerRef.current);
    speakingWatchdogTimerRef.current = null;
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
    return buildTranscriptItems({ turns, partial, assistantDraft });
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
    copyDebugLog,
    debugCopied,
    debugEntries: debugLogRef.current,
    debugVersion,
  };
}


export function applyTranscriptFinalToTurns(
  turns: Turn[],
  event: { text: string; merged?: boolean },
) {
  const next = turns.slice();
  const lastIndex = next.length - 1;
  const shouldUpdateCurrentUser =
    event.merged && lastIndex >= 0 && next[lastIndex].role === "user";

  if (shouldUpdateCurrentUser) {
    next[lastIndex] = { role: "user", text: event.text, settled: false };
    return trimCommittedTurns(next);
  }

  return trimCommittedTurns([
    ...next,
    { role: "user", text: event.text, settled: false },
  ]);
}

export function applyTranscriptUpdateToTurns(turns: Turn[], text: string) {
  const next = turns.slice();
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (next[i].role === "user") {
      next[i] = { role: "user", text, settled: true };
      break;
    }
  }
  return next;
}

export function settleLastUserTurn(turns: Turn[]) {
  const next = turns.slice();
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (next[i].role === "user") {
      if (next[i].settled) return turns;
      next[i] = { ...next[i], settled: true };
      break;
    }
  }
  return next;
}

export function getPhaseAfterLocalSpeechStart(phase: Phase): Phase {
  return phase === "thinking" ? "listening" : phase;
}

export function detectBargeInSpeech({
  level,
  vadProbability,
}: {
  level: number;
  vadProbability: number | null;
}) {
  return (
    (vadProbability !== null && vadProbability >= BARGE_IN_VAD_THRESHOLD) ||
    level >= BARGE_IN_LEVEL_THRESHOLD
  );
}

export function detectOpenSpeech({
  vadSpeech,
}: {
  vadSpeech: boolean | null;
}) {
  return vadSpeech ?? false;
}

export function detectBufferedSpeech({
  hasSpeech,
  hasBargeInSpeech,
  bargeInCaptureActive,
}: {
  hasSpeech: boolean;
  hasBargeInSpeech: boolean;
  bargeInCaptureActive: boolean;
}) {
  return hasSpeech || (bargeInCaptureActive && hasBargeInSpeech);
}

export function detectSustainedBargeIn({
  hasBargeInSpeech,
  startedAt,
  now,
}: {
  hasBargeInSpeech: boolean;
  startedAt: number;
  now: number;
}) {
  return (
    hasBargeInSpeech &&
    startedAt !== Number.NEGATIVE_INFINITY &&
    now - startedAt >= BARGE_IN_SUSTAIN_MS
  );
}

export function shouldKeepSpeechOpen({
  now,
  lastSpeechAt,
}: {
  now: number;
  lastSpeechAt: number;
}) {
  return now - lastSpeechAt <= VAD_SPEECH_HOLD_MS;
}

export function appendSpokenWordText(current: string, word: string) {
  const trimmedCurrent = current.trim();
  const trimmedWord = word.trim();
  if (!trimmedWord) return trimmedCurrent;
  if (!trimmedCurrent) return trimmedWord;
  return `${trimmedCurrent} ${trimmedWord}`;
}

export function buildSpokenTextAtTime(
  tracks: AssistantWordTrack[],
  currentTime: number,
  leadSeconds = 0.12,
) {
  return tracks
    .flatMap((track) =>
      track.timings
        .filter((timing) => track.startedAt + timing.startSeconds <= currentTime + leadSeconds)
        .map((timing) => timing.word),
    )
    .reduce(appendSpokenWordText, "");
}

export function buildReceivedWordText(timingGroups: AssistantWordTiming[][]) {
  return timingGroups
    .flatMap((timings) => timings.map((timing) => timing.word))
    .reduce(appendSpokenWordText, "");
}

export function selectAssistantDraftText(current: string, next: string) {
  const currentWordCount = countDisplayWords(current);
  const nextWordCount = countDisplayWords(next);
  return nextWordCount >= currentWordCount ? next : current;
}

export function mergeAssistantWordTimings(
  existing: AssistantWordTiming[],
  incoming: AssistantWordTiming[],
  playbackElapsedSeconds?: number,
) {
  if (existing.length === 0) return incoming;
  if (incoming.length === 0) return existing;

  const last = existing[existing.length - 1];
  const firstIncoming = incoming[0];
  const isResetBatch = firstIncoming.startSeconds < last.endSeconds;
  const playbackOffset =
    playbackElapsedSeconds === undefined
      ? undefined
      : Math.max(0, playbackElapsedSeconds - firstIncoming.startSeconds);
  const offset = isResetBatch ? playbackOffset ?? last.endSeconds : 0;

  return [
    ...existing,
    ...incoming.map((timing) => ({
      ...timing,
      startSeconds: timing.startSeconds + offset,
      endSeconds: timing.endSeconds + offset,
    })),
  ];
}

export function selectCompletedAssistantText(draft: string, generated: string) {
  return generated.trim() || draft.trim();
}

function countDisplayWords(text: string) {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

export function appendAssistantTurn(turns: Turn[], text: string) {
  return trimCommittedTurns([...turns, { role: "assistant", text }]);
}

export function buildTranscriptItems({
  turns,
  partial,
  assistantDraft,
}: {
  turns: Turn[];
  partial: PartialTranscript | null;
  assistantDraft: string;
}): TranscriptItem[] {
  const items: TranscriptItem[] = turns.slice();

  if (partial) {
    const liveUserText = mergeLiveTranscript(partial.baseText, partial.text);
    const lastIndex = items.length - 1;
    const shouldUpdateCurrentUser =
      lastIndex >= 0 &&
      items[lastIndex].role === "user" &&
      partial.baseText !== undefined &&
      normalizeTranscriptText(items[lastIndex].text) ===
        normalizeTranscriptText(partial.baseText);

    if (shouldUpdateCurrentUser) {
      items[lastIndex] = {
        role: "user",
        text: liveUserText,
        live: true,
      };
    } else {
      items.push({ role: "user", text: liveUserText, live: true });
    }
  }

  if (assistantDraft.trim()) {
    items.push({ role: "assistant", text: assistantDraft, live: true });
  }

  return items.slice(-MAX_VISIBLE_TRANSCRIPT_ITEMS);
}

function trimCommittedTurns(turns: Turn[]) {
  return turns.slice(-MAX_COMMITTED_TURNS);
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

export function getTranscriptPartialFromDelta(event: {
  text: string;
  baseText?: string;
}): PartialTranscript | null {
  const text = event.text;
  const baseText = event.baseText ?? "";
  const hasDisplayableText = isDisplayableTranscriptText(text);
  const hasDisplayableBase = isDisplayableTranscriptText(baseText);

  if (!hasDisplayableText && !hasDisplayableBase) return null;

  return {
    text: hasDisplayableText ? text : "",
    baseText: hasDisplayableBase ? baseText : undefined,
  };
}

function sanitizeDebugPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) return payload.map(sanitizeDebugPayload);

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "audio" && typeof value === "string") {
      output[key] = `[base64:${value.length}]`;
    } else if (key === "history" && Array.isArray(value)) {
      output[key] = value.map(sanitizeDebugPayload);
    } else {
      output[key] = sanitizeDebugPayload(value);
    }
  }
  return output;
}
