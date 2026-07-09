import type { ConversationTimelineItem } from "@/app/_hooks/useVoiceConversation";
import { cx } from "./utils";

type TranscriptTurnItem = Extract<ConversationTimelineItem, { type: "turn" }>;

export function VoiceTranscriptBubble({
  item,
  opacity,
}: {
  item: TranscriptTurnItem;
  opacity?: number;
}) {
  const pendingUser = item.role === "user" && item.settled === false;

  return (
    <p
      className={cx(
        "max-w-[86%] text-pretty rounded-[18px] px-3 py-1.5 text-sm leading-5 transition-[background-color,color,opacity,filter,transform,box-shadow] duration-300 ease-out",
        pendingUser
          ? "self-end bg-[#d8d2df]/72 text-[#241a2d]/72 shadow-[0_0_0_1px_rgba(5,5,5,0.04),0_8px_22px_rgba(42,26,52,0.04)] backdrop-blur-xl"
          : item.role === "user"
            ? "self-end bg-[#050505]/88 text-white backdrop-blur-xl"
            : "self-start bg-white/48 text-[#33253d] shadow-[0_0_0_1px_rgba(255,255,255,0.5),0_8px_22px_rgba(42,26,52,0.06)] backdrop-blur-xl",
        item.live && "opacity-100",
      )}
      style={{ opacity }}
    >
      {item.text}
    </p>
  );
}

export function getTranscriptOpacity(item: TranscriptTurnItem, distanceFromEnd: number) {
  if (item.live) return 1;
  if (item.role === "user" && item.settled === false) return 0.86;
  return Math.max(0.6, 0.95 - distanceFromEnd * 0.1);
}
