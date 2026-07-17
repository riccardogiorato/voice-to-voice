import type { UserContext } from "./user-context";

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
