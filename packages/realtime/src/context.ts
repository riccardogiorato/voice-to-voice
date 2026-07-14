import { RealtimeProtocolError, type ConversationMessage } from "./types.js";

export function estimateConversationTokens(
  instructions: string,
  messages: ConversationMessage[],
) {
  let chars = instructions.length;
  for (const message of messages) {
    chars += "text" in message
      ? message.text.length
      : "toolCall" in message
        ? message.toolCall.name.length + message.toolCall.arguments.length
        : message.toolResult.name.length + message.toolResult.output.length;
    chars += 16;
  }
  return Math.ceil(chars / 4);
}

export function fitConversation(input: {
  instructions: string;
  messages: ConversationMessage[];
  contextWindowTokens: number;
  outputReserveTokens: number;
  truncation: "auto" | "disabled";
}) {
  const maximumInput = input.contextWindowTokens - input.outputReserveTokens;
  if (maximumInput <= 0) throw new Error("replyContextWindowTokens must exceed maxOutputTokens.");
  const messages = [...input.messages];
  const removed: ConversationMessage[] = [];

  while (estimateConversationTokens(input.instructions, messages) > maximumInput) {
    if (input.truncation === "disabled") {
      throw new RealtimeProtocolError(
        "The next response exceeds the configured reply model context window and truncation is disabled.",
        "context_length_exceeded",
        "truncation",
      );
    }
    if (messages.length === 0) {
      throw new RealtimeProtocolError(
        "Instructions exceed the configured reply model context window.",
        "context_length_exceeded",
        "instructions",
      );
    }
    removeOldestCompleteTurn(messages, removed);
  }

  return { messages, removed };
}

function removeOldestCompleteTurn(
  messages: ConversationMessage[],
  removed: ConversationMessage[],
) {
  const firstUser = messages.findIndex((message) => message.role === "user");
  if (firstUser > 0) removed.push(...messages.splice(0, firstUser));
  if (messages.length === 0) return;

  let nextUser = messages.findIndex((message, index) => index > 0 && message.role === "user");
  if (nextUser < 0) nextUser = messages.length;
  removed.push(...messages.splice(0, nextUser));

  // A function call and its result are a single atomic assistant turn. If a
  // malformed history starts with a result after removal, remove it too.
  while (messages[0]?.role === "tool") removed.push(messages.shift()!);
}
