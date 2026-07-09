import {
  CHAT_MODELS,
  compactErrorBody,
  systemPrompt,
} from "./voice-utils";
import { AVAILABLE_TOOLS, runToolCall } from "./tools";
import type { ChatMessage } from "./voice-utils";
import type { TogetherToolCall } from "./tools";

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

const MAX_TOOL_ROUNDS = 1;

export async function generateAssistantReply({
  history,
  transcript,
  signal,
  onDelta,
  onToolActivity,
}: {
  history: ChatMessage[];
  transcript: string;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onToolActivity?: (activity: ToolActivity) => void;
}) {
  const messages: TogetherMessage[] = [
    {
      role: "system",
      content: buildSystemMessageContent(),
    },
    ...history,
  ];

  let lastError: unknown;
  for (const model of CHAT_MODELS) {
    let emittedForModel = false;
    try {
      return await answerWithModel(model, messages, signal, (delta) => {
        emittedForModel = true;
        onDelta(delta);
      }, onToolActivity);
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

export function buildSystemMessageContent(now = new Date()) {
  const isoDate = now.toISOString().slice(0, 10);
  const spokenDate = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(now);

  return (
    `${systemPrompt} Today is ${spokenDate} (${isoDate}, UTC). ` +
    "Use web_search for current or recent facts, including sports, schedules, news, and weather; don't answer those from memory."
  );
}

async function answerWithModel(
  model: string,
  initialMessages: TogetherMessage[],
  signal: AbortSignal,
  onDelta: (delta: string) => void,
  onToolActivity: ((activity: ToolActivity) => void) | undefined,
) {
  const messages = initialMessages.map((message) => ({ ...message })) as TogetherMessage[];
  let finalContent = "";
  let rawFinalContent = "";

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const allowTools = round < MAX_TOOL_ROUNDS && Boolean(process.env.EXA_API_KEY);
    const roundContent: string[] = [];
    const result = await streamTogetherChat({
      model,
      messages,
      signal,
      tools: allowTools ? AVAILABLE_TOOLS : undefined,
      streamContent: (delta) => {
        if (allowTools) {
          roundContent.push(delta);
          return;
        }
        emitFinalDelta(delta);
      },
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
      );
      messages.push({
        role: "tool",
        tool_call_id: textToolCall.id,
        content: toolResult,
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
      );
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolResult,
      });
    }
  }

  throw new Error("Reply model did not produce a final answer after tool use.");

  function emitFinalDelta(delta: string) {
    rawFinalContent += delta;
    const nextContent = stripAssistantMarkdown(rawFinalContent);
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

async function streamTogetherChat({
  model,
  messages,
  signal,
  tools,
  streamContent,
}: {
  model: string;
  messages: TogetherMessage[];
  signal: AbortSignal;
  tools?: typeof AVAILABLE_TOOLS;
  streamContent: (delta: string) => void;
}): Promise<ChatStreamResult> {
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: 180,
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

      const delta = json.choices?.[0]?.delta;
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
) {
  const baseActivity = describeToolCall(toolCall);
  onToolActivity?.({ ...baseActivity, status: "running" });

  try {
    const result = await runToolCall(toolCall, signal);
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

function describeToolCall(toolCall: TogetherToolCall) {
  const args = parseToolArguments(toolCall);
  const name = toolCall.function.name;
  return {
    id: toolCall.id || `${name}-${Date.now()}`,
    name,
    input: typeof args.query === "string" ? args.query : undefined,
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
  } catch {}

  return "Tool completed.";
}

export function extractTextToolCall(content: string): TogetherToolCall | null {
  if (!/<tool_call>|<function=/i.test(content)) return null;

  const name = content.match(/<function=([a-zA-Z0-9_-]+)>/)?.[1];
  if (name !== "web_search") return null;

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

  if (typeof args.query !== "string" || args.query.trim().length === 0) return null;

  return {
    id: "text_tool_web_search",
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
