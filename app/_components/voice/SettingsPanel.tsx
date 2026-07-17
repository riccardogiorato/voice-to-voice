"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, Clipboard, Cpu } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { cx } from "./utils";

export function VoiceSettingsPanel({
  debugCopied = false,
  onCopyDebugLog,
  overlay = false,
}: {
  debugCopied?: boolean;
  onCopyDebugLog?: () => void;
  overlay?: boolean;
}) {
  const [debugOpen, setDebugOpen] = useState(false);

  return (
    <div
      className={cx(
        "rounded-[24px] bg-white p-4 shadow-[0_0_0_1px_rgba(5,5,5,0.08),0_18px_44px_rgba(5,5,5,0.12)]",
        overlay && "absolute left-7 right-7 top-5 z-20",
      )}
    >
      <div className="flex items-center gap-2 text-sm font-semibold text-[#050505]">
        <Cpu className="size-4 text-[#ef2cc1]" aria-hidden />
        Model stack
      </div>
      <p className="mt-2 text-xs leading-5 text-[#050505]/52">
        One model listens and writes the reply.
      </p>
      <dl className="mt-4 space-y-3 text-sm">
        <div className="flex items-center justify-between gap-4">
          <dt className="text-[#050505]/52">Listen + reply</dt>
          <dd className="text-right font-medium text-[#050505]">Inkling</dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-[#050505]/52">Voice</dt>
          <dd className="font-medium text-[#050505]">Sonic 3 / Kokoro</dd>
        </div>
      </dl>
      <div className="mt-4">
        <button
          aria-controls="voice-debug-actions"
          aria-expanded={debugOpen}
          className="flex min-h-10 w-full items-center justify-between rounded-[14px] px-2 text-sm font-semibold text-[#050505]/70 transition-[background-color,color] duration-150 hover:bg-[#050505]/5 hover:text-[#050505]"
          onClick={() => setDebugOpen((open) => !open)}
          type="button"
        >
          Debug
          <ChevronDown
            className={cx(
              "size-4 transition-transform duration-200 ease-out",
              debugOpen && "rotate-180",
            )}
            aria-hidden
          />
        </button>
        <AnimatePresence initial={false}>
          {debugOpen ? (
            <motion.div
              id="voice-debug-actions"
              className="overflow-hidden"
              initial={{ height: 0, opacity: 0, y: -4 }}
              animate={{ height: "auto", opacity: 1, y: 0 }}
              exit={{
                height: 0,
                opacity: 0,
                y: -4,
                transition: { duration: 0.15, ease: "easeIn" },
              }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              <Link
                className="mt-2 flex min-h-10 w-full items-center justify-center rounded-full bg-[#050505]/6 px-4 py-2.5 text-sm font-semibold text-[#050505] transition-[scale,background-color] duration-150 hover:bg-[#050505]/10 active:scale-[0.96]"
                href="/stt-playground"
              >
                Compare speech-to-text
              </Link>
              <button
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-full bg-[#050505] px-4 py-2.5 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(5,5,5,0.16)] transition-[scale,background-color] duration-150 active:scale-[0.96]"
                type="button"
                onClick={onCopyDebugLog}
              >
                <Clipboard className="size-4" aria-hidden />
                {debugCopied ? "Copied session" : "Copy session log"}
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
