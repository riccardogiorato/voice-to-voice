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
      { timeZone: "Europe/Rome" },
    ),
  );
  const after = new Date();

  expect(result.timeZone).toBe("Europe/Rome");
  expect(result.formatted).toContain("GMT+02:00");
  expect(new Date(result.utc).getTime()).toBeGreaterThanOrEqual(before.getTime());
  expect(new Date(result.utc).getTime()).toBeLessThanOrEqual(after.getTime());
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

test("lets the model request another valid time zone", async () => {
  const result = JSON.parse(
    await runToolCall(
      {
        id: "call_time",
        type: "function",
        function: {
          name: "get_current_time",
          arguments: JSON.stringify({ time_zone: "America/New_York" }),
        },
      },
      new AbortController().signal,
      { timeZone: "Europe/Rome" },
    ),
  );

  expect(result.timeZone).toBe("America/New_York");
});
