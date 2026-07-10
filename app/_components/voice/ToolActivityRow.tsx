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
    <div className="max-w-[86%] self-start rounded-[18px] bg-white/48 px-3 py-1.5 text-[#33253d] shadow-[0_0_0_1px_rgba(255,255,255,0.5),0_8px_22px_rgba(42,26,52,0.06)] backdrop-blur-xl">
      <p className="flex min-w-0 items-center gap-1.5 truncate text-sm leading-5 text-[#5a4a64]">
        <StatusIcon
          className={cx("size-3.5 shrink-0 text-[#8f5fb0]", isRunning && "animate-spin")}
          aria-hidden
        />
        <span className="truncate">{text}</span>
      </p>
    </div>
  );
}
