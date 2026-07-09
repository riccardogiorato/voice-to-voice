"use client";

import {
  Clipboard,
  Clock3,
  Cpu,
  Mic,
  MicOff,
  RotateCcw,
  SlidersHorizontal,
  TriangleAlert,
  X,
} from "lucide-react";
import Image from "next/image";
import type { CSSProperties } from "react";
import { useState } from "react";
import type { useVoiceConversation } from "@/app/_hooks/useVoiceConversation";

type VoiceConversation = ReturnType<typeof useVoiceConversation>;

const phaseCopy: Record<VoiceConversation["phase"], { label: string; detail: string }> = {
  idle: {
    label: "Tap the orb",
    detail: "Start talking",
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

export function VoicePhone({ voice }: { voice: VoiceConversation }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const status =
    voice.muted && voice.isActive
      ? { label: "Muted", detail: "Tap the mic to resume" }
      : phaseCopy[voice.phase];
  const waveformVisible = voice.phase === "listening" && !voice.muted;
  const orbStyle = {
    "--voice-activity": waveformVisible ? voice.micActivity.toFixed(3) : "0",
  } as CSSProperties;

  return (
    <main className="min-h-dvh overflow-hidden bg-[#faf9f6] text-[#050505]">
      <div className="relative flex min-h-dvh items-stretch justify-center lg:items-center lg:px-8 lg:py-6">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_12%,rgba(198,168,244,0.34),transparent_26%),radial-gradient(circle_at_78%_18%,rgba(239,44,193,0.18),transparent_24%),radial-gradient(circle_at_54%_88%,rgba(252,76,2,0.16),transparent_30%)]" />

        <section className="phone-shell relative flex min-h-dvh w-full flex-col overflow-hidden bg-[#fdfcf9] lg:h-[min(860px,calc(100dvh-48px))] lg:min-h-0 lg:max-w-[430px] lg:shadow-[0_0_0_10px_#050505,0_24px_70px_rgba(5,5,5,0.22)]">
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(198,168,244,0.18),rgba(255,255,255,0)_24%),radial-gradient(circle_at_100%_5%,rgba(239,44,193,0.12),transparent_24%),radial-gradient(circle_at_0%_95%,rgba(252,76,2,0.1),transparent_28%)]" />

          <header className="relative z-10 flex items-center justify-between px-7 pt-7 text-sm">
            <div className="flex items-center gap-2.5">
              <Image
                className="h-6 w-[110px] object-contain object-left"
                src="/together-logo.svg"
                alt="Together AI"
                width={110}
                height={24}
                priority
              />
              <span className="h-4 w-px bg-[#050505]/14" aria-hidden />
              <span className="text-sm font-semibold tracking-tight text-[#050505]/78">
                Voice
              </span>
            </div>
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
                      ? "scale-[0.25] opacity-0 blur-xs"
                      : "scale-100 opacity-100 blur-0"
                  }`}
                  aria-hidden
                />
                <X
                  className={`absolute size-4 transition-[opacity,filter,scale] duration-200 ${
                    settingsOpen
                      ? "scale-100 opacity-100 blur-0"
                      : "scale-[0.25] opacity-0 blur-xs"
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
                    <dd className="text-right font-medium text-[#050505]">
                      Nemotron 3 / Whisper
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-[#050505]/52">Response</dt>
                    <dd className="text-right font-medium text-[#050505]">
                      Nemotron Ultra / MiniMax M2.7
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-[#050505]/52">Voice</dt>
                    <dd className="font-medium text-[#050505]">Sonic 3 / Kokoro</dd>
                  </div>
                </dl>
                <button
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-[#050505] px-4 py-2.5 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(5,5,5,0.16)] transition-[scale,background-color] duration-150 active:scale-[0.98]"
                  type="button"
                  onClick={voice.copyDebugLog}
                >
                  <Clipboard className="size-4" aria-hidden />
                  {voice.debugCopied ? "Copied session" : "Copy session log"}
                </button>
              </div>
            ) : null}

            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 pb-6">
              <button
                className="voice-orb-button"
                type="button"
                onClick={voice.startConversation}
                disabled={voice.isActive}
                aria-label="Start conversation"
                title={voice.isActive ? undefined : "Start conversation"}
              >
                <div className={`voice-orb voice-orb-${voice.phase}`} style={orbStyle} aria-hidden>
                  <div className="voice-orb-core" />
                </div>
              </button>

              <div
                className={`voice-waveform ${
                  waveformVisible ? "voice-waveform-active" : ""
                }`}
                style={orbStyle}
                aria-hidden
              >
                {[0.34, 0.62, 0.46, 0.82, 0.54, 1, 0.5, 0.78, 0.42, 0.66, 0.36].map(
                  (gain, index) => (
                    <span
                      key={index}
                      style={{ "--bar-gain": gain } as CSSProperties}
                    />
                  ),
                )}
              </div>

              <div className="rounded-full bg-white/38 px-4 py-2 text-center shadow-[0_0_0_1px_rgba(255,255,255,0.55),0_10px_28px_rgba(90,43,103,0.08)] backdrop-blur-xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#6b5a82]">
                  {status.label} · {status.detail}
                </p>
              </div>
            </div>

            <div className="space-y-4">
              {voice.transcriptItems.length > 0 ? (
              <div className="conversation-stream">
                <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-10 bg-linear-to-b from-[#fdfcf9]/80 to-transparent" />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-linear-to-t from-[#fdfcf9]/72 to-transparent" />
                <div
                  ref={voice.conversationScrollRef}
                  className="conversation-scroll max-h-[240px] overflow-y-auto overscroll-contain"
                >
                <div className="flex min-h-[120px] flex-col justify-end gap-1.5 px-1 py-3">
                  {voice.transcriptItems.map((turn, index) => (
                      <p
                        className={`max-w-[86%] text-pretty rounded-[18px] px-3 py-1.5 text-sm leading-5 shadow-[0_8px_22px_rgba(42,26,52,0.07)] transition-[opacity,filter,transform] duration-300 ease-out ${
                          turn.role === "user"
                            ? "self-end bg-[#050505]/88 text-white backdrop-blur-xl"
                            : "self-start bg-white/48 text-[#33253d] shadow-[0_0_0_1px_rgba(255,255,255,0.5),0_8px_22px_rgba(42,26,52,0.06)] backdrop-blur-xl"
                        } ${turn.live ? "opacity-100" : ""}`}
                        style={{
                          opacity: turn.live
                            ? 1
                            : turn.role === "user" && turn.settled === false
                              ? 0.72
                              : Math.max(0.6, 0.95 - (voice.transcriptItems.length - index - 1) * 0.1),
                        }}
                        key={`${turn.role}-${index}`}
                      >
                        {turn.text}
                      </p>
                  ))}
                </div>
                </div>
              </div>
              ) : null}

              {voice.error ? <VoiceNotice message={voice.error} /> : null}

              <div className="flex min-h-[64px] items-center justify-between px-1">
                {voice.isActive ? (
                  <>
                    <button
                      className={`grid size-14 place-items-center rounded-full shadow-[0_0_0_1px_rgba(5,5,5,0.08),0_2px_8px_rgba(5,5,5,0.06)] transition-[background-color,box-shadow,scale,color] duration-150 hover:shadow-[0_0_0_1px_rgba(5,5,5,0.12),0_3px_12px_rgba(5,5,5,0.08)] active:scale-[0.96] ${
                        voice.muted
                          ? "bg-[#050505] text-white"
                          : "bg-white text-[#050505]/80"
                      }`}
                      type="button"
                      aria-pressed={voice.muted}
                      aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"}
                      title={voice.muted ? "Unmute" : "Mute"}
                      onClick={voice.toggleMute}
                    >
                      <span className="relative grid size-5 place-items-center">
                        <Mic
                          className={`absolute size-5 transition-[opacity,filter,scale] duration-200 ${
                            voice.muted
                              ? "scale-[0.25] opacity-0 blur-xs"
                              : "scale-100 opacity-100 blur-0"
                          }`}
                          aria-hidden
                        />
                        <MicOff
                          className={`absolute size-5 transition-[opacity,filter,scale] duration-200 ${
                            voice.muted
                              ? "scale-100 opacity-100 blur-0"
                              : "scale-[0.25] opacity-0 blur-xs"
                          }`}
                          aria-hidden
                        />
                      </span>
                    </button>
                    {voice.turns.length > 0 ? (
                      <button
                        className="grid size-11 place-items-center rounded-full bg-white/70 text-[#050505]/55 shadow-[0_0_0_1px_rgba(5,5,5,0.06)] transition-[box-shadow,scale,color] duration-150 hover:text-[#050505]/80 hover:shadow-[0_0_0_1px_rgba(5,5,5,0.1)] active:scale-[0.96]"
                        type="button"
                        aria-label="New conversation"
                        title="New conversation"
                        onClick={voice.resetConversation}
                      >
                        <RotateCcw className="size-4" aria-hidden />
                      </button>
                    ) : null}
                    <button
                      className="grid size-14 place-items-center rounded-full bg-white text-[#050505]/80 shadow-[0_0_0_1px_rgba(5,5,5,0.08),0_2px_8px_rgba(5,5,5,0.06)] transition-[box-shadow,scale] duration-150 hover:shadow-[0_0_0_1px_rgba(5,5,5,0.12),0_3px_12px_rgba(5,5,5,0.08)] active:scale-[0.96]"
                      type="button"
                      aria-label="End conversation"
                      title="End"
                      onClick={voice.stopConversation}
                    >
                      <X className="size-5" aria-hidden />
                    </button>
                  </>
                ) : voice.turns.length > 0 ? (
                  <button
                    className="mx-auto rounded-full bg-white/70 px-4 py-2 text-sm font-medium text-[#050505]/60 shadow-[0_0_0_1px_rgba(5,5,5,0.06)] transition-[box-shadow,scale,color] duration-150 hover:text-[#050505]/85 hover:shadow-[0_0_0_1px_rgba(5,5,5,0.1)] active:scale-[0.96]"
                    type="button"
                    onClick={voice.resetConversation}
                  >
                    New conversation
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function VoiceNotice({ message }: { message: string }) {
  const isLimitNotice = message.toLowerCase().includes("time limit");
  const Icon = isLimitNotice ? Clock3 : TriangleAlert;
  const title = isLimitNotice ? "Call time reached" : "Something went wrong";
  const detail = isLimitNotice
    ? "Start a new call when you're ready."
    : message;

  return (
    <div className="rounded-[22px] bg-white/64 px-3.5 py-3 shadow-[0_0_0_1px_rgba(255,255,255,0.62),0_10px_28px_rgba(65,42,78,0.09)] backdrop-blur-xl">
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-full ${
            isLimitNotice
              ? "bg-[#f6e9ff] text-[#7f4fac]"
              : "bg-[#fff1ec] text-[#c54718]"
          }`}
          aria-hidden
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-5 text-[#1f1824]">{title}</p>
          <p className="mt-0.5 text-pretty text-sm leading-5 text-[#574b60]">{detail}</p>
        </div>
      </div>
    </div>
  );
}
