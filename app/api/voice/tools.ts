import Exa from "exa-js";
import type { UserContext } from "./user-context";
import { validTimeZone } from "./user-context";

export type TogetherToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export const WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web with Exa for current, recent, or source-backed information. Returns concise result snippets with URLs.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "A focused web search query derived from the user's request and conversation context.",
        },
        num_results: {
          type: "integer",
          description: "Number of results to return, from one to five.",
          minimum: 1,
          maximum: 5,
        },
      },
      required: ["query"],
    },
  },
} as const;

export const GET_CURRENT_TIME_TOOL = {
  type: "function",
  function: {
    name: "get_current_time",
    description:
      "Get the exact current date and time. Omit time_zone for the user's current time zone, or provide an IANA time zone such as Europe/Rome.",
    parameters: {
      type: "object",
      properties: {
        time_zone: {
          type: "string",
          description:
            "Optional IANA time zone. Omit it to use the user's detected time zone.",
        },
      },
    },
  },
} as const;

export const GET_USER_LOCATION_TOOL = {
  type: "function",
  function: {
    name: "get_user_location",
    description:
      "Get the user's approximate location and time zone inferred by Vercel from the connection IP. Use only when location is relevant, and describe it as approximate.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
} as const;

export const LOCAL_CONTEXT_TOOLS = [
  GET_CURRENT_TIME_TOOL,
  GET_USER_LOCATION_TOOL,
] as const;

export const AVAILABLE_TOOLS = [
  ...LOCAL_CONTEXT_TOOLS,
  WEB_SEARCH_TOOL,
] as const;

const WEB_SEARCH_TIMEOUT_MS = 3500;

export async function runToolCall(
  toolCall: TogetherToolCall,
  signal: AbortSignal,
  userContext: UserContext = {},
) {
  if (toolCallRunnerForTest) return toolCallRunnerForTest(toolCall, signal);
  if (toolCall.function.name === "get_current_time") {
    return runGetCurrentTime(toolCall, userContext);
  }
  if (toolCall.function.name === "get_user_location") {
    return runGetUserLocation(userContext);
  }
  if (toolCall.function.name === "web_search") return runWebSearch(toolCall, signal);

  return JSON.stringify({ error: `Unknown tool: ${toolCall.function.name}` });
}

let toolCallRunnerForTest:
  | ((toolCall: TogetherToolCall, signal: AbortSignal) => Promise<string> | string)
  | null = null;

export function setToolCallRunnerForTest(
  runner:
    | ((toolCall: TogetherToolCall, signal: AbortSignal) => Promise<string> | string)
    | null,
) {
  toolCallRunnerForTest = runner;
}

function runGetCurrentTime(
  toolCall: TogetherToolCall,
  userContext: UserContext,
  now = new Date(),
) {
  let args: { time_zone?: unknown };
  try {
    args = JSON.parse(toolCall.function.arguments || "{}");
  } catch {
    args = {};
  }

  const requestedTimeZone =
    typeof args.time_zone === "string" ? args.time_zone : undefined;
  const timeZone = validTimeZone(requestedTimeZone ?? userContext.timeZone ?? "UTC");
  if (!timeZone) {
    return JSON.stringify({
      error: "Invalid time zone. Use an IANA name such as Europe/Rome.",
    });
  }

  const formatted = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone,
    timeZoneName: "longOffset",
  }).format(now);

  return JSON.stringify({
    utc: now.toISOString(),
    timeZone,
    formatted,
  });
}

function runGetUserLocation(userContext: UserContext) {
  if (
    !userContext.city &&
    !userContext.countryRegion &&
    !userContext.country &&
    !userContext.timeZone
  ) {
    return JSON.stringify({
      available: false,
      error: "Approximate location is unavailable for this connection.",
    });
  }

  return JSON.stringify({
    available: true,
    approximate: true,
    city: userContext.city,
    countryRegion: userContext.countryRegion,
    country: userContext.country,
    timeZone: userContext.timeZone,
  });
}

async function runWebSearch(toolCall: TogetherToolCall, signal: AbortSignal) {
  if (!process.env.EXA_API_KEY) {
    return JSON.stringify({ error: "Web search is not configured." });
  }

  let args: { query?: unknown; num_results?: unknown };
  try {
    args = JSON.parse(toolCall.function.arguments || "{}");
  } catch {
    args = {};
  }

  const query = typeof args.query === "string" ? args.query.trim().slice(0, 300) : "";
  if (!query) return JSON.stringify({ error: "Missing search query." });

  const requestedResults =
    typeof args.num_results === "number" && Number.isFinite(args.num_results)
      ? args.num_results
      : 3;
  const numResults = Math.max(1, Math.min(5, Math.round(requestedResults)));
  const exa = new Exa(process.env.EXA_API_KEY);

  const searchPromise = exa.search(query, {
    type: "fast",
    numResults,
    contents: {
      highlights: { maxCharacters: 320 },
      text: { maxCharacters: 500 },
    },
  });

  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Web search timed out.")),
      WEB_SEARCH_TIMEOUT_MS,
    );
  });

  const result = await Promise.race([searchPromise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  if (signal.aborted) throw new Error("Reply cancelled.");

  return JSON.stringify({
    query,
    results: result.results.slice(0, numResults).map((item) => ({
      title: item.title ?? "Untitled",
      url: item.url,
      publishedDate: item.publishedDate ?? null,
      highlights: "highlights" in item ? item.highlights?.slice(0, 2) : undefined,
      text: "text" in item ? item.text?.slice(0, 500) : undefined,
    })),
  });
}
