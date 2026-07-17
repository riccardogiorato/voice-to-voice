import { afterEach, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { VoiceSession } from "./voice-session";
import { REPLY_GRACE_INCOMPLETE_MS, ttsVoiceForLanguage } from "./voice-utils";

const originalTogetherKey = process.env.TOGETHER_API_KEY;

afterEach(() => {
  process.env.TOGETHER_API_KEY = originalTogetherKey;
});

test("keeps a pending user utterance when speech resumes before reply grace expires", async () => {
  process.env.TOGETHER_API_KEY = "test-key";
  const client = new FakeClientSocket();
  const session = new VoiceSession(client as any);
  const scheduled: Array<{ rawTranscript: string; merged: boolean }> = [];

  (session as any).startTurn = (
    rawTranscript: string,
    merged: boolean,
    _transcriptId: number,
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

  await delay(REPLY_GRACE_INCOMPLETE_MS + 50);

  expect(scheduled).toEqual([
    {
      rawTranscript: "hello how are you doing check the weather in venice",
      merged: true,
    },
  ]);
});

test("waits for all split speech commits before answering", async () => {
  process.env.TOGETHER_API_KEY = "test-key";
  const client = new FakeClientSocket();
  const session = new VoiceSession(client as any);
  const scheduled: Array<{ rawTranscript: string; merged: boolean }> = [];

  (session as any).startTurn = (
    rawTranscript: string,
    merged: boolean,
    _transcriptId: number,
  ) => {
    scheduled.push({ rawTranscript, merged });
  };

  (session as any).handleClientMessage(rawMessage({ type: "speech.started" }));
  (session as any).handleClientMessage(rawMessage({ type: "audio.commit" }));
  (session as any).handleClientMessage(rawMessage({ type: "speech.started" }));
  (session as any).handleClientMessage(rawMessage({ type: "audio.commit" }));
  (session as any).handleSttMessage(
    rawMessage({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "what were the World Cup matches",
    }),
  );

  await delay(REPLY_GRACE_INCOMPLETE_MS + 50);

  expect(scheduled).toEqual([]);

  (session as any).handleSttMessage(
    rawMessage({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "yesterday or last month",
    }),
  );

  await delay(REPLY_GRACE_INCOMPLETE_MS + 50);

  expect(scheduled).toEqual([
    {
      rawTranscript: "what were the World Cup matches yesterday or last month",
      merged: true,
    },
  ]);
});

test("ignores low-intent filler transcripts from background noise", async () => {
  process.env.TOGETHER_API_KEY = "test-key";
  const client = new FakeClientSocket();
  const session = new VoiceSession(client as any);
  const scheduled: Array<{ rawTranscript: string; merged: boolean }> = [];

  (session as any).startTurn = (
    rawTranscript: string,
    merged: boolean,
    _transcriptId: number,
  ) => {
    scheduled.push({ rawTranscript, merged });
  };

  for (const transcript of ["Mm-hmm.", "Okay Mm-hmm I don't know.", "Sh"]) {
    (session as any).handleClientMessage(rawMessage({ type: "speech.started" }));
    (session as any).handleClientMessage(rawMessage({ type: "audio.commit" }));
    (session as any).handleSttMessage(
      rawMessage({
        type: "conversation.item.input_audio_transcription.completed",
        transcript,
      }),
    );
  }

  await delay(REPLY_GRACE_INCOMPLETE_MS + 50);

  expect(scheduled).toEqual([]);
  expect(client.sent).toContainEqual({
    type: "transcript.ignored",
    text: "Mm-hmm.",
  });
  expect(client.sent).toContainEqual({
    type: "transcript.ignored",
    text: "Okay Mm-hmm I don't know.",
  });
  expect(client.sent).toContainEqual({
    type: "transcript.ignored",
    text: "Sh",
  });
});

test("reports listening when user speech starts during a pending answer", () => {
  process.env.TOGETHER_API_KEY = "test-key";
  const client = new FakeClientSocket();
  const session = new VoiceSession(client as any);

  (session as any).handleClientMessage(rawMessage({ type: "speech.started" }));

  expect(client.sent).toContainEqual({ type: "state", state: "listening" });
});

test("buffers one browser VAD turn for the Inkling audio request", async () => {
  process.env.TOGETHER_API_KEY = "test-key";
  const client = new FakeClientSocket();
  const session = new VoiceSession(client as any, {}, "inkling");
  const captured: number[][] = [];

  (session as any).runInklingTurn = () => {
    captured.push(
      (session as any).inklingPcmChunks.flatMap((chunk: Uint8Array) => [
        ...chunk,
      ]),
    );
  };

  (session as any).handleClientMessage(rawMessage({ type: "speech.started" }));
  (session as any).handleClientMessage(
    rawMessage({
      type: "audio.input",
      audio: Buffer.from([1, 0, 2, 0]).toString("base64"),
      sampleRate: 16_000,
      format: "pcm_s16le",
    }),
  );
  (session as any).handleClientMessage(rawMessage({ type: "audio.commit" }));

  await delay(350);

  expect(captured).toEqual([[1, 0, 2, 0]]);
});

test("recovers to listening when TTS never sends audio done", async () => {
  const client = new FakeClientSocket();
  const session = new VoiceSession(client as any);

  (session as any).ttsContextId = "turn-stalled";
  (session as any).tts = new FakeTtsSocket();
  (session as any).scheduleTtsDoneWatchdog(10, "turn-stalled");

  await delay(25);

  expect(client.sent).toContainEqual({ type: "audio.done" });
  expect(client.sent).toContainEqual({ type: "state", state: "listening" });
});

test("closes the client socket with diagnostic code and reason", () => {
  const client = new FakeClientSocket();
  const session = new VoiceSession(client as any);

  (session as any).close("client message handler failed", 1011);

  expect(client.closeCode).toBe(1011);
  expect(client.closeReason).toBe("client message handler failed");
});

test("selects a native voice for the active TTS model and language", () => {
  expect(
    ttsVoiceForLanguage({ model: "cartesia/sonic-3", voice: "nonfiction man" }, "it"),
  ).toBe("italian calm man");
  expect(
    ttsVoiceForLanguage({ model: "hexgrad/Kokoro-82M", voice: "af_heart" }, "it"),
  ).toBe("im_nicola");
});

test("updates language and voice before queued speech is flushed", () => {
  const client = new FakeClientSocket();
  const session = new VoiceSession(client as any);
  const tts = new FakeTtsSocket();

  (session as any).tts = tts;
  (session as any).setTtsLanguage("it");
  (session as any).speak("Certo, posso aiutarti.");
  (session as any).handleTtsMessage(rawMessage({ type: "session.created" }));

  expect(tts.sent[0]).toEqual({
    type: "tts_session.updated",
    context_id: "turn-0",
    session: { language: "it", voice: "italian calm man" },
  });
  expect(tts.sent[1]).toEqual({
    type: "input_text_buffer.append",
    text: "Certo, posso aiutarti.",
    context_id: "turn-0",
  });
});

test("updates the same TTS context that receives the assistant text", () => {
  const session = new VoiceSession(new FakeClientSocket() as any);
  const tts = new FakeTtsSocket();

  (session as any).tts = tts;
  (session as any).ttsReady = true;
  (session as any).ttsContextId = "turn-1";
  (session as any).setTtsLanguage("it");
  (session as any).speak("Ciao! Sto bene, grazie.");

  expect(tts.sent).toEqual([
    {
      type: "tts_session.updated",
      context_id: "turn-1",
      session: { language: "it", voice: "italian calm man" },
    },
    {
      type: "input_text_buffer.append",
      text: "Ciao! Sto bene, grazie.",
      context_id: "turn-1",
    },
  ]);
});

test("reapplies the same language and voice to each new TTS context", () => {
  const session = new VoiceSession(new FakeClientSocket() as any);
  const tts = new FakeTtsSocket();

  (session as any).tts = tts;
  (session as any).ttsReady = true;
  (session as any).ttsLanguage = "it";
  (session as any).ttsContextId = "turn-3";
  (session as any).setTtsLanguage("it");

  expect(tts.sent).toEqual([
    {
      type: "tts_session.updated",
      context_id: "turn-3",
      session: { language: "it", voice: "italian calm man" },
    },
  ]);
});

class FakeClientSocket {
  readyState = 1;
  sent: unknown[] = [];
  closeCode?: number;
  closeReason?: string;

  on() {}

  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  }

  close(code?: number, reason?: string) {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
  }
}

class FakeTtsSocket {
  readyState = 1;
  sent: unknown[] = [];

  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  }
}

function rawMessage(value: unknown) {
  return Buffer.from(JSON.stringify(value));
}
