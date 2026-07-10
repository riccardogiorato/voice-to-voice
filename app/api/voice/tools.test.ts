import { expect, test } from "bun:test";
import { AVAILABLE_TOOLS, runToolCall } from "./tools";

test("exposes a dedicated current-time tool", () => {
  expect(AVAILABLE_TOOLS.map((tool) => tool.function.name)).toContain(
    "get_current_time",
  );
  expect(AVAILABLE_TOOLS.map((tool) => tool.function.name)).toContain(
    "get_user_location",
  );
});

test("gets current time in the user's Vercel-detected time zone", async () => {
  const before = new Date();
  const result = JSON.parse(
    await runToolCall(
      {
        id: "call_time",
        type: "function",
        function: { name: "get_current_time", arguments: "{}" },
      },
      new AbortController().signal,
      { timeZone: "Europe/Rome", country: "IT" },
    ),
  );
  const after = new Date();

  expect(result.timeZone).toBe("Europe/Rome");
  expect(result.formatted).toContain("GMT+02:00");
  expect(result.formatted).toMatch(/\b\d{2}:\d{2}:\d{2}\b/);
  expect(result.formatted).not.toMatch(/\b(?:AM|PM)\b/);
  expect(new Date(result.utc).getTime()).toBeGreaterThanOrEqual(before.getTime());
  expect(new Date(result.utc).getTime()).toBeLessThanOrEqual(after.getTime());
});

test("keeps AM/PM for regions that conventionally use a 12-hour clock", async () => {
  const result = JSON.parse(
    await runToolCall(
      {
        id: "call_time_us",
        type: "function",
        function: { name: "get_current_time", arguments: "{}" },
      },
      new AbortController().signal,
      { timeZone: "America/New_York", country: "US" },
    ),
  );

  expect(result.formatted).toMatch(/\b(?:AM|PM)\b/);
});

test("returns the user's approximate Vercel location separately", async () => {
  const result = JSON.parse(
    await runToolCall(
      {
        id: "call_location",
        type: "function",
        function: { name: "get_user_location", arguments: "{}" },
      },
      new AbortController().signal,
      {
        timeZone: "Europe/Rome",
        city: "Rome",
        countryRegion: "62",
        country: "IT",
      },
    ),
  );

  expect(result).toEqual({
    available: true,
    approximate: true,
    city: "Rome",
    countryRegion: "62",
    country: "IT",
    timeZone: "Europe/Rome",
  });
});

test("does not expose implementation details in the location tool description", () => {
  const locationTool = AVAILABLE_TOOLS.find(
    (tool) => tool.function.name === "get_user_location",
  );
  expect(locationTool?.function.description).not.toMatch(/\bIP\b|header/i);
});

test("lets the model request another valid time zone", async () => {
  const result = JSON.parse(
    await runToolCall(
      {
        id: "call_time",
        type: "function",
        function: {
          name: "get_current_time",
          arguments: JSON.stringify({
            time_zone: "America/New_York",
            country_code: "US",
          }),
        },
      },
      new AbortController().signal,
      { timeZone: "Europe/Rome", country: "IT" },
    ),
  );

  expect(result.timeZone).toBe("America/New_York");
  expect(result.country).toBe("US");
  expect(result.formatted).toMatch(/\b(?:AM|PM)\b/);
});
