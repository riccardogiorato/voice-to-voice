"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState, type MouseEvent, type Ref } from "react";
import type { ConversationTimelineItem } from "@/app/_hooks/useVoiceConversation";
import { VoiceActiveControls, VoiceEndedControls } from "./Controls";
import { VoiceConversationStream } from "./ConversationStream";
import { VoiceBrandHeader } from "./BrandHeader";
import { VoiceMicMeter } from "./Meters";
import { VoiceNotice } from "./Notice";
import { VoiceOrbButton } from "./OrbButton";
import { VoiceSettingsPanel } from "./SettingsPanel";
import { VoiceStatusPill } from "./StatusPill";
import type { VoiceOrbPhase } from "./types";

export type VoicePhoneLayoutProps = {
  phase: VoiceOrbPhase;
  isActive: boolean;
  muted: boolean;
  activity: number;
  micLevel: number;
  status: { label: string; detail: string };
  conversationItems: ConversationTimelineItem[];
  conversationScrollRef?: Ref<HTMLDivElement>;
  error?: string | null;
  hasTurns?: boolean;
  debugCopied?: boolean;
  embedded?: boolean;
  onStart?: () => void | Promise<void>;
  onStartNew?: () => void | Promise<void>;
  onToggleMute?: () => void;
  onStop?: () => void;
  onCopyDebugLog?: () => void;
};

export function VoicePhoneLayout({
  phase,
  isActive,
  muted,
  activity,
  micLevel,
  status,
  conversationItems,
  conversationScrollRef,
  error,
  hasTurns = false,
  debugCopied,
  embedded = false,
  onStart,
  onStartNew,
  onToggleMute,
  onStop,
  onCopyDebugLog,
}: VoicePhoneLayoutProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [messagesOpen, setMessagesOpen] = useState(true);
  const canStartFromSurface = !isActive && !settingsOpen;
  const hasFooterControls = isActive || hasTurns;
  const hasContentBelowMessages = Boolean(error) || hasFooterControls;

  function handleSurfaceClick(event: MouseEvent<HTMLElement>) {
    if (!canStartFromSurface || isInteractiveTarget(event.target)) return;
    void onStart?.();
  }

  return (
    <section
      className={`phone-shell relative flex w-full flex-col overflow-hidden bg-[#fdfcf9] ${
        embedded
          ? "h-[720px] shadow-[0_0_0_10px_#050505,0_24px_70px_rgba(5,5,5,0.18)]"
          : "min-h-dvh lg:h-[min(860px,calc(100dvh-48px))] lg:min-h-0 lg:max-w-[430px] lg:shadow-[0_0_0_10px_#050505,0_24px_70px_rgba(5,5,5,0.22)]"
      } ${canStartFromSurface ? "cursor-pointer" : ""}`}
      onClick={handleSurfaceClick}
    >
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(198,168,244,0.18),rgba(255,255,255,0)_24%),radial-gradient(circle_at_100%_5%,rgba(239,44,193,0.12),transparent_24%)]" />

      <header className="relative z-10 px-7 pt-7">
        <VoiceBrandHeader
          settingsOpen={settingsOpen}
          onSettingsClick={() => setSettingsOpen((open) => !open)}
        />
      </header>

      <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden px-7 pb-7 pt-6">
        {settingsOpen ? (
          <VoiceSettingsPanel
            debugCopied={debugCopied}
            onCopyDebugLog={onCopyDebugLog}
            overlay
          />
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 pb-6">
          <VoiceOrbButton
            phase={phase}
            activity={activity}
            disabled={isActive}
            onClick={onStart}
          />
          <VoiceStatusPill label={status.label} detail={status.detail} />
        </div>

        <div className="shrink-0">
          <AnimatePresence initial={false}>
            {messagesOpen && conversationItems.length > 0 ? (
              <motion.div
                key="conversation-stream"
                className="overflow-hidden"
                initial={{ height: 0, marginBottom: 0 }}
                animate={{
                  height: "auto",
                  marginBottom: hasContentBelowMessages ? 16 : 0,
                }}
                exit={{ height: 0, marginBottom: 0 }}
                transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
              >
                <motion.div
                  initial={{ opacity: 0, y: 8, scale: 0.985, filter: "blur(4px)" }}
                  animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
                  exit={{
                    opacity: 0,
                    y: 6,
                    scale: 0.99,
                    filter: "blur(2px)",
                    transition: { duration: 0.16, ease: "easeIn" },
                  }}
                  transition={{ type: "spring", duration: 0.42, bounce: 0 }}
                >
                  <VoiceConversationStream
                    items={conversationItems}
                    scrollRef={conversationScrollRef}
                  />
                </motion.div>
              </motion.div>
            ) : null}
          </AnimatePresence>

          {error ? (
            <div className={hasFooterControls ? "mb-4" : undefined}>
              <VoiceNotice message={error} />
            </div>
          ) : null}

          <AnimatePresence initial={false} mode="wait">
            {isActive ? (
              <motion.div
                key="active-controls"
                data-testid="voice-active-controls-presence"
                initial={{ height: 0, overflow: "hidden" }}
                animate={{
                  height: "auto",
                  transitionEnd: { overflow: "visible" },
                }}
                exit={{ height: 0, overflow: "hidden" }}
                transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1] }}
              >
                <motion.div
                  className="flex flex-col gap-1"
                  data-testid="voice-active-controls-content"
                  initial={{ opacity: 0, y: 24, filter: "blur(6px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  exit={{ opacity: 0, y: 10, filter: "blur(3px)" }}
                  transition={{ type: "spring", duration: 0.55, bounce: 0 }}
                >
                  <div className="flex justify-center">
                    <VoiceMicMeter active={!muted} level={muted ? 0 : micLevel} />
                  </div>
                  <VoiceActiveControls
                    animateEntrance
                    muted={muted}
                    messagesOpen={messagesOpen}
                    onToggleMessages={() => setMessagesOpen((open) => !open)}
                    onToggleMute={onToggleMute}
                    onStop={onStop}
                  />
                </motion.div>
              </motion.div>
            ) : hasTurns ? (
              <motion.div
                key="ended-controls"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ type: "spring", duration: 0.3, bounce: 0 }}
              >
                <VoiceEndedControls onResume={onStart} onNew={onStartNew} />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}

function isInteractiveTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'a,button,input,textarea,select,summary,[role="button"],[contenteditable="true"]',
      ),
    )
  );
}
