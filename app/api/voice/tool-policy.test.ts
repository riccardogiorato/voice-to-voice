import { expect, test } from "bun:test";
import { planVoiceToolForTranscript } from "./tool-policy";

const NOW = new Date("2026-07-17T15:39:00Z");

test("routes current sports requests to web search", () => {
  expect(
    planVoiceToolForTranscript(
      "Can you tell me what are the latest matches from the World Cup?",
      NOW,
    ),
  ).toEqual({
    name: "web_search",
    arguments: {
      query: "Can you tell me what are the latest matches from the World Cup 2026",
      num_results: 3,
    },
  });
});

test("does not call tools for identity or casual requests", () => {
  expect(planVoiceToolForTranscript("What's your name?", NOW)).toBeNull();
  expect(planVoiceToolForTranscript("Tell me a short joke.", NOW)).toBeNull();
  expect(planVoiceToolForTranscript("Hello! How are you doing today?", NOW)).toBeNull();
  expect(
    planVoiceToolForTranscript(
      "I would like to reserve a table for two people tonight.",
      NOW,
    ),
  ).toBeNull();
});

test("keeps time and location requests on their dedicated tools", () => {
  expect(planVoiceToolForTranscript("What time is it?", NOW)).toEqual({
    name: "get_current_time",
    arguments: {},
  });
  expect(planVoiceToolForTranscript("Where am I?", NOW)).toEqual({
    name: "get_user_location",
    arguments: {},
  });
});

test("searches generic factual questions that explicitly require current data", () => {
  expect(
    planVoiceToolForTranscript(
      "What is the fastest open source language model right now?",
      NOW,
    )?.name,
  ).toBe("web_search");
});
