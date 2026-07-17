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

export type ToolActivity = {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  input?: string;
  summary?: string;
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
      "Get the exact current date and time using the clock convention of the relevant region. Omit both arguments for the user's local time.",
    parameters: {
      type: "object",
      properties: {
        time_zone: {
          type: "string",
          description:
            "Optional IANA time zone. Omit it to use the user's detected time zone.",
        },
        country_code: {
          type: "string",
          description:
            "Optional two-letter country code used for the region's 12-hour or 24-hour clock convention. Provide it with time_zone for another place.",
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
      "Get the user's approximate current region and time zone. Use only when location is relevant, and describe the result naturally as approximate.",
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

export async function runToolCallWithActivity(
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

function runGetCurrentTime(
  toolCall: TogetherToolCall,
  userContext: UserContext,
  now = new Date(),
) {
  let args: { time_zone?: unknown; country_code?: unknown };
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

  const requestedCountry = validCountryCode(args.country_code);
  const country = requestedCountry ?? validCountryCode(userContext.country) ?? "US";
  const formatted = new Intl.DateTimeFormat(`en-${country}`, {
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
    country,
    formatted,
  });
}

function validCountryCode(value: unknown) {
  if (typeof value !== "string" || !/^[a-z]{2}$/i.test(value.trim())) {
    return undefined;
  }
  return value.trim().toUpperCase();
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
