import Exa from "exa-js";

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
          description: "A focused web search query.",
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

export const AVAILABLE_TOOLS = [WEB_SEARCH_TOOL] as const;

const WEB_SEARCH_TIMEOUT_MS = 3500;

export async function runToolCall(toolCall: TogetherToolCall, signal: AbortSignal) {
  if (toolCallRunnerForTest) return toolCallRunnerForTest(toolCall, signal);
  if (toolCall.function.name !== "web_search") {
    return JSON.stringify({ error: `Unknown tool: ${toolCall.function.name}` });
  }

  return runWebSearch(toolCall, signal);
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
