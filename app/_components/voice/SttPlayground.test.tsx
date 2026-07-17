import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SttPlayground } from "./SttPlayground";

test("renders the push-to-talk comparison for all three transcription models", () => {
  const markup = renderToStaticMarkup(<SttPlayground />);

  expect(markup).toContain("Hold to speak");
  expect(markup).toContain("Press and hold");
  expect(markup).toContain("Parakeet");
  expect(markup).toContain("Whisper Large v3");
  expect(markup).toContain("Inkling");
  expect(markup).toContain("no VAD, reply model, or TTS involved");
});
