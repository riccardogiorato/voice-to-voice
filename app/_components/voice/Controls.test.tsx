import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceEndedControls } from "./Controls";

test("shows distinct resume and new-chat actions after a call ends", () => {
  const markup = renderToStaticMarkup(<VoiceEndedControls />);

  expect(markup).toContain("Resume chat");
  expect(markup).toContain("New chat");
  expect(markup).toContain("linear-gradient(145deg");
  expect(markup).not.toContain("New conversation");
});
