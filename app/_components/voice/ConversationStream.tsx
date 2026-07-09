import type { Ref } from "react";
import type { ConversationTimelineItem } from "@/app/_hooks/useVoiceConversation";
import { ToolActivityRow } from "./ToolActivityRow";
import { getTranscriptOpacity, VoiceTranscriptBubble } from "./TranscriptBubble";

export function VoiceConversationStream({
  items,
  scrollRef,
}: {
  items: ConversationTimelineItem[];
  scrollRef?: Ref<HTMLDivElement>;
}) {
  if (items.length === 0) return null;

  return (
    <div className="conversation-stream">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-10 bg-linear-to-b from-[#fdfcf9]/80 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-linear-to-t from-[#fdfcf9]/72 to-transparent" />
      <div
        ref={scrollRef}
        className="conversation-scroll max-h-[240px] overflow-y-auto overscroll-contain"
      >
        <div className="flex min-h-[120px] flex-col justify-end gap-1.5 px-1 py-3">
          {items.map((item, index) => {
            if (item.type === "tool") {
              return <ToolActivityRow activity={item} key={`tool-${item.id}`} />;
            }

            return (
              <VoiceTranscriptBubble
                item={item}
                key={`${item.role}-${index}`}
                opacity={getTranscriptOpacity(item, items.length - index - 1)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
