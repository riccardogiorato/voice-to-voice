import { expect, test } from "bun:test";
import { getToolActivityPresentation } from "./ToolActivityRow";

test("describes a current-time lookup conversationally", () => {
  expect(
    getToolActivityPresentation({
      id: "call_time",
      name: "get_current_time",
      input: "Europe/Rome",
      status: "completed",
    }),
  ).toEqual({
    icon: "time",
    label: "I found the current time.",
    text: "I found the current time.",
  });
});

test("describes approximate location conversationally", () => {
  expect(
    getToolActivityPresentation({
      id: "call_location",
      name: "get_user_location",
      input: "IP-derived location",
      status: "completed",
    }),
  ).toEqual({
    icon: "location",
    label: "I found your approximate location.",
    text: "I found your approximate location.",
  });
});

test("describes a running search conversationally", () => {
  expect(
    getToolActivityPresentation({
      id: "call_search",
      name: "web_search",
      input: "weather in Venice",
      status: "running",
    }),
  ).toEqual({
    icon: "search",
    label: "I’m looking that up…",
    text: "I’m searching for “weather in Venice”",
  });
});

test("turns search results into a human-readable completion", () => {
  expect(
    getToolActivityPresentation({
      id: "call_search",
      name: "web_search",
      input: "weather in Venice",
      status: "completed",
      summary: "2 results: Venice weather forecast",
    }),
  ).toMatchObject({
    label: "I found the information.",
    text: "I found two results for “weather in Venice”.",
  });
});

test("explains the fallback when a search fails", () => {
  expect(
    getToolActivityPresentation({
      id: "call_search",
      name: "web_search",
      input: "recent benchmark source",
      status: "failed",
      summary: "Search timed out",
    }),
  ).toMatchObject({
    text: "I couldn’t search for “recent benchmark source”.",
    fallback: "I’ll answer from what I know.",
  });
});

test("truncates long search queries", () => {
  const query = "a".repeat(80);

  expect(
    getToolActivityPresentation({
      id: "call_search",
      name: "web_search",
      input: query,
      status: "running",
    }).text,
  ).toBe(`I’m searching for “${"a".repeat(59)}…”`);
});
