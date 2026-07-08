import { expect, test } from "bun:test";
import { getTranscriptPartialFromDelta } from "./useVoiceConversation";

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
