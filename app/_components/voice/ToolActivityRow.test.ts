import { expect, test } from "bun:test";
import { getToolActivityPresentation } from "./ToolActivityRow";

test("shows a clock instead of web search for current-time activity", () => {
  expect(
    getToolActivityPresentation({
      id: "call_time",
      name: "get_current_time",
      input: "Europe/Rome",
      status: "completed",
    }),
  ).toEqual({
    icon: "time",
    label: "Checked current time",
    text: "Checked current time: Europe/Rome",
  });
});

test("shows a map pin and approximate wording for user location", () => {
  expect(
    getToolActivityPresentation({
      id: "call_location",
      name: "get_user_location",
      input: "IP-derived location",
      status: "completed",
    }),
  ).toEqual({
    icon: "location",
    label: "Found approximate location",
    text: "Found approximate location",
  });
});

test("keeps the search icon and copy for web search", () => {
  expect(
    getToolActivityPresentation({
      id: "call_search",
      name: "web_search",
      input: "weather in Venice",
      status: "running",
    }),
  ).toEqual({
    icon: "search",
    label: "Searching web",
    text: "Searching web: weather in Venice",
  });
});
