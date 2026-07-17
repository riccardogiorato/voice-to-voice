"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  ChevronLeft,
  LoaderCircle,
  Mic,
  RotateCcw,
  Volume2,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  concatFloat32,
  createInteractiveAudioContext,
  pcm16Base64FromFloat32,
  pcm16WavBlobFromBase64,
} from "@/app/_lib/client-audio";
import {
  STT_PLAYGROUND_FALLBACK_MODELS,
  STT_PLAYGROUND_MAX_SECONDS,
  STT_PLAYGROUND_SAMPLE_RATE,
  type SttComparisonModel,
  type SttComparisonResult,
} from "@/app/_lib/stt-playground";
import { cx } from "./utils";

type ModelState =
  | { status: "pending" }
  | { status: "completed"; result: SttComparisonResult }
  | { status: "failed"; error: string };

type Recorder = {
  audioContext: AudioContext;
  nodes: AudioNode[];
  stream: MediaStream;
  samples: Float32Array[];
};

type Status = "idle" | "preparing" | "recording" | "analyzing" | "error";

function formatSeconds(durationMs: number) {
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

function formatLatency(latencyMs: number) {
  return `${(latencyMs / 1_000).toFixed(2)} s`;
}

export function SttPlayground() {
  const [status, setStatus] = useState<Status>("idle");
  const [durationMs, setDurationMs] = useState(0);
  const [models, setModels] = useState<SttComparisonModel[]>(
    STT_PLAYGROUND_FALLBACK_MODELS,
  );
  const [activeModels, setActiveModels] = useState<SttComparisonModel[] | null>(null);
  const [modelStates, setModelStates] = useState<Record<string, ModelState>>({});
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const holdRef = useRef(false);
  const startedAtRef = useRef(0);
  const animationFrameRef = useRef<number | null>(null);
  const maxDurationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackUrlRef = useRef<string | null>(null);

  const clearRecording = () => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (maxDurationTimeoutRef.current !== null) {
      clearTimeout(maxDurationTimeoutRef.current);
      maxDurationTimeoutRef.current = null;
    }

    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder) return null;

    for (const node of recorder.nodes) node.disconnect();
    for (const track of recorder.stream.getTracks()) track.stop();
    void recorder.audioContext.close();
    return recorder;
  };

  useEffect(() => {
    return () => {
      clearRecording();
      if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current);
    };
  }, []);

  useEffect(() => {
    void fetch("/api/stt-playground")
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load the Together STT catalog.");
        return (await response.json()) as { models?: SttComparisonModel[] };
      })
      .then((body) => {
        if (body.models?.length) setModels(body.models);
      })
      .catch(() => {
        // The built-in catalog remains usable if a transient catalog request fails.
      });
  }, []);

  const refreshDuration = () => {
    const nextDuration = Math.min(
      STT_PLAYGROUND_MAX_SECONDS * 1_000,
      Math.round((performance.now() - startedAtRef.current) / 100) * 100,
    );
    setDurationMs((current) => (current === nextDuration ? current : nextDuration));
    animationFrameRef.current = requestAnimationFrame(refreshDuration);
  };

  const startRecording = async () => {
    if (status === "preparing" || status === "recording" || status === "analyzing") {
      return;
    }

    holdRef.current = true;
    setError(null);
    setModelStates({});
    setActiveModels(null);
    setDurationMs(0);
    setStatus("preparing");

    let pendingStream: MediaStream | null = null;
    let pendingAudioContext: AudioContext | null = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: { ideal: STT_PLAYGROUND_SAMPLE_RATE },
          sampleSize: { ideal: 16 },
        },
      });
      const audioContext = createInteractiveAudioContext(STT_PLAYGROUND_SAMPLE_RATE);
      pendingStream = stream;
      pendingAudioContext = audioContext;
      await audioContext.resume();
      const source = audioContext.createMediaStreamSource(stream);
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      const samples: Float32Array[] = [];
      const nodes: AudioNode[] = [source, silentGain];
      // Capture immediately after the stream is available. Awaiting a worklet module here
      // was making the first words after a press unreachable by the recorder.
      const processor = audioContext.createScriptProcessor(1024, 1, 1);
      processor.onaudioprocess = (event) => {
        samples.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(silentGain);
      nodes.push(processor);
      silentGain.connect(audioContext.destination);

      recorderRef.current = { audioContext, nodes, stream, samples };
      pendingStream = null;
      pendingAudioContext = null;
      if (!holdRef.current) {
        clearRecording();
        setStatus("idle");
        return;
      }

      startedAtRef.current = performance.now();
      setStatus("recording");
      animationFrameRef.current = requestAnimationFrame(refreshDuration);
      maxDurationTimeoutRef.current = setTimeout(() => {
        void finishRecording();
      }, STT_PLAYGROUND_MAX_SECONDS * 1_000);
    } catch (caught) {
      clearRecording();
      for (const track of pendingStream?.getTracks() ?? []) track.stop();
      void pendingAudioContext?.close();
      setStatus("error");
      setError(
        caught instanceof Error
          ? `Could not access your microphone: ${caught.message}`
          : "Could not access your microphone.",
      );
    }
  };

  const finishRecording = async () => {
    holdRef.current = false;
    const recorder = clearRecording();
    if (!recorder) return;

    setDurationMs(
      Math.min(
        STT_PLAYGROUND_MAX_SECONDS * 1_000,
        Math.round(performance.now() - startedAtRef.current),
      ),
    );
    const totalSamples = recorder.samples.reduce(
      (total, samples) => total + samples.length,
      0,
    );
    const audio = pcm16Base64FromFloat32(
      concatFloat32(recorder.samples, totalSamples),
      recorder.audioContext.sampleRate,
      STT_PLAYGROUND_SAMPLE_RATE,
    );
    if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current);
    const nextPlaybackUrl = URL.createObjectURL(
      pcm16WavBlobFromBase64(audio, STT_PLAYGROUND_SAMPLE_RATE),
    );
    playbackUrlRef.current = nextPlaybackUrl;
    setPlaybackUrl(nextPlaybackUrl);

    const requestedModels = [...models];
    setActiveModels(requestedModels);
    setModelStates(
      Object.fromEntries(
        requestedModels.map((model) => [model.id, { status: "pending" }]),
      ),
    );
    setStatus("analyzing");

    await Promise.allSettled(
      requestedModels.map(async (model) => {
        try {
          const response = await fetch("/api/stt-playground", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              audio,
              model: model.id,
              sampleRate: STT_PLAYGROUND_SAMPLE_RATE,
            }),
          });
          const body = (await response.json()) as {
            error?: string;
            result?: SttComparisonResult;
          };
          const result = body.result;
          if (!response.ok || !result) {
            throw new Error(body.error ?? "Comparison failed.");
          }
          setModelStates((current) => ({
            ...current,
            [model.id]: { status: "completed", result },
          }));
        } catch (caught) {
          setModelStates((current) => ({
            ...current,
            [model.id]: {
              status: "failed",
              error: caught instanceof Error ? caught.message : "Comparison failed.",
            },
          }));
        }
      }),
    );
    setStatus("idle");
  };

  const isRecording = status === "recording";
  const isBusy = status === "preparing" || status === "analyzing";
  const hasModelStates = Object.keys(modelStates).length > 0;
  const displayedModels = activeModels ?? models;

  return (
    <main className="min-h-screen bg-[#f8f7ff] px-5 py-6 text-[#151320] sm:px-8 sm:py-8">
      <div className="mx-auto max-w-5xl">
        <Link
          href="/"
          className="inline-flex min-h-10 items-center gap-1 rounded-full px-3 text-sm font-semibold text-[#151320]/62 transition-[color,background-color] duration-150 hover:bg-[#151320]/5 hover:text-[#151320]"
        >
          <ChevronLeft className="size-4" aria-hidden />
          Voice demo
        </Link>

        <section className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)] lg:items-center">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-[#8e35d5]">
              <AudioLines className="size-4" aria-hidden />
              Same audio. Every Together serverless STT model.
            </div>
            <h1 className="mt-4 max-w-xl text-4xl font-semibold tracking-[-0.045em] text-balance sm:text-5xl">
              How does Inkling compare with every Together STT model?
            </h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-[#151320]/62 text-pretty">
              Hold to speak, then release. The exact same recording is sent to every
              Together serverless speech-to-text model and Inkling — no VAD, reply
              model, or TTS involved.
            </p>
          </div>

          <div className="rounded-[30px] bg-white p-5 shadow-[0_1px_2px_rgba(20,16,32,0.05),0_22px_60px_rgba(51,36,85,0.10)] sm:p-7">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold">Push-to-transcribe</p>
                <p className="mt-1 text-sm text-[#151320]/52">
                  Up to {STT_PLAYGROUND_MAX_SECONDS} seconds per recording
                </p>
              </div>
              <span className="font-mono text-sm tabular-nums text-[#151320]/48">
                {isRecording ? formatSeconds(durationMs) : "ready"}
              </span>
            </div>

            <button
              aria-label="Hold to record audio for transcription comparison"
              aria-pressed={isRecording}
              className={cx(
                "mt-7 flex min-h-44 w-full select-none flex-col items-center justify-center rounded-[23px] bg-[#181424] px-6 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_16px_32px_rgba(34,24,61,0.20)] transition-[scale,background-color,box-shadow] duration-150 active:scale-[0.96] disabled:cursor-wait",
                isRecording && "bg-[#b92075] shadow-[inset_0_1px_0_rgba(255,255,255,0.23),0_16px_32px_rgba(185,32,117,0.26)]",
              )}
              disabled={isBusy}
              onKeyDown={(event) => {
                if ((event.key === " " || event.key === "Enter") && !event.repeat) {
                  event.preventDefault();
                  void startRecording();
                }
              }}
              onKeyUp={(event) => {
                if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  void finishRecording();
                }
              }}
              onPointerCancel={() => void finishRecording()}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                void startRecording();
              }}
              onPointerUp={() => void finishRecording()}
              type="button"
            >
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                  key={isRecording ? "recording" : isBusy ? "busy" : "idle"}
                  className="flex flex-col items-center"
                  initial={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
                  animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                  exit={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
                  transition={{ type: "spring", duration: 0.3, bounce: 0 }}
                >
                  {isBusy ? (
                    <LoaderCircle className="size-8 animate-spin" aria-hidden />
                  ) : (
                    <Mic className="size-8" aria-hidden />
                  )}
                  <span className="mt-3 text-base font-semibold">
                    {isRecording
                      ? "Release to compare"
                      : status === "preparing"
                        ? "Opening microphone…"
                        : status === "analyzing"
                          ? "Comparing transcripts…"
                          : "Hold to speak"}
                  </span>
                  <span className="mt-1 text-sm text-white/58">
                    {isRecording ? formatSeconds(durationMs) : "Press and hold"}
                  </span>
                </motion.span>
              </AnimatePresence>
            </button>

            {error ? (
              <div className="mt-4 flex items-center justify-between gap-3 rounded-[16px] bg-[#fff2f6] px-4 py-3 text-sm leading-5 text-[#992351]">
                <span>{error}</span>
                <button
                  className="inline-flex min-h-10 shrink-0 items-center gap-1 rounded-full px-2 font-semibold transition-[color,background-color] duration-150 hover:bg-[#992351]/8"
                  onClick={() => {
                    setError(null);
                    setStatus("idle");
                  }}
                  type="button"
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  Retry
                </button>
              </div>
            ) : null}
            {playbackUrl ? (
              <div className="mt-4 rounded-[18px] bg-[#f5f3fc] p-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-[#151320]">
                  <Volume2 className="size-4 text-[#8e35d5]" aria-hidden />
                  Listen to the exact clip sent to the models
                </div>
                <p className="mt-1 text-xs leading-5 text-[#151320]/52">
                  16 kHz mono PCM, wrapped as WAV only so your browser can play it.
                </p>
                <audio
                  aria-label="Recorded audio sent to transcription models"
                  className="mt-3 h-10 w-full"
                  controls
                  preload="metadata"
                  src={playbackUrl}
                />
              </div>
            ) : null}
          </div>
        </section>

        <section className="mt-12" aria-live="polite">
          <div className="flex items-end justify-between gap-5">
            <div>
              <p className="text-sm font-semibold text-[#151320]/52">Comparison</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.035em]">
                {hasModelStates ? "Latest recording" : "Waiting for a recording"}
              </h2>
            </div>
            {hasModelStates ? (
              <span className="hidden text-sm text-[#151320]/48 sm:block">
                Same 16 kHz PCM audio, one request per model
              </span>
            ) : null}
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {displayedModels.map((model, index) => {
              const modelState = modelStates[model.id];
              const isAudioChat = model.kind === "audio-chat";
              const result =
                modelState?.status === "completed" ? modelState.result : undefined;
              return (
                <motion.article
                  key={model.id}
                  className={cx(
                    "min-h-56 rounded-[24px] bg-white p-5 shadow-[0_1px_2px_rgba(20,16,32,0.04),0_12px_30px_rgba(51,36,85,0.06)]",
                    isAudioChat && "bg-[#f1ebff]",
                  )}
                  initial={false}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  transition={{ duration: 0.28, delay: hasModelStates ? index * 0.08 : 0 }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">{model.label}</h3>
                      <p
                        className={cx(
                          "mt-1 break-all font-mono text-[11px] leading-4 text-[#151320]/42",
                          isAudioChat && "text-[#513087]/58",
                        )}
                      >
                        {model.model}
                      </p>
                    </div>
                    {result ? (
                      <span
                        className={cx(
                          "shrink-0 rounded-full bg-[#151320]/5 px-2 py-1 font-mono text-[11px] tabular-nums text-[#151320]/55",
                          isAudioChat && "bg-[#8e35d5]/10 text-[#513087]/70",
                        )}
                      >
                        {formatLatency(result.latencyMs)}
                      </span>
                    ) : null}
                  </div>
                  <div
                    className={cx(
                      "mt-7 text-base leading-7 text-[#151320]/82 text-pretty",
                      isAudioChat && "text-[#35214f]/86",
                    )}
                  >
                    {modelState?.status === "pending" ? (
                      <span className="inline-flex items-center gap-2 text-[#151320]/48">
                        <LoaderCircle className="size-4 animate-spin" aria-hidden />
                        Comparing…
                      </span>
                    ) : modelState?.status === "failed" ? (
                      <span className="text-[#bf285f]">{modelState.error}</span>
                    ) : result?.error ? (
                      <span className="text-[#bf285f]">{result.error}</span>
                    ) : result?.transcript ? (
                      result.transcript
                    ) : hasModelStates ? (
                      "No transcript returned."
                    ) : (
                      <span className={isAudioChat ? "text-[#513087]/52" : "text-[#151320]/36"}>
                        Ready to compare.
                      </span>
                    )}
                  </div>
                </motion.article>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
