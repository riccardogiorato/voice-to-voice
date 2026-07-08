import { afterEach, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { VoiceSession } from "./voice-session";
import { REPLY_GRACE_MS } from "./voice-utils";

const originalTogetherKey = process.env.TOGETHER_API_KEY;

afterEach(() => {
  process.env.TOGETHER_API_KEY = originalTogetherKey;
});

test("keeps a pending user utterance when speech resumes before reply grace expires", async () => {
  process.env.TOGETHER_API_KEY = "test-key";
  const client = new FakeClientSocket();
  const session = new VoiceSession(client as any);
  const scheduled: Array<{ rawTranscript: string; merged: boolean }> = [];

  (session as any).settleTranscriptAndAnswer = (
    rawTranscript: string,
    merged: boolean,
  ) => {
    scheduled.push({ rawTranscript, merged });
  };

  (session as any).handleSttMessage(
    rawMessage({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "hello how are",
    }),
  );
  (session as any).handleClientMessage(rawMessage({ type: "speech.started" }));
  (session as any).handleClientMessage(rawMessage({ type: "audio.commit" }));
  (session as any).handleSttMessage(
    rawMessage({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "you doing check the weather in venice",
    }),
  );

  await delay(REPLY_GRACE_MS + 50);

  expect(scheduled).toEqual([
    {
      rawTranscript: "hello how are you doing check the weather in venice",
      merged: true,
    },
  ]);
});

class FakeClientSocket {
  readyState = 1;
  sent: unknown[] = [];

  on() {}

  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.readyState = 3;
  }
}

function rawMessage(value: unknown) {
  return Buffer.from(JSON.stringify(value));
}
