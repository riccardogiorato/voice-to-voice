import {
  CHAT_MODELS,
  compactErrorBody,
  systemPrompt,
} from "./voice-utils";
import { AVAILABLE_TOOLS, LOCAL_CONTEXT_TOOLS, runToolCall } from "./tools";
import type { ChatMessage } from "./voice-utils";
import type { TogetherToolCall } from "./tools";
import type { UserContext } from "./user-context";

type TogetherMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "assistant";
      content: string;
      tool_calls: TogetherToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

type ChatStreamResult = {
  content: string;
  toolCalls: TogetherToolCall[];
  reasoningChars: number;
};

export type ToolActivity = {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  input?: string;
  summary?: string;
};

export type ReplyDebugEvent = {
  model: string;
  attempt: number;
  kind: "stream.chunk" | "stream.done";
  rawContent?: string;
  reasoningChars?: number;
  toolCallDeltas?: unknown[];
  finishReason?: string | null;
  usage?: unknown;
};

const MAX_TOOL_ROUNDS = 1;
const FINAL_ANSWER_PROTOCOL_REMINDER =
  "The next response is the final spoken answer. Begin it with exactly one " +
  "<lang:xx> prefix for the language you will use, then plain spoken text. " +
  "The prefix is not XML: do not close or repeat it.";

export async function generateAssistantReply({
  history,
  transcript,
  userContext = {},
  signal,
  onDelta,
  onLanguage,
  onToolActivity,
  onDebug,
}: {
  history: ChatMessage[];
  transcript: string;
  userContext?: UserContext;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onLanguage?: (language: string) => void;
  onToolActivity?: (activity: ToolActivity) => void;
  onDebug?: (event: ReplyDebugEvent) => void;
}) {
  const messages: TogetherMessage[] = [
    {
      role: "system",
      content: buildSystemMessageContent(new Date(), userContext),
    },
    ...history,
  ];

  let lastError: unknown;
  for (const model of CHAT_MODELS) {
    let emittedForModel = false;
    try {
      return await answerWithModel(
        model,
        messages,
        signal,
        (delta) => {
          emittedForModel = true;
          onDelta(delta);
        },
        (language) => onLanguage?.(language),
        onToolActivity,
        userContext,
        (event) => onDebug?.({ model, attempt: 1, ...event }),
      );
    } catch (error) {
      lastError = error;
      if (signal.aborted || emittedForModel) throw error;
      console.error("Together reply model failed", {
        model,
        messageCount: messages.length,
        lastUserLength: transcript.length,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw lastError ?? new Error("Reply generation failed.");
}

export function buildSystemMessageContent(
  now = new Date(),
  userContext: UserContext = {},
) {
  const spokenDate = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(now).replace(",", "");

  return `${systemPrompt}
CURRENT DATE: ${spokenDate} (UTC).
USER TIME ZONE: ${userContext.timeZone ?? "unknown"}.
Time rules:
- For the current time or date, call get_current_time. Do not use web search as a clock.
- Omit tool arguments for the user's local time. For another place, pass its IANA time zone and two-letter country code.
- Preserve the tool result's regional 12-hour or 24-hour clock convention in your answer.
Location rules:
- Call get_user_location only when the user's approximate location is relevant.
- Phrase the result naturally, such as "It looks like you're in Italy."
- Do not explain how the location was estimated or mention technical implementation details.
Web search rules:
- Search for current facts or explicit lookup, verification, and source requests.
- Always search: news, live or recent sports, weather, prices, current officeholders, and ongoing events.
- Do not search: casual or creative requests, stable knowledge, your identity or capabilities, or provided app facts.
- If recency matters, search the current answer and include ${now.getUTCFullYear()} in the query. Never use an older year from memory.
- Answer from tool results briefly without mentioning hidden reasoning.`;
}

async function answerWithModel(
  model: string,
  initialMessages: TogetherMessage[],
  signal: AbortSignal,
  onDelta: (delta: string) => void,
  onLanguage: (language: string) => void,
  onToolActivity: ((activity: ToolActivity) => void) | undefined,
  userContext: UserContext,
  onDebug: ((event: Omit<ReplyDebugEvent, "model" | "attempt">) => void) | undefined,
) {
  const messages = initialMessages.map((message) => ({ ...message })) as TogetherMessage[];
  let finalContent = "";
  let rawFinalContent = "";
  let replyLanguageResolved = false;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const allowTools = round < MAX_TOOL_ROUNDS;
    const availableTools = process.env.EXA_API_KEY
      ? AVAILABLE_TOOLS
      : LOCAL_CONTEXT_TOOLS;
    const roundContent: string[] = [];
    const result = await streamTogetherChat({
      model,
      messages,
      signal,
      tools: allowTools ? availableTools : undefined,
      streamContent: (delta) => {
        if (allowTools) {
          roundContent.push(delta);
          return;
        }
        emitFinalDelta(delta);
      },
      onDebug,
    });

    if (signal.aborted) throw new Error("Reply cancelled.");

    const textToolCall = allowTools ? extractTextToolCall(result.content) : null;
    if (textToolCall) {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [textToolCall],
      });
      const toolResult = await runToolCallWithActivity(
        textToolCall,
        signal,
        onToolActivity,
        userContext,
      );
      messages.push({
        role: "tool",
        tool_call_id: textToolCall.id,
        content: toolResult,
      });
      messages.push({
        role: "system",
        content: FINAL_ANSWER_PROTOCOL_REMINDER,
      });
      continue;
    }

    if (result.toolCalls.length === 0) {
      if (allowTools && roundContent.length > 0) {
        emitFinalDelta(stripToolMarkup(roundContent.join("")));
      }
      if (!finalContent.trim()) throw new Error("Reply model returned no content.");
      return finalContent.trim();
    }

    messages.push({
      role: "assistant",
      content: result.content.trim(),
      tool_calls: result.toolCalls,
    });

    for (const toolCall of result.toolCalls.slice(0, 2)) {
      const toolResult = await runToolCallWithActivity(
        toolCall,
        signal,
        onToolActivity,
        userContext,
      );
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolResult,
      });
    }
    messages.push({
      role: "system",
      content: FINAL_ANSWER_PROTOCOL_REMINDER,
    });
  }

  throw new Error("Reply model did not produce a final answer after tool use.");

  function emitFinalDelta(delta: string) {
    rawFinalContent += delta;
    const parsed = parseReplyLanguagePrefix(rawFinalContent);
    if (parsed.pending) return;

    if (!replyLanguageResolved) {
      replyLanguageResolved = true;
      // A missing tag must not reset a previously confirmed non-English TTS
      // context. English is already the session default for first turns.
      if (parsed.language) onLanguage(parsed.language);
    }

    const nextContent = stripAssistantMarkdown(
      stripReplyLanguageControlTags(parsed.content),
    );
    if (!nextContent.startsWith(finalContent)) {
      const safeDelta = stripAssistantMarkdown(delta);
      if (!safeDelta) return;
      finalContent += safeDelta;
      onDelta(safeDelta);
      return;
    }

    const safeDelta = nextContent.slice(finalContent.length);
    finalContent = nextContent;
    if (safeDelta) onDelta(safeDelta);
  }
}

