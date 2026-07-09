import { MessageCircle, Mic, MicOff, X } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "./utils";

export function VoiceIconButton({
  label,
  children,
  onClick,
  pressed,
  size = "lg",
  tone = "default",
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  pressed?: boolean;
  size?: "sm" | "md" | "lg";
  tone?: "default" | "dark" | "muted";
}) {
  const sizeClass = size === "lg" ? "size-14" : size === "md" ? "size-10" : "size-11";
  const toneClass =
    tone === "dark"
      ? "bg-[#050505] text-white shadow-[0_0_0_1px_rgba(5,5,5,0.08),0_2px_8px_rgba(5,5,5,0.06)]"
      : tone === "muted"
        ? "bg-white/70 text-[#050505]/55 shadow-[0_0_0_1px_rgba(5,5,5,0.06)]"
        : "bg-white text-[#050505]/80 shadow-[0_0_0_1px_rgba(5,5,5,0.08),0_2px_8px_rgba(5,5,5,0.06)]";

  return (
    <button
      className={cx(
        "grid place-items-center rounded-full transition-[background-color,box-shadow,scale,color] duration-150 active:scale-[0.96]",
        "hover:text-[#050505]/85 hover:shadow-[0_0_0_1px_rgba(5,5,5,0.12),0_3px_12px_rgba(5,5,5,0.08)]",
        sizeClass,
        toneClass,
      )}
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function VoiceMuteButton({
  muted,
  onClick,
}: {
  muted: boolean;
  onClick?: () => void;
}) {
  return (
    <VoiceIconButton
      label={muted ? "Unmute microphone" : "Mute microphone"}
      onClick={onClick}
      pressed={muted}
      tone={muted ? "dark" : "default"}
    >
      <span className="relative grid size-5 place-items-center">
        <Mic
          className={cx(
            "absolute size-5 transition-[opacity,filter,scale] duration-200",
            muted ? "scale-[0.25] opacity-0 blur-xs" : "scale-100 opacity-100 blur-0",
          )}
          aria-hidden
        />
        <MicOff
          className={cx(
            "absolute size-5 transition-[opacity,filter,scale] duration-200",
            muted ? "scale-100 opacity-100 blur-0" : "scale-[0.25] opacity-0 blur-xs",
          )}
          aria-hidden
        />
      </span>
    </VoiceIconButton>
  );
}

export function VoiceActiveControls({
  muted,
  messagesOpen,
  onToggleMessages,
  onToggleMute,
  onStop,
}: {
  muted: boolean;
  messagesOpen: boolean;
  onToggleMessages?: () => void;
  onToggleMute?: () => void;
  onStop?: () => void;
}) {
  return (
    <div className="flex min-h-[64px] items-center justify-between px-1">
      <VoiceIconButton
        label={messagesOpen ? "Hide messages" : "Show messages"}
        onClick={onToggleMessages}
        pressed={messagesOpen}
        tone={messagesOpen ? "dark" : "default"}
      >
        <MessageCircle className="size-5" aria-hidden />
      </VoiceIconButton>
      <VoiceMuteButton muted={muted} onClick={onToggleMute} />
      <VoiceIconButton label="End conversation" onClick={onStop}>
        <X className="size-5" aria-hidden />
      </VoiceIconButton>
    </div>
  );
}

export function VoiceNewConversationButton({ onClick }: { onClick?: () => void }) {
  return (
    <div className="flex min-h-[64px] items-center justify-between px-1">
      <button
        className="mx-auto rounded-full bg-white/70 px-4 py-2 text-sm font-medium text-[#050505]/60 shadow-[0_0_0_1px_rgba(5,5,5,0.06)] transition-[box-shadow,scale,color] duration-150 hover:text-[#050505]/85 hover:shadow-[0_0_0_1px_rgba(5,5,5,0.1)] active:scale-[0.96]"
        type="button"
        onClick={onClick}
      >
        New conversation
      </button>
    </div>
  );
}
