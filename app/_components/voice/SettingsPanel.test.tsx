import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceSettingsPanel } from "./SettingsPanel";

test("shows the classic STT and reply stack", () => {
  const markup = renderToStaticMarkup(
    <VoiceSettingsPanel pipeline="classic" />,
  );

  expect(markup).toContain("Separate speech recognition and reply models.");
  expect(markup).toContain("Parakeet / Whisper");
  expect(markup).toContain("Nemotron Ultra / MiniMax M2.7");
  expect(markup).toContain('aria-pressed="true"');
});

test("shows Inkling as one model while keeping voice output separate", () => {
  const markup = renderToStaticMarkup(
    <VoiceSettingsPanel pipeline="inkling" pipelineDisabled />,
  );

  expect(markup).toContain("One model listens and writes the reply.");
  expect(markup).toContain("Listen + reply");
  expect(markup).toContain("Inkling");
  expect(markup).toContain("Sonic 3 / Kokoro");
  expect(markup).toContain("disabled");
  expect(markup).not.toContain("Nemotron Ultra / MiniMax M2.7");
});
