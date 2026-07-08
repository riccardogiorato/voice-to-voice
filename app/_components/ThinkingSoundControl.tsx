"use client";

import { Pause, Play, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  createThinkingSound,
  type ThinkingSoundHandle,
} from "@/app/_lib/client-audio";

type ThinkingSoundControlProps = {
  className?: string;
  variant?: "compact" | "full";
};

export function ThinkingSoundControl({
  className = "",
  variant = "full",
}: ThinkingSoundControlProps) {
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.85);
  const audioContextRef = useRef<AudioContext | null>(null);
  const soundRef = useRef<ThinkingSoundHandle | null>(null);

  useEffect(() => {
    soundRef.current?.setVolume(volume);
  }, [volume]);

  useEffect(() => {
    return () => {
      stop(false);
      void audioContextRef.current?.close();
      audioContextRef.current = null;
    };
  }, []);

  async function play() {
    const audioContext =
      audioContextRef.current ?? new AudioContext({ latencyHint: "interactive" });
    audioContextRef.current = audioContext;
    await audioContext.resume();

    soundRef.current?.stop();
    soundRef.current = createThinkingSound(audioContext, volume);
    setPlaying(true);
  }

  function stop(updateState = true) {
    soundRef.current?.stop();
    soundRef.current = null;
    if (updateState) setPlaying(false);
  }

  const isCompact = variant === "compact";

  return (
    <div
      className={[
        isCompact
          ? "border-t border-[#050505]/10 pt-4"
          : "w-full max-w-[520px] rounded-[28px] bg-white p-5 shadow-[0_0_0_1px_rgba(5,5,5,0.08),0_18px_54px_rgba(5,5,5,0.14)]",
        className,
      ].join(" ")}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p
            className={
              isCompact
                ? "text-sm font-semibold text-[#050505]"
                : "font-display text-2xl font-semibold tracking-normal text-[#050505]"
            }
          >
            Thinking sound
          </p>
          <p className="mt-1 text-xs font-medium text-[#050505]/52">
            {playing ? "Playing" : "Ready"}
          </p>
        </div>

        <button
          className={[
            "grid shrink-0 place-items-center rounded-full bg-[#050505] text-white shadow-[0_10px_24px_rgba(5,5,5,0.16)] transition-[scale,background-color] duration-150 active:scale-[0.96]",
            isCompact ? "size-10" : "size-14",
          ].join(" ")}
          type="button"
          aria-label={playing ? "Stop thinking sound" : "Play thinking sound"}
          title={playing ? "Stop" : "Play"}
          onClick={playing ? () => stop() : play}
        >
          {playing ? (
            <Pause className={isCompact ? "size-4" : "size-5"} aria-hidden />
          ) : (
            <Play className={isCompact ? "size-4" : "size-5"} aria-hidden />
          )}
        </button>
      </div>

      <div className={isCompact ? "mt-3" : "mt-6"}>
        <div
          className={[
            "flex items-end justify-center gap-1.5 rounded-2xl bg-[#050505]/[0.04] px-3",
            isCompact ? "h-12" : "h-28",
          ].join(" ")}
          aria-hidden
        >
          {[0.34, 0.74, 0.5, 0.96, 0.44, 0.82, 0.38, 0.68, 0.52].map(
            (height, index) => (
              <span
                className={[
                  "w-1.5 rounded-full bg-[#ef2cc1] transition-[height,opacity] duration-200",
                  playing ? "opacity-90" : "opacity-30",
                ].join(" ")}
                key={index}
                style={{
                  height: playing
                    ? `${Math.max(8, height * (isCompact ? 34 : 76))}px`
                    : `${Math.max(6, height * (isCompact ? 18 : 34))}px`,
                  animation: playing
                    ? `thinking-meter ${1.1 + index * 0.06}s ease-in-out infinite`
                    : undefined,
                  animationDelay: `${index * -90}ms`,
                }}
              />
            ),
          )}
        </div>
      </div>

      <label className="mt-4 flex items-center gap-3 text-xs font-semibold text-[#050505]/58">
        <Volume2 className="size-4 shrink-0 text-[#fc4c02]" aria-hidden />
        <input
          className="h-1.5 min-w-0 flex-1 accent-[#ef2cc1]"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={volume}
          aria-label="Thinking sound volume"
          onChange={(event) => setVolume(Number(event.target.value))}
        />
      </label>
    </div>
  );
}
