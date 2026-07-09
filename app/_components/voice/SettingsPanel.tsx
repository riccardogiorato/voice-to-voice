import { Clipboard, Cpu } from "lucide-react";
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
        onClick={onCopyDebugLog}
      >
        <Clipboard className="size-4" aria-hidden />
        {debugCopied ? "Copied session" : "Copy session log"}
      </button>
    </div>
  );
}
