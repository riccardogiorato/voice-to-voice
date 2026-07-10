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
        "voice-message-bubble max-w-[86%] text-pretty px-3.5 py-2 text-sm leading-5 transition-[background-color,color,opacity,filter,transform] duration-300 ease-out",
        pendingUser
          ? "voice-message-user-pending self-end"
          : item.role === "user"
            ? "voice-message-user self-end"
            : "voice-message-assistant self-start",
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
  return Math.max(0.78, 0.98 - distanceFromEnd * 0.07);
}
