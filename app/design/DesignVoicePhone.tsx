"use client";

import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { VoicePhoneLayout } from "@/app/_components/voice/VoicePhoneLayout";
import type { ConversationTimelineItem } from "@/app/_hooks/useVoiceConversation";

const completedSearch = {
  type: "tool" as const,
  id: "design-flow-search",
  name: "web_search",
  status: "completed" as const,
  input: "weather in Venice tomorrow",
  summary: "Found a current forecast for Venice.",
};

const flow = [
  {
    name: "Idle",
    phase: "idle" as const,
    status: { label: "Tap anywhere", detail: "Start voice chat" },
    activity: 0,
    micLevel: 0,
    items: [] as ConversationTimelineItem[],
    duration: 0,
  },
  {
    name: "Connecting",
    phase: "connecting" as const,
    status: { label: "Connecting", detail: "Opening" },
    activity: 0.16,
    micLevel: 0.12,
    items: [] as ConversationTimelineItem[],
    duration: 1100,
  },
  {
    name: "Listening",
    phase: "listening" as const,
    status: { label: "Listening", detail: "Live" },
    activity: 0.48,
    micLevel: 0.7,
    items: [
      {
        type: "turn" as const,
        role: "user" as const,
        text: "What will the weather be like in Venice tomorrow?",
        settled: false,
        live: true,
      },
    ],
    duration: 1800,
  },
  {
    name: "Thinking",
    phase: "thinking" as const,
    status: { label: "Thinking", detail: "Working" },
    activity: 0.34,
    micLevel: 0.18,
    items: [
      {
        type: "turn" as const,
        role: "user" as const,
        text: "What will the weather be like in Venice tomorrow?",
      },
      {
        ...completedSearch,
        status: "running" as const,
        summary: undefined,
      },
    ],
    duration: 1600,
  },
  {
    name: "Speaking",
    phase: "speaking" as const,
    status: { label: "Speaking", detail: "Replying" },
    activity: 0.76,
    micLevel: 0.1,
    items: [
      {
        type: "turn" as const,
        role: "user" as const,
        text: "What will the weather be like in Venice tomorrow?",
      },
      completedSearch,
      {
        type: "turn" as const,
        role: "assistant" as const,
        text: "Tomorrow looks mild and cloudy, with a light breeze near the lagoon.",
        live: true,
      },
    ],
    duration: 2200,
  },
  {
    name: "Reply ready",
    phase: "listening" as const,
    status: { label: "Listening", detail: "Live" },
    activity: 0.2,
    micLevel: 0.3,
    items: [
      {
        type: "turn" as const,
        role: "user" as const,
        text: "What will the weather be like in Venice tomorrow?",
      },
      completedSearch,
      {
        type: "turn" as const,
        role: "assistant" as const,
        text: "Tomorrow looks mild and cloudy, with a light breeze near the lagoon.",
      },
    ],
    duration: 0,
  },
  {
    name: "Call ended",
    phase: "idle" as const,
    status: { label: "Call ended", detail: "Resume or start new" },
    activity: 0,
    micLevel: 0,
    items: [
      {
        type: "turn" as const,
        role: "user" as const,
        text: "What will the weather be like in Venice tomorrow?",
      },
      completedSearch,
      {
        type: "turn" as const,
        role: "assistant" as const,
        text: "Tomorrow looks mild and cloudy, with a light breeze near the lagoon.",
      },
    ],
    duration: 0,
  },
];

export function DesignVoicePhone() {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const current = flow[step];

  useEffect(() => {
    if (!playing || current.duration === 0) {
      if (playing && step === flow.length - 1) setPlaying(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setStep((value) => Math.min(value + 1, flow.length - 1));
    }, current.duration);

    return () => window.clearTimeout(timer);
  }, [current.duration, playing, step]);

  function play() {
    setStep(1);
    setPlaying(true);
  }

  function selectStep(index: number) {
    setPlaying(false);
    setStep(index);
  }

  return (
    <div className="space-y-4">
      <div className="relative z-20 flex flex-wrap items-center gap-2">
        <button
          className="flex items-center gap-1.5 rounded-full bg-[#050505] px-3 py-2 text-xs font-semibold text-white transition-transform duration-150 active:scale-[0.96]"
          type="button"
          onClick={play}
        >
          <RotateCcw className="size-3.5" aria-hidden />
          Replay flow
        </button>
        {flow.map((state, index) => (
          <button
            className={`rounded-full px-3 py-2 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96] ${
              index === step
                ? "bg-[#efe6fa] text-[#633a82]"
                : "bg-white/72 text-[#5f5268]"
            }`}
            type="button"
            onClick={() => selectStep(index)}
            key={`${state.name}-${index}`}
          >
            {state.name}
          </button>
        ))}
      </div>

      <VoicePhoneLayout
        embedded
        phase={current.phase}
        isActive={current.phase !== "idle"}
        muted={false}
        activity={current.activity}
        micLevel={current.micLevel}
        status={current.status}
        conversationItems={current.items}
        hasTurns={current.items.length > 0}
        onStart={play}
        onStartNew={() => selectStep(0)}
        onToggleMute={() => undefined}
        onStop={() => selectStep(flow.length - 1)}
      />
    </div>
  );
}
