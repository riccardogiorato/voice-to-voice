import { LoaderCircle, Search, TriangleAlert } from "lucide-react";
import type { ToolActivityItem } from "@/app/_hooks/useVoiceConversation";
import { cx } from "./utils";

export function ToolActivityRow({ activity }: { activity: ToolActivityItem }) {
  const isRunning = activity.status === "running";
  const isFailed = activity.status === "failed";
  const StatusIcon = isRunning ? LoaderCircle : isFailed ? TriangleAlert : Search;
  const label = isRunning ? "Searching web" : isFailed ? "Search failed" : "Searched web";
  const text = activity.input ? `${label}: ${activity.input}` : label;

  return (
    <div className="max-w-[86%] self-start rounded-[18px] bg-[#e9e9ea] px-3.5 py-2 text-[#121212]">
      <p className="flex min-w-0 items-center gap-1.5 truncate text-sm leading-5 text-[#121212]">
        <StatusIcon
          className={cx("size-3.5 shrink-0 text-[#8f5fb0]", isRunning && "animate-spin")}
          aria-hidden
        />
        <span className="truncate">{text}</span>
      </p>
    </div>
  );
}
