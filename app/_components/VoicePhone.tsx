import type { useVoiceConversation } from "@/app/_hooks/useVoiceConversation";
import { VoicePhoneLayout } from "@/app/_components/voice/VoicePhoneLayout";

type VoiceConversation = ReturnType<typeof useVoiceConversation>;

const phaseCopy: Record<VoiceConversation["phase"], { label: string; detail: string }> = {
  idle: {
    label: "Tap anywhere",
    detail: "Start voice chat",
  },
  connecting: {
    label: "Connecting",
    detail: "Opening",
  },
  listening: {
    label: "I’m listening…",
    detail: "Live",
  },
  thinking: {
    label: "Thinking...",
    detail: "Working",
  },
  speaking: {
    label: "...",
    detail: "Replying",
  },
};

export function VoicePhone({ voice }: { voice: VoiceConversation }) {
  const status =
    voice.muted && voice.isActive
      ? { label: "Muted", detail: "Tap the mic to resume" }
      : !voice.isActive && voice.turns.length > 0
        ? { label: "Ready when you are", detail: "Resume or start new" }
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
        <VoicePhoneLayout
          phase={voice.phase}
          isActive={voice.isActive}
          muted={voice.muted}
          activity={voiceActivity}
          micLevel={micLevel}
          status={status}
          conversationItems={voice.conversationItems}
          conversationScrollRef={voice.conversationScrollRef}
          error={voice.error}
          hasTurns={voice.turns.length > 0}
          debugCopied={voice.debugCopied}
          onStart={voice.startConversation}
          onStartNew={voice.startNewConversation}
          onToggleMute={voice.toggleMute}
          onStop={voice.stopConversation}
          onCopyDebugLog={voice.copyDebugLog}
        />
      </div>
    </main>
  );
}
