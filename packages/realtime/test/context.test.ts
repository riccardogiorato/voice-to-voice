import { describe, expect, it } from "vitest";
import { estimateConversationTokens, fitConversation, type ConversationMessage } from "../src/index.js";

describe("conversation context", () => {
  const history: ConversationMessage[] = [
    { id: "u1", role: "user", text: "old ".repeat(100) },
    { id: "c1", role: "assistant", toolCall: { callId: "call1", name: "clock", arguments: "{}" } },
    { id: "r1", role: "tool", toolResult: { callId: "call1", name: "clock", output: "noon" } },
    { id: "a1", role: "assistant", text: "It is noon." },
    { id: "u2", role: "user", text: "new question" },
  ];

  it("removes oldest complete turns and never orphans a tool result", () => {
    const fitted = fitConversation({
      instructions: "system",
      messages: history,
      contextWindowTokens: 80,
      outputReserveTokens: 20,
      truncation: "auto",
    });
    expect(fitted.messages[0]?.id).toBe("u2");
    expect(fitted.removed.map((item) => item.id)).toEqual(["u1", "c1", "r1", "a1"]);
    expect(estimateConversationTokens("system", fitted.messages)).toBeLessThanOrEqual(60);
  });

  it("returns a clear error when truncation is disabled", () => {
    expect(() => fitConversation({
      instructions: "system",
      messages: history,
      contextWindowTokens: 80,
      outputReserveTokens: 20,
      truncation: "disabled",
    })).toThrow("truncation is disabled");
  });
});
