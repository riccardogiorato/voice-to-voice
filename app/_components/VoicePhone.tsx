"use client";

import { useState } from "react";
import type { useVoiceConversation } from "@/app/_hooks/useVoiceConversation";
import {
  VoiceActiveControls,
  VoiceBrandHeader,
  VoiceConversationStream,
  VoiceMicMeter,
  VoiceNewConversationButton,
  VoiceNotice,
  VoiceOrbButton,
  VoiceSettingsPanel,
  VoiceStatusPill,
} from "@/app/_components/voice";

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
    detail: "Replying",
  },
};

export function VoicePhone({ voice }: { voice: VoiceConversation }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [messagesOpen, setMessagesOpen] = useState(true);
  const status =
    voice.muted && voice.isActive
      ? { label: "Muted", detail: "Tap the mic to resume" }
      : phaseCopy[voice.phase];
  const waveformVisible = voice.userSpeaking && !voice.muted;
  const micMeterVisible = voice.isActive && !voice.muted;
  const voiceActivity =
    voice.phase === "speaking" || voice.phase === "thinking"
      ? voice.assistantActivity
      : voice.phase === "listening" && !voice.muted
        ? Math.max(waveformVisible ? voice.micActivity : 0, voice.micLevel * 0.24)
        : 0;
  const micLevel = micMeterVisible ? voice.micLevel : 0;

  return (
    <main className="min-h-dvh overflow-hidden bg-[#faf9f6] text-[#050505]">
      <div className="relative flex min-h-dvh items-stretch justify-center lg:items-center lg:px-8 lg:py-6">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_12%,rgba(198,168,244,0.34),transparent_26%),radial-gradient(circle_at_78%_18%,rgba(239,44,193,0.18),transparent_24%),radial-gradient(circle_at_54%_88%,rgba(252,76,2,0.16),transparent_30%)]" />

        <section className="phone-shell relative flex min-h-dvh w-full flex-col overflow-hidden bg-[#fdfcf9] lg:h-[min(860px,calc(100dvh-48px))] lg:min-h-0 lg:max-w-[430px] lg:shadow-[0_0_0_10px_#050505,0_24px_70px_rgba(5,5,5,0.22)]">
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(198,168,244,0.18),rgba(255,255,255,0)_24%),radial-gradient(circle_at_100%_5%,rgba(239,44,193,0.12),transparent_24%),radial-gradient(circle_at_0%_95%,rgba(252,76,2,0.1),transparent_28%)]" />

          <header className="relative z-10 px-7 pt-7">
            <VoiceBrandHeader
              settingsOpen={settingsOpen}
              onSettingsClick={() => setSettingsOpen((open) => !open)}
            />
          </header>

          <div className="relative z-10 flex flex-1 flex-col px-7 pb-7 pt-6">
            {settingsOpen ? (
              <VoiceSettingsPanel
                debugCopied={voice.debugCopied}
                onCopyDebugLog={voice.copyDebugLog}
                overlay
              />
            ) : null}

            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 pb-6">
              <VoiceOrbButton
                phase={voice.phase}
                activity={voiceActivity}
                disabled={voice.isActive}
                onClick={voice.startConversation}
              />

              <VoiceMicMeter active={micMeterVisible} level={micLevel} />

              <VoiceStatusPill label={status.label} detail={status.detail} />
            </div>

            <div className="space-y-4">
              {messagesOpen ? (
                <VoiceConversationStream
                  items={voice.conversationItems}
                  scrollRef={voice.conversationScrollRef}
                />
              ) : null}

              {voice.error ? <VoiceNotice message={voice.error} /> : null}

              {voice.isActive ? (
                <VoiceActiveControls
                  muted={voice.muted}
                  messagesOpen={messagesOpen}
                  onToggleMessages={() => setMessagesOpen((open) => !open)}
                  onToggleMute={voice.toggleMute}
                  onStop={voice.stopConversation}
                />
              ) : voice.turns.length > 0 ? (
                <VoiceNewConversationButton onClick={voice.resetConversation} />
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