type ReplyLanguagePrefix =
  | { pending: true }
  | { pending: false; language: string | null; content: string };

export function parseReplyLanguagePrefix(content: string): ReplyLanguagePrefix {
  const leadingWhitespace = content.match(/^\s*/)?.[0].length ?? 0;
  const candidate = content.slice(leadingWhitespace);
  if (!candidate) return { pending: true };

  const compactTag = candidate.match(
    /^<lang:\s*([a-z]{2}(?:-[a-z]{2})?)\s*>\s*/i,
  );
  if (compactTag) {
    return {
      pending: false,
      language: compactTag[1].toLowerCase(),
      content: candidate.slice(compactTag[0].length),
    };
  }

  const xmlTag = candidate.match(
    /^<language>\s*([a-z]{2}(?:-[a-z]{2})?)\s*<\/language>\s*/i,
  );
  if (xmlTag) {
    return {
      pending: false,
      language: xmlTag[1].toLowerCase(),
      content: candidate.slice(xmlTag[0].length),
    };
  }

  const lowerCandidate = candidate.toLowerCase();
  const mightBeSplitTag =
    "<lang:".startsWith(lowerCandidate) ||
    "<language>".startsWith(lowerCandidate) ||
    (lowerCandidate.startsWith("<lang:") && !lowerCandidate.includes(">")) ||
    (lowerCandidate.startsWith("<language>") &&
      !lowerCandidate.includes("</language>"));
  if (mightBeSplitTag && candidate.length < 48) return { pending: true };

  // Never expose malformed control metadata to the user or TTS.
  const withoutMalformedTag = candidate.replace(
    /^<lang(?:uage)?[^>]*>\s*/i,
    "",
  );
  return { pending: false, language: null, content: withoutMalformedTag };
}

