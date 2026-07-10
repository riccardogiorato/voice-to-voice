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
      <div
        ref={scrollRef}
        className="conversation-scroll max-h-[240px] overflow-y-auto overscroll-contain"
      >
        <div className="flex min-h-[132px] flex-col justify-end gap-1.5 px-1 py-5">
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
