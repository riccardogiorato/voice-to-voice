import { expect, test } from "bun:test";
import {
  appendSpokenWordText,
  applyTranscriptFinalToTurns,
  buildSpokenTextAtTime,
  buildTranscriptItems,
  detectBargeInSpeech,
  detectOpenSpeech,
  getPhaseAfterLocalSpeechStart,
  getTranscriptPartialFromDelta,
  mergeAssistantWordTimings,
  shouldKeepSpeechOpen,
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

test("detects barge-in using TEN VAD only", () => {
  expect(detectBargeInSpeech({ vadProbability: 0.76 })).toBe(true);
  expect(detectBargeInSpeech({ vadProbability: null })).toBe(false);
  expect(detectBargeInSpeech({ vadProbability: 0.7 })).toBe(false);
});

test("opens speech using TEN VAD only", () => {
  expect(
    detectOpenSpeech({
      vadSpeech: null,
    }),
  ).toBe(false);

  expect(
    detectOpenSpeech({
      vadSpeech: false,
    }),
  ).toBe(false);

  expect(
    detectOpenSpeech({
      vadSpeech: true,
    }),
  ).toBe(true);
});

test("keeps speech open through a short hesitation", () => {
  expect(
    shouldKeepSpeechOpen({
      now: 1_360,
      lastSpeechAt: 1_000,
    }),
  ).toBe(true);
});

test("appends spoken words without fabricating unspoken text", () => {
  expect(appendSpokenWordText("", "Once")).toBe("Once");
  expect(appendSpokenWordText("Once upon", "a")).toBe("Once upon a");
  expect(appendSpokenWordText("Once upon", " ")).toBe("Once upon");
});

test("builds spoken text from the live playback clock", () => {
  expect(
    buildSpokenTextAtTime(
      [
        {
          startedAt: 10,
          timings: [
            { word: "Once", startSeconds: 0, endSeconds: 0.2 },
            { word: "upon", startSeconds: 0.4, endSeconds: 0.6 },
            { word: "time", startSeconds: 0.8, endSeconds: 1 },
          ],
        },
      ],
      10.5,
      0,
    ),
  ).toBe("Once upon");
});

test("merges repeated word timestamp batches for the same TTS item", () => {
  expect(
    mergeAssistantWordTimings(
      [
        { word: "total", startSeconds: 0.03, endSeconds: 0.44 },
        { word: "episodes", startSeconds: 0.44, endSeconds: 1.05 },
      ],
      [{ word: "2026", startSeconds: 0.01, endSeconds: 0.37 }],
    ),
  ).toEqual([
    { word: "total", startSeconds: 0.03, endSeconds: 0.44 },
    { word: "episodes", startSeconds: 0.44, endSeconds: 1.05 },
    { word: "2026", startSeconds: 1.06, endSeconds: 1.42 },
  ]);
});
