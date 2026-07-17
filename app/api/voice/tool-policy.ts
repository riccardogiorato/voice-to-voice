import type { UserContext } from "./user-context";

export type VoiceToolPlan =
  | { name: "get_current_time"; arguments: Record<string, never> }
  | { name: "get_user_location"; arguments: Record<string, never> }
  | {
      name: "web_search";
      arguments: { query: string; num_results: number };
    };

const WEB_LOOKUP_PATTERN =
  /\b(search|look\s*up|browse|check(?:\s+the)?\s+(?:web|internet)|verify|source|sources|latest|recent|news|headlines|weather|forecast|price|prices|stock|stocks|score|scores|result|results|match|matches|game|games|schedule|standings|live|released|releases|officeholder|president|prime minister|ceo)\b/i;
const GENERIC_RECENCY_PATTERN = /\b(today|currently|right now)\b/i;
const CASUAL_RECENCY_PATTERN =
  /\b(how are you|how(?:'s| is) it going|what are you doing|reserve|reservation|book|table)\b/i;
const CURRENT_TIME_PATTERN =
  /\b(what(?:'s| is)\s+(?:the\s+)?(?:current\s+)?time|what time is it|current time|time right now|today(?:'s)? date|what(?:'s| is)\s+(?:the\s+)?date|what day is it)\b/i;
const USER_LOCATION_PATTERN =
  /\b(where am i|what(?:'s| is)\s+my\s+(?:current\s+)?location|which\s+(?:city|country|region)\s+am i in)\b/i;

export function planVoiceToolForTranscript(
  transcript: string,
  now = new Date(),
): VoiceToolPlan | null {
  const normalized = transcript.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  // Current sports and explicit lookups need external facts even when they also
  // contain words such as "time" or "date".
  if (WEB_LOOKUP_PATTERN.test(normalized)) {
    return buildWebSearchPlan(normalized, now);
  }

  if (CURRENT_TIME_PATTERN.test(normalized)) {
    return { name: "get_current_time", arguments: {} };
  }

  if (USER_LOCATION_PATTERN.test(normalized)) {
    return { name: "get_user_location", arguments: {} };
  }

  if (
    GENERIC_RECENCY_PATTERN.test(normalized) &&
    !CASUAL_RECENCY_PATTERN.test(normalized)
  ) {
    return buildWebSearchPlan(normalized, now);
  }

  return null;
}

function buildWebSearchPlan(transcript: string, now: Date): VoiceToolPlan {
  const year = String(now.getUTCFullYear());
  const baseQuery = transcript.replace(/[.!?]+$/, "");
  return {
    name: "web_search",
    arguments: {
      query: baseQuery.includes(year) ? baseQuery : `${baseQuery} ${year}`,
      num_results: 3,
    },
  };
}

export function buildVoiceToolPolicyPrompt(
  now = new Date(),
  userContext: UserContext = {},
) {
  const spokenDate = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })
    .format(now)
    .replace(",", "");

  return `CURRENT DATE: ${spokenDate} (UTC).
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
