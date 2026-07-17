import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceNotice } from "./Notice";

test("presents an abnormal socket close as a disconnected call", () => {
  const markup = renderToStaticMarkup(
    <VoiceNotice message="Connection lost. Tap the mic to reconnect." />,
  );

  expect(markup).toContain("Call disconnected");
  expect(markup).not.toContain("Something went wrong");
  expect(markup).not.toContain("1006");
});

test("presents the session expiry as a normal call limit", () => {
  const markup = renderToStaticMarkup(
    <VoiceNotice message="Call time limit reached. Start a new call when you're ready." />,
  );

  expect(markup).toContain("Call time reached");
  expect(markup).toContain("Start a new call when you&#x27;re ready.");
  expect(markup).not.toContain("Something went wrong");
});