export function stripReplyLanguageControlTags(content: string) {
  const withoutCompleteTags = content.replace(
    /\s*<\/lang(?:uage)?(?::[a-z]{2}(?:-[a-z]{2})?)?>\s*/gi,
    " ",
  );
  const lastTagStart = withoutCompleteTags.lastIndexOf("<");
  if (lastTagStart < 0) return withoutCompleteTags;

  const suffix = withoutCompleteTags.slice(lastTagStart).trim().toLowerCase();
  const isPartialClosingTag =
    "</lang:".startsWith(suffix) ||
    "</language>".startsWith(suffix) ||
    /^<\/lang(?:uage)?(?::[a-z-]*)?>?$/i.test(suffix);
  return isPartialClosingTag
    ? withoutCompleteTags.slice(0, lastTagStart).trimEnd()
    : withoutCompleteTags;
}

async function streamTogetherChat({
  model,
  messages,
  signal,
  tools,
  streamContent,
  onDebug,
}: {
  model: string;
  messages: TogetherMessage[];
  signal: AbortSignal;
  tools?: ReadonlyArray<(typeof AVAILABLE_TOOLS)[number]>;
  streamContent: (delta: string) => void;
  onDebug?: (event: Omit<ReplyDebugEvent, "model" | "attempt">) => void;
}): Promise<ChatStreamResult> {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.35,
    stream: true,
    stream_options: { include_usage: true },
    reasoning: { enabled: true },
    reasoning_effort: "low",
    chat_template_kwargs: {
      enable_thinking: true,
      thinking: true,
    },
  };

  if (tools) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const response = await fetch("https://api.together.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.TOGETHER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok || !response.body) {
    const errorBody = await response.text().catch(() => "");
    const message = compactErrorBody(errorBody);
    throw new Error(
      `Together chat failed with ${response.status}${message ? `: ${message}` : ""}`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, TogetherToolCall>();
  let buffer = "";
  let content = "";
  let reasoningChars = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        onDebug?.({ kind: "stream.done" });
        return {
          content,
          toolCalls: [...toolCalls.values()],
          reasoningChars,
        };
      }

      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }

      const choice = json.choices?.[0];
      const delta = choice?.delta;
      const rawContent = typeof delta?.content === "string" ? delta.content : undefined;
      const deltaReasoningChars =
        typeof delta?.reasoning === "string" ? delta.reasoning.length : undefined;
      const toolCallDeltas = Array.isArray(delta?.tool_calls)
        ? delta.tool_calls
        : undefined;
      const finishReason =
        typeof choice?.finish_reason === "string" || choice?.finish_reason === null
          ? choice.finish_reason
          : undefined;
      if (
        rawContent !== undefined ||
        deltaReasoningChars !== undefined ||
        toolCallDeltas !== undefined ||
        finishReason !== undefined ||
        json.usage !== undefined
      ) {
        onDebug?.({
          kind: "stream.chunk",
          ...(rawContent !== undefined ? { rawContent } : {}),
          ...(deltaReasoningChars !== undefined
            ? { reasoningChars: deltaReasoningChars }
            : {}),
          ...(toolCallDeltas !== undefined ? { toolCallDeltas } : {}),
          ...(finishReason !== undefined ? { finishReason } : {}),
          ...(json.usage !== undefined ? { usage: json.usage } : {}),
        });
      }
      if (!delta) continue;

      if (typeof delta.reasoning === "string") {
        reasoningChars += delta.reasoning.length;
      }

      if (typeof delta.content === "string" && delta.content.length > 0) {
        const visibleContent = stripLeadingFinalMarker(delta.content, content);
        if (visibleContent.length > 0) {
          content += visibleContent;
          streamContent(stripToolMarkup(visibleContent));
        }
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const callDelta of delta.tool_calls) {
          const index = typeof callDelta.index === "number" ? callDelta.index : 0;
          const existing =
            toolCalls.get(index) ??
            ({
              id: "",
              type: "function",
              function: { name: "", arguments: "" },
            } satisfies TogetherToolCall);

          if (typeof callDelta.id === "string") existing.id = callDelta.id;
          if (callDelta.type === "function") existing.type = "function";
          if (callDelta.function) {
            if (typeof callDelta.function.name === "string") {
              existing.function.name += callDelta.function.name;
            }
            if (typeof callDelta.function.arguments === "string") {
              existing.function.arguments += callDelta.function.arguments;
            }
          }

          toolCalls.set(index, existing);
        }
      }
    }
  }

  return {
    content,
    toolCalls: [...toolCalls.values()],
    reasoningChars,
  };
}

