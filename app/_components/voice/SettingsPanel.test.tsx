import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceSettingsPanel } from "./SettingsPanel";

test("shows only Inkling while keeping voice output separate", () => {
  const markup = renderToStaticMarkup(<VoiceSettingsPanel />);

  expect(markup).toContain("One model listens and writes the reply.");
  expect(markup).toContain("Listen + reply");
  expect(markup).toContain("Inkling");
  expect(markup).toContain("Sonic 3 / Kokoro");
  expect(markup).not.toContain("Voice pipeline");
  expect(markup).not.toContain("Classic");
  expect(markup).not.toContain("Parakeet / Whisper");
  expect(markup).not.toContain("Nemotron Ultra / MiniMax M2.7");
  expect(markup).toContain("Debug");
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).not.toContain("Copy session log");
});
