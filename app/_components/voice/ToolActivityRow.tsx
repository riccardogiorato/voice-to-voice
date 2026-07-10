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
    showInput?: boolean;
  }
> = {
  web_search: {
    icon: "search",
    running: "Searching web",
    completed: "Searched web",
    failed: "Web search failed",
    showInput: true,
  },
  get_current_time: {
    icon: "time",
    running: "Checking current time",
    completed: "Checked current time",
    failed: "Time lookup failed",
    showInput: true,
  },
  get_user_location: {
    icon: "location",
    running: "Finding approximate location",
    completed: "Found approximate location",
    failed: "Location lookup failed",
  },
};

const FALLBACK_PRESENTATION = {
  icon: "tool" as const,
  running: "Using tool",
  completed: "Used tool",
  failed: "Tool failed",
  showInput: true,
};

const TOOL_ICONS = {
  search: Search,
  time: Clock3,
  location: MapPin,
  tool: Wrench,
} satisfies Record<string, LucideIcon>;

type ToolIconName = keyof typeof TOOL_ICONS;

export function getToolActivityPresentation(activity: ToolActivityItem) {
  const presentation = TOOL_PRESENTATIONS[activity.name] ?? FALLBACK_PRESENTATION;
  const label = presentation[activity.status];
  const text =
    presentation.showInput && activity.input
      ? `${label}: ${activity.input}`
      : label;

  return { icon: presentation.icon, label, text };
}

export function ToolActivityRow({ activity }: { activity: ToolActivityItem }) {
  const isRunning = activity.status === "running";
  const isFailed = activity.status === "failed";
  const presentation = getToolActivityPresentation(activity);
  const ToolIcon = TOOL_ICONS[presentation.icon];

  return (
    <div className="max-w-[86%] self-start rounded-[18px] bg-[#e9e9ea] px-3.5 py-2 text-[#121212]">
      <p className="flex min-w-0 items-center gap-1.5 truncate text-sm leading-5 text-[#121212]">
        <ToolIcon
          className="size-3.5 shrink-0 text-[#8f5fb0]"
          aria-hidden
        />
        <span className="truncate">{presentation.text}</span>
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
    </div>
  );
}
