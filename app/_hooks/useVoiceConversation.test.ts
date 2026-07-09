import { expect, test } from "bun:test";
import {
  appendSpokenWordText,
  buildSocketCloseMessage,
  buildReceivedWordText,
  applyToolActivity,
  applyTranscriptFinalToTurns,
  buildSpokenTextAtTime,
  buildTranscriptItems,
  detectBargeInSpeech,
  detectBufferedSpeech,
  detectOpenSpeech,
  trackBargeInAttempt,
  getPhaseAfterLocalSpeechStart,
  getTranscriptPartialFromDelta,
  mergeAssistantWordTimings,
  selectAssistantDraftText,
  selectCompletedAssistantText,
  shouldKeepSpeechOpen,
} from "./useVoiceConversation";

test("includes websocket close details in the reconnect message", () => {
  expect(
    buildSocketCloseMessage({ code: 1006, reason: "", wasClean: false }),
  ).toBe("Session ended (1006: abnormal close). Tap the mic to reconnect.");

  expect(
    buildSocketCloseMessage({
      code: 1011,
      reason: "client message handler failed",
      wasClean: false,
    }),
  ).toBe(
    "Session ended (1011: client message handler failed). Tap the mic to reconnect.",
  );
});

test("updates tool activity rows by id", () => {
  const running = applyToolActivity([], {
    id: "call_search",
    name: "web_search",
    status: "running",
    input: "weather in Venice",
  });

  expect(
    applyToolActivity(running, {
      id: "call_search",
      name: "web_search",
      status: "completed",
      input: "weather in Venice",
      summary: "1 result: Venice weather",
    }),
  ).toEqual([
    {
      id: "call_search",
      name: "web_search",
      status: "completed",
      input: "weather in Venice",
      summary: "1 result: Venice weather",
    },
  ]);
});

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

test("detects barge-in evidence from VAD confidence or loud mic energy", () => {
  expect(
    detectBargeInSpeech({ level: 0.001, vadProbability: 0.76 }),
  ).toBe(true);
  expect(
    detectBargeInSpeech({ level: 0.04, vadProbability: null }),
  ).toBe(true);
  expect(
    detectBargeInSpeech({ level: 0.001, vadProbability: null }),
  ).toBe(false);
  expect(
    detectBargeInSpeech({ level: 0.001, vadProbability: 0.7 }),
  ).toBe(false);
});

test("confirms barge-in only after sustained evidence", () => {
  expect(
    trackBargeInAttempt({
      hasBargeInSpeech: true,
      startedAt: 1_000,
      lastEvidenceAt: 1_400,
      now: 1_450,
    }).ready,
  ).toBe(false);

  expect(
    trackBargeInAttempt({
      hasBargeInSpeech: true,
      startedAt: 1_000,
      lastEvidenceAt: 1_500,
      now: 1_650,
    }).ready,
  ).toBe(true);
});

test("starts a barge-in attempt on first evidence", () => {
  const attempt = trackBargeInAttempt({
    hasBargeInSpeech: true,
    startedAt: Number.NEGATIVE_INFINITY,
    lastEvidenceAt: Number.NEGATIVE_INFINITY,
    now: 5,
  });

  expect(attempt.startedAt).toBe(5);
  expect(attempt.lastEvidenceAt).toBe(5);
  expect(attempt.ready).toBe(false);
});

test("keeps a barge-in attempt alive through natural speech gaps", () => {
  const heldOpen = trackBargeInAttempt({
    hasBargeInSpeech: false,
    startedAt: 1_000,
    lastEvidenceAt: 1_200,
    now: 1_450,
  });

  expect(heldOpen.startedAt).toBe(1_000);
  expect(heldOpen.ready).toBe(false);

  const reset = trackBargeInAttempt({
    hasBargeInSpeech: false,
    startedAt: 1_000,
    lastEvidenceAt: 1_200,
    now: 1_600,
  });

  expect(reset.startedAt).toBe(Number.NEGATIVE_INFINITY);
  expect(reset.lastEvidenceAt).toBe(Number.NEGATIVE_INFINITY);
  expect(reset.ready).toBe(false);
});

test("never fires while evidence is absent, even inside the grace window", () => {
  expect(
    trackBargeInAttempt({
      hasBargeInSpeech: false,
      startedAt: 1_000,
      lastEvidenceAt: 1_700,
      now: 1_800,
    }).ready,
  ).toBe(false);
});

test("keeps capturing a barge-in utterance after playback is cancelled", () => {
  expect(
    detectBufferedSpeech({
      hasSpeech: false,
      hasBargeInSpeech: true,
      bargeInCaptureActive: true,
    }),
  ).toBe(true);

  expect(
    detectBufferedSpeech({
      hasSpeech: false,
      hasBargeInSpeech: true,
      bargeInCaptureActive: false,
    }),
  ).toBe(false);
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

test("builds text from received TTS words in arrival order", () => {
  expect(
    buildReceivedWordText([
      [
        { word: "Great", startSeconds: 0.2, endSeconds: 0.4 },
        { word: "question!", startSeconds: 0.4, endSeconds: 0.8 },
      ],
      [{ word: "Here", startSeconds: 0.1, endSeconds: 0.3 }],
    ]),
  ).toBe("Great question! Here");
});

test("does not move assistant draft backwards when playback timing lags", () => {
  expect(
    selectAssistantDraftText(
      "Great question! Based on recent updates",
      "Great question! Based",
    ),
  ).toBe("Great question! Based on recent updates");
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

test("anchors reset word timestamp batches to playback progress", () => {
  const merged = mergeAssistantWordTimings(
    [
      { word: "recent", startSeconds: 0.54, endSeconds: 0.83 },
      { word: "months.", startSeconds: 4.76, endSeconds: 5.24 },
    ],
    [
      { word: "Here", startSeconds: 0.15, endSeconds: 0.51 },
      { word: "are", startSeconds: 0.54, endSeconds: 0.69 },
    ],
    2,
  );

  expect(merged.map((timing) => timing.word)).toEqual([
    "recent",
    "months.",
    "Here",
    "are",
  ]);
  expect(merged[2].startSeconds).toBeCloseTo(2);
  expect(merged[2].endSeconds).toBeCloseTo(2.36);
  expect(merged[3].startSeconds).toBeCloseTo(2.39);
  expect(merged[3].endSeconds).toBeCloseTo(2.54);
  expect(merged.slice(0, 2)).toEqual([
    { word: "recent", startSeconds: 0.54, endSeconds: 0.83 },
    { word: "months.", startSeconds: 4.76, endSeconds: 5.24 },
  ]);
});

test("commits the complete generated reply when spoken-word draft lags", () => {
  expect(
    selectCompletedAssistantText(
      "Great question! Based on recent updates, Together AI has released several",
      "Great question! Based on recent updates, Together AI has released several new models over the past several months.",
    ),
  ).toBe(
    "Great question! Based on recent updates, Together AI has released several new models over the past several months.",
  );
});
