import { MessageSquareOff, MessageSquareText, MicOff, SlidersHorizontal, X } from "lucide-react";
import type { ReactNode } from "react";
import {
  ToolActivityRow,
  VoiceActiveControls,
  VoiceEndedControls,
  VoiceConversationStream,
  VoiceIconButton,
  VoiceMicMeter,
  VoiceNotice,
  VoiceOrbButton,
  VoiceSettingsPanel,
  VoiceStatusPill,
  type VoiceOrbPhase,
} from "@/app/_components/voice";
import type {
  ConversationTimelineItem,
  ToolActivityItem,
} from "@/app/_hooks/useVoiceConversation";
import { DesignVoicePhone } from "./DesignVoicePhone";

const orbStates = [
  { label: "Idle", phase: "idle", activity: 0 },
  { label: "Connecting", phase: "connecting", activity: 0.16 },
  { label: "Listening", phase: "listening", activity: 0.5 },
  { label: "Thinking", phase: "thinking", activity: 0.34 },
  { label: "Speaking", phase: "speaking", activity: 0.72 },
] satisfies Array<{ label: string; phase: VoiceOrbPhase; activity: number }>;

const toolActivities: ToolActivityItem[] = [
  {
    id: "design-tool-running",
    name: "web_search",
    status: "running" as const,
    input: "latest Together AI voice model updates",
  },
  {
    id: "design-tool-completed",
    name: "web_search",
    status: "completed" as const,
    input: "weather in Venice today",
    summary: "Found recent weather sources and summarized the current conditions.",
  },
  {
    id: "design-tool-failed",
    name: "web_search",
    status: "failed" as const,
    input: "recent benchmark source",
    summary: "The search provider did not return results.",
  },
  {
    id: "design-tool-time",
    name: "get_current_time",
    status: "completed" as const,
    input: "Europe/Rome",
    summary: "Friday, July 10, 2026 at 8:20:20 PM GMT+02:00",
  },
  {
    id: "design-tool-location",
    name: "get_user_location",
    status: "completed" as const,
    input: "IP-derived location",
    summary: "Rome, IT, Europe/Rome",
  },
];

const conversationItems: ConversationTimelineItem[] = [
  {
    type: "turn",
    role: "user",
    text: "Could you check the latest weather in Venice?",
  },
  {
    ...toolActivities[1],
    type: "tool",
  },
  {
    type: "turn",
    role: "assistant",
    text: "It looks mild and cloudy right now, with light wind near the lagoon.",
  },
  {
    type: "turn",
    role: "user",
    text: "What about tomorrow",
    settled: false,
  },
];

export default function DesignPage() {
  return (
    <main className="min-h-dvh bg-[#f3f0ea] px-5 py-6 text-[#050505] sm:px-8 lg:px-10">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-3 border-b border-[#050505]/10 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#6b5a82]">
              Voice demo
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-normal text-[#050505]">
              Component Library
            </h1>
          </div>
          <a
            className="w-fit rounded-full bg-white/72 px-4 py-2 text-sm font-medium text-[#050505]/70 shadow-[0_0_0_1px_rgba(5,5,5,0.06)] transition-[box-shadow,scale,color] duration-150 hover:text-[#050505] hover:shadow-[0_0_0_1px_rgba(5,5,5,0.1)] active:scale-[0.96]"
            href="/"
          >
            Back to demo
          </a>
        </header>

        <section className="grid gap-5 lg:grid-cols-[430px_1fr]">
          <Specimen title="Interactive Phone Flow">
            <DesignVoicePhone />
          </Specimen>

          <div className="grid content-start gap-5">
            <Specimen title="Orb States">
              <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
                {orbStates.map((state) => (
                  <div
                    className="flex min-h-[156px] flex-col items-center justify-center gap-3 rounded-[18px] bg-white/48 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.6),0_10px_28px_rgba(65,42,78,0.08)]"
                    key={state.label}
                  >
                    <div className="scale-[0.42]">
                      <VoiceOrbButton phase={state.phase} activity={state.activity} />
                    </div>
                    <p className="text-xs font-medium text-[#5f5268]">{state.label}</p>
                  </div>
                ))}
              </div>
            </Specimen>

            <section className="grid gap-5 xl:grid-cols-2">
              <Specimen title="Mic Meter">
                <div className="flex flex-col items-center gap-5 rounded-[18px] bg-white/48 p-5">
                  <VoiceMicMeter active level={0.7} />
                  <VoiceMicMeter level={0} />
                </div>
              </Specimen>

              <Specimen title="Status Pills">
                <div className="flex flex-wrap gap-3">
                  <VoiceStatusPill label="Tap anywhere" detail="Start voice chat" />
                  <VoiceStatusPill label="Thinking" detail="Working" />
                  <VoiceStatusPill label="Speaking" detail="Replying" />
                </div>
              </Specimen>
            </section>

            <Specimen title="Conversation Timeline">
              <VoiceConversationStream items={conversationItems} />
            </Specimen>

            <section className="grid gap-5 xl:grid-cols-2">
              <Specimen title="Tool Calls">
                <div className="flex flex-col gap-2">
                  {toolActivities.map((activity) => (
                    <ToolActivityRow activity={activity} key={activity.id} />
                  ))}
                </div>
              </Specimen>

              <Specimen title="Notices">
                <div className="flex flex-col gap-3">
                  <VoiceNotice message="Call time limit reached. Start a new call when you're ready." />
                  <VoiceNotice message="Speech service disconnected." />
                </div>
              </Specimen>
            </section>

            <section className="grid gap-5 xl:grid-cols-2">
              <Specimen title="Settings Panel">
                <VoiceSettingsPanel />
              </Specimen>

              <Specimen title="Controls">
                <div className="flex flex-col gap-5">
                  <VoiceActiveControls muted={false} messagesOpen />
                  <VoiceActiveControls muted messagesOpen={false} />
                  <VoiceEndedControls />
                  <div className="flex items-center gap-4">
                    <VoiceIconButton label="Settings" size="md">
                      <SlidersHorizontal className="size-4" aria-hidden />
                    </VoiceIconButton>
                    <VoiceIconButton label="Messages" size="md" tone="soft">
                      <MessageSquareText className="size-5" aria-hidden />
                    </VoiceIconButton>
                    <VoiceIconButton label="Messages hidden" size="md" tone="soft">
                      <MessageSquareOff className="size-5" aria-hidden />
                    </VoiceIconButton>
                    <VoiceIconButton label="Muted" size="xl" tone="voice">
                      <MicOff className="size-6" aria-hidden />
                    </VoiceIconButton>
                    <VoiceIconButton label="End" size="md" tone="dark">
                      <X className="size-5" aria-hidden />
                    </VoiceIconButton>
                  </div>
                </div>
              </Specimen>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}

function Specimen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-[22px] bg-[#fdfcf9]/74 p-4 shadow-[0_0_0_1px_rgba(5,5,5,0.06),0_14px_38px_rgba(65,42,78,0.08)] backdrop-blur-xl">
      <h2 className="mb-3 text-sm font-semibold text-[#1f1824]">{title}</h2>
      {children}
    </section>
  );
}