function stripLeadingFinalMarker(delta: string, currentContent: string) {
  if (currentContent.length > 0) return delta;
  return delta.trim().toLowerCase() === "final" ? "" : delta;
}

async function runToolCallWithActivity(
  toolCall: TogetherToolCall,
  signal: AbortSignal,
  onToolActivity: ((activity: ToolActivity) => void) | undefined,
  userContext: UserContext,
) {
  const baseActivity = describeToolCall(toolCall, userContext);
  onToolActivity?.({ ...baseActivity, status: "running" });

  try {
    const result = await runToolCall(toolCall, signal, userContext);
    onToolActivity?.({
      ...baseActivity,
      status: "completed",
      summary: summarizeToolResult(result),
    });
    return result;
  } catch (error) {
    onToolActivity?.({
      ...baseActivity,
      status: "failed",
      summary: error instanceof Error ? error.message : "Tool call failed.",
    });
    throw error;
  }
}

function describeToolCall(toolCall: TogetherToolCall, userContext: UserContext) {
  const args = parseToolArguments(toolCall);
  const name = toolCall.function.name;
  return {
    id: toolCall.id || `${name}-${Date.now()}`,
    name,
    input:
      typeof args.query === "string"
        ? args.query
        : typeof args.time_zone === "string"
          ? args.time_zone
          : toolCall.function.name === "get_current_time"
            ? userContext.timeZone ?? "UTC"
            : toolCall.function.name === "get_user_location"
              ? "Approximate location"
              : undefined,
  };
}

function parseToolArguments(toolCall: TogetherToolCall) {
  try {
    const parsed = JSON.parse(toolCall.function.arguments || "{}");
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function summarizeToolResult(result: string) {
  try {
    const parsed = JSON.parse(result) as {
      error?: unknown;
      results?: Array<{ title?: unknown }>;
      formatted?: unknown;
      available?: unknown;
      city?: unknown;
      country?: unknown;
      timeZone?: unknown;
    };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim();
    }
    if (Array.isArray(parsed.results)) {
      const count = parsed.results.length;
      const firstTitle = parsed.results.find(
        (item) => typeof item.title === "string" && item.title.trim(),
      )?.title;
      const resultLabel = count === 1 ? "1 result" : `${count} results`;
      return typeof firstTitle === "string" && firstTitle.trim()
        ? `${resultLabel}: ${firstTitle.trim()}`
        : resultLabel;
    }
    if (typeof parsed.formatted === "string" && parsed.formatted.trim()) {
      return parsed.formatted.trim();
    }
    if (parsed.available === true) {
      return [parsed.city, parsed.country, parsed.timeZone]
        .filter(
          (value): value is string =>
            typeof value === "string" && Boolean(value),
        )
        .join(", ");
    }
  } catch {}

  return "Tool completed.";
}

export function extractTextToolCall(content: string): TogetherToolCall | null {
  if (!/<tool_call>|<function=/i.test(content)) return null;

  const name = content.match(/<function=([a-zA-Z0-9_-]+)>/)?.[1];
  if (
    name !== "web_search" &&
    name !== "get_current_time" &&
    name !== "get_user_location"
  ) {
    return null;
  }

  const args: Record<string, string | number> = {};
  for (const match of content.matchAll(
    /<parameter=([a-zA-Z0-9_-]+)>\s*([\s\S]*?)\s*<\/parameter>/g,
  )) {
    const key = match[1];
    const value = match[2].trim();
    if (key === "num_results") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) args[key] = parsed;
    } else if (value) {
      args[key] = value;
    }
  }

  if (
    name === "web_search" &&
    (typeof args.query !== "string" || args.query.trim().length === 0)
  ) {
    return null;
  }

  return {
    id: `text_tool_${name}`,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

export function stripToolMarkup(content: string) {
  if (/<\/?(?:tool_call|function|parameter)(?:[=>\s]|$)/i.test(content)) return "";

  return content
    .replace(/<\/?(?:tool_call|function|parameter)[^>]*>/gi, "");
}

export function stripAssistantMarkdown(content: string) {
  return content
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/```[\w-]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/[*`~]/g, "")
    .replace(/[\u2013\u2014]/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}
