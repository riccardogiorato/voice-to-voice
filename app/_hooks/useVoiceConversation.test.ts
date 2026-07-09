import { expect, test } from "bun:test";
import {
  applyTranscriptFinalToTurns,
  buildTranscriptItems,
  getPhaseAfterLocalSpeechStart,
  getTranscriptPartialFromDelta,
} from "./useVoiceConversation";

test("keeps the visible base transcript when a resumed delta has no displayable text", () => {
  expect(
    getTranscriptPartialFromDelta({
      text: "",
      baseText: "Hey, how are we going to take this?",
    }),
  ).toEqual({
    text: "",
    baseText: "Hey, how are we going to take this?",
  });
});

test("drops non-displayable transcript deltas with no base text", () => {
  expect(getTranscriptPartialFromDelta({ text: "." })).toBeNull();
});

test("updates the current user turn for merged transcript finals", () => {
  expect(
    applyTranscriptFinalToTurns(
      [
        { role: "user", text: "Tell me who won the last World Cup." },
        { role: "assistant", text: "Argentina won in 2022." },
        { role: "user", text: "Wait" },
      ],
      {
        text: "Wait, are you sure?",
        merged: true,
      },
    ),
  ).toEqual([
    { role: "user", text: "Tell me who won the last World Cup." },
    { role: "assistant", text: "Argentina won in 2022." },
    { role: "user", text: "Wait, are you sure?", settled: false },
  ]);
});

test("does not rewrite older user turns across an assistant turn", () => {
  expect(
    applyTranscriptFinalToTurns(
      [
        { role: "user", text: "Tell me who won the last World Cup." },
        { role: "assistant", text: "Argentina won in 2022." },
        { role: "user", text: "Wait" },
        { role: "assistant", text: "Let me correct that." },
      ],
      {
        text: "Wait, are you sure?",
        merged: true,
      },
    ),
  ).toEqual([
    { role: "user", text: "Tell me who won the last World Cup." },
    { role: "assistant", text: "Argentina won in 2022." },
    { role: "user", text: "Wait" },
    { role: "assistant", text: "Let me correct that." },
    { role: "user", text: "Wait, are you sure?", settled: false },
  ]);
});

test("live partials append instead of rewriting older user turns across an assistant turn", () => {
  expect(
    buildTranscriptItems({
      turns: [
        { role: "user", text: "Wait" },
        { role: "assistant", text: "Let me correct that." },
      ],
      partial: { baseText: "Wait", text: "are you sure?" },
      assistantDraft: "",
    }),
  ).toEqual([
    { role: "user", text: "Wait" },
    { role: "assistant", text: "Let me correct that." },
    { role: "user", text: "Wait are you sure?", live: true },
  ]);
});

test("local speech start exits thinking so the thinking sound stops immediately", () => {
  expect(getPhaseAfterLocalSpeechStart("thinking")).toBe("listening");
  expect(getPhaseAfterLocalSpeechStart("listening")).toBe("listening");
  expect(getPhaseAfterLocalSpeechStart("speaking")).toBe("speaking");
});
