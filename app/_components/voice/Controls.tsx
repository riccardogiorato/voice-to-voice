import { MessageSquareOff, MessageSquareText, Mic, MicOff, X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { cx } from "./utils";

type VoiceIconButtonSize = "sm" | "md" | "lg" | "xl";
type VoiceIconButtonTone =
  | "default"
  | "dark"
  | "muted"
  | "soft"
  | "softActive"
  | "voice";

const sizeClasses: Record<VoiceIconButtonSize, string> = {
  sm: "size-10",
  md: "size-12",
  lg: "size-14",
  xl: "size-16",
};

const toneClasses: Record<VoiceIconButtonTone, string> = {
  default:
    "bg-white text-[#050505]/80 shadow-[0_0_0_1px_rgba(5,5,5,0.08),0_2px_8px_rgba(5,5,5,0.06)]",
  dark:
    "bg-[#050505] text-white shadow-[0_0_0_1px_rgba(5,5,5,0.08),0_2px_8px_rgba(5,5,5,0.06)]",
  muted: "bg-white/70 text-[#050505]/55 shadow-[0_0_0_1px_rgba(5,5,5,0.06)]",
  soft:
    "bg-white/74 text-[#6b5a82] shadow-[0_0_0_1px_rgba(5,5,5,0.06),0_6px_16px_rgba(65,42,78,0.06)]",
  softActive:
    "bg-[#f4edff] text-[#6b3f91] shadow-[0_0_0_1px_rgba(127,79,172,0.12),0_8px_20px_rgba(65,42,78,0.08)]",
  voice: "bg-[linear-gradient(145deg,#c6a8f4_0%,#ef2cc1_54%,#fc4c02_100%)] text-white shadow-none",
};

const hoverClasses: Record<VoiceIconButtonTone, string> = {
  default:
    "hover:text-[#050505]/85 hover:shadow-[0_0_0_1px_rgba(5,5,5,0.12),0_3px_12px_rgba(5,5,5,0.08)]",
  dark:
    "hover:bg-[#1f1824] hover:text-white hover:shadow-[0_0_0_1px_rgba(5,5,5,0.1),0_8px_20px_rgba(5,5,5,0.16)]",
  muted:
    "hover:text-[#050505]/85 hover:shadow-[0_0_0_1px_rgba(5,5,5,0.12),0_3px_12px_rgba(5,5,5,0.08)]",
  soft:
    "hover:bg-white hover:text-[#6b3f91] hover:shadow-[0_0_0_1px_rgba(127,79,172,0.14),0_8px_20px_rgba(65,42,78,0.09)]",
  softActive:
    "hover:bg-white hover:text-[#6b3f91] hover:shadow-[0_0_0_1px_rgba(127,79,172,0.14),0_8px_20px_rgba(65,42,78,0.09)]",
  voice: "hover:text-white hover:shadow-none",
};

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
  size?: VoiceIconButtonSize;
  tone?: VoiceIconButtonTone;
}) {
  return (
    <button
      className={cx(
        "grid place-items-center rounded-full transition-[background-color,box-shadow,scale,color] duration-150 active:scale-[0.96]",
        hoverClasses[tone],
        sizeClasses[size],
        toneClasses[tone],
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
      size="xl"
      tone="voice"
    >
      <span className="relative grid size-6 place-items-center">
        <Mic
          className={cx(
            "absolute size-6 transition-[opacity,filter,scale] duration-200",
            muted ? "scale-[0.25] opacity-0 blur-xs" : "scale-100 opacity-100 blur-0",
          )}
          aria-hidden
        />
        <MicOff
          className={cx(
            "absolute size-6 transition-[opacity,filter,scale] duration-200",
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
  animateEntrance = false,
  onToggleMessages,
  onToggleMute,
  onStop,
}: {
  muted: boolean;
  messagesOpen: boolean;
  animateEntrance?: boolean;
  onToggleMessages?: () => void;
  onToggleMute?: () => void;
  onStop?: () => void;
}) {
  const controls = [
    <VoiceIconButton
      key="messages"
      label={messagesOpen ? "Hide messages" : "Show messages"}
      onClick={onToggleMessages}
      pressed={messagesOpen}
      size="md"
      tone="soft"
    >
      {messagesOpen ? (
        <MessageSquareText className="size-5" aria-hidden />
      ) : (
        <MessageSquareOff className="size-5" aria-hidden />
      )}
    </VoiceIconButton>,
    <VoiceMuteButton key="microphone" muted={muted} onClick={onToggleMute} />,
    <VoiceIconButton
      key="stop"
      label="End conversation"
      size="md"
      tone="dark"
      onClick={onStop}
    >
      <X className="size-5" aria-hidden />
    </VoiceIconButton>,
  ];

  if (animateEntrance) {
    return (
      <motion.div
        className="flex min-h-[64px] items-center justify-between px-1"
        initial="hidden"
        animate="visible"
        variants={{
          hidden: {},
          visible: { transition: { delayChildren: 0.1, staggerChildren: 0.08 } },
        }}
      >
        {controls.map((control) => (
          <motion.div
            key={control.key}
            variants={{
              hidden: { opacity: 0, y: 12, scale: 0.9 },
              visible: {
                opacity: 1,
                y: 0,
                scale: 1,
                transition: { type: "spring", duration: 0.45, bounce: 0 },
              },
            }}
          >
            {control}
          </motion.div>
        ))}
      </motion.div>
    );
  }

  return (
    <div className="flex min-h-[64px] items-center justify-between px-1">
      {controls}
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
