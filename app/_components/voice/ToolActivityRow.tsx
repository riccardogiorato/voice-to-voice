import {
  Clock3,
  LoaderCircle,
  MapPin,
  Search,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { ToolActivityItem } from "@/app/_hooks/useVoiceConversation";

const TOOL_PRESENTATIONS: Record<
  string,
  {
    icon: ToolIconName;
    running: string;
    completed: string;
    failed: string;
    fallback?: string;
  }
> = {
  web_search: {
    icon: "search",
    running: "I’m looking that up…",
    completed: "I found the information.",
    failed: "I couldn’t reach that just now.",
    fallback: "I’ll answer from what I know.",
  },
  get_current_time: {
    icon: "time",
    running: "Checking the time…",
    completed: "I found the current time.",
    failed: "I couldn’t check the time.",
    fallback: "I’ll continue without it.",
  },
  get_user_location: {
    icon: "location",
    running: "Checking your approximate location…",
    completed: "I found your approximate location.",
    failed: "I couldn’t find your location.",
    fallback: "I’ll continue without it.",
  },
};

const FALLBACK_PRESENTATION = {
  icon: "tool" as const,
  running: "I’m checking that…",
  completed: "I found something useful.",
  failed: "I couldn’t check that just now.",
  fallback: "I’ll continue with what I know.",
};

const TOOL_ICONS = {
  search: Search,
  time: Clock3,
  location: MapPin,
  tool: Wrench,
} satisfies Record<string, LucideIcon>;

type ToolIconName = keyof typeof TOOL_ICONS;

const MAX_SEARCH_QUERY_LENGTH = 60;

export function getToolActivityPresentation(activity: ToolActivityItem) {
  const presentation = TOOL_PRESENTATIONS[activity.name] ?? FALLBACK_PRESENTATION;
  const label = presentation[activity.status];
  const text =
    activity.name === "web_search"
      ? getSearchActivityText(activity, label)
      : label;

  return {
    icon: presentation.icon,
    label,
    text,
    ...(activity.status === "failed" && presentation.fallback
      ? { fallback: presentation.fallback }
      : {}),
  };
}

function getSearchActivityText(activity: ToolActivityItem, fallback: string) {
  const query = truncateSearchQuery(activity.input);
  if (!query) {
    return activity.status === "completed"
      ? `${getSearchCompletionText(activity.summary)}.`
      : fallback;
  }

  if (activity.status === "running") {
    return `I’m searching for “${query}”`;
  }
  if (activity.status === "failed") {
    return `I couldn’t search for “${query}”.`;
  }
  return `${getSearchCompletionText(activity.summary)} for “${query}”.`;
}

function getSearchCompletionText(summary?: string) {
  const count = summary?.match(/^(\d+) result(?:s)?\b/i)?.[1];
  if (count === "1") return "I found one result";
  if (count && Number(count) > 1) {
    return `I found ${numberToWord(Number(count))} results`;
  }
  return "I found the information";
}

function truncateSearchQuery(input?: string) {
  const query = input?.trim();
  if (!query || query.length <= MAX_SEARCH_QUERY_LENGTH) return query;
  return `${query.slice(0, MAX_SEARCH_QUERY_LENGTH - 1).trimEnd()}…`;
}

function numberToWord(value: number) {
  return (
    ["zero", "one", "two", "three", "four", "five"][value] ?? `${value}`
  );
}

export function ToolActivityRow({ activity }: { activity: ToolActivityItem }) {
  const isRunning = activity.status === "running";
  const isFailed = activity.status === "failed";
  const presentation = getToolActivityPresentation(activity);
  const ToolIcon = TOOL_ICONS[presentation.icon];

  return (
    <div
      className={`max-w-[86%] self-start rounded-[18px] px-3.5 py-2 text-[#121212] ${
        isFailed ? "bg-[#f0ebee]" : "bg-[#e9e9ea]"
      }`}
    >
      <p className="flex min-w-0 items-center gap-1.5 text-sm leading-5 text-[#121212]">
        <ToolIcon
          className={`size-3.5 shrink-0 ${isFailed ? "text-[#a36d83]" : "text-[#8f5fb0]"}`}
          aria-hidden
        />
        <span className="min-w-0">{presentation.text}</span>
        {isRunning ? (
          <LoaderCircle
            className="ml-auto size-3.5 shrink-0 animate-spin text-[#8f5fb0]"
            aria-hidden
          />
        ) : null}
        {isFailed ? (
          <TriangleAlert
            className="ml-auto size-3.5 shrink-0 text-[#a24f68]"
            aria-hidden
          />
        ) : null}
      </p>
      {isFailed && presentation.fallback ? (
        <p className="mt-0.5 pl-5 text-[11px] leading-4 text-[#806b76]">
          {presentation.fallback}
        </p>
      ) : null}
    </div>
  );
}
