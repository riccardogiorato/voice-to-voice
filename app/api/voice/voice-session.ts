import WebSocket from "ws";
import {
  CHAT_MODEL,
  cleanTranscript,
  compactErrorBody,
  decodeFloat32,
  floatTo16BitPcm,
  isGhostTranscript,
  mergeTranscriptText,
  normalizeTranscript,
  parseJson,
  REPLY_GRACE_MS,
  resample,
  shouldFlushFirstTtsChunk,
  STT_MODELS,
  streamTogetherText,
  systemPrompt,
  TRANSCRIPT_MERGE_WINDOW_MS,
  TRANSCRIPT_REPAIR_MODEL,
  TRANSCRIPT_REPAIR_TIMEOUT_MS,
  transcriptRepairPrompt,
  TTS_MODELS,
} from "./voice-utils";
import type { ChatMessage, ClientEvent } from "./voice-utils";

export class VoiceSession {
  private stt?: WebSocket;
  private tts?: WebSocket;
  private chatAbort?: AbortController;
  private history: ChatMessage[] = [];
  private turnCount = 0;
  private ttsContextId = "turn-0";
  private ttsReady = false;
  private pendingSpeech: string[] = [];
  private pendingCommit = false;
  private stopped = false;
  private lastTranscript = "";
  private lastTranscriptAt = 0;
  private keepaliveTimer?: NodeJS.Timeout;
  private expiryTimer?: NodeJS.Timeout;
  private sttReconnects = 0;
  private ttsReconnects = 0;
  private sttModelIndex = 0;
  private ttsModelIndex = 0;
  private sttFallbackPending = false;
  private ttsFallbackPending = false;
  private lastUserTranscript = "";
  private lastUserFinalAt = 0;
  private answerTimer?: NodeJS.Timeout;
  private repairAbort?: AbortController;
  private pendingTranscriptId = 0;
  private userSpeechActive = false;
  private speechIdleTimer?: NodeJS.Timeout;
  private awaitingCommittedTranscript = false;
  private deferredAnswer?: { rawTranscript: string; merged: boolean };
  private lastRawTranscript = "";
  private lastRepairedTranscript = "";

  constructor(private client: WebSocket) {}

  start() {
    this.client.on("message", (data) => this.handleClientMessage(data));
    this.client.on("close", () => this.close());
    this.client.on("error", () => this.close());

    if (!process.env.TOGETHER_API_KEY) {
      this.send("error", { message: "Missing TOGETHER_API_KEY on the server." });
      this.client.close();
      return;
    }

    this.keepaliveTimer = setInterval(() => {
      if (this.stt?.readyState === WebSocket.OPEN) this.stt.ping();
      if (this.tts?.readyState === WebSocket.OPEN) this.tts.ping();
    }, 15_000);

    // End 20s before Vercel's maxDuration (300s) hard-kills the function, so
    // the client hears why instead of a silent drop.
    this.expiryTimer = setTimeout(() => {
      this.send("error", {
        message: "Call time limit reached. Start a new call when you're ready.",
      });
      this.send("state", { state: "idle" });
      this.close();
    }, 280_000);

    this.connectStt();
    this.connectTts();
    this.send("state", { state: "connecting" });
  }

  private connectStt() {
    const model = STT_MODELS[this.sttModelIndex] ?? STT_MODELS[0];
    const url = new URL("wss://api.together.ai/v1/realtime");
    url.searchParams.set("intent", "transcription");
    url.searchParams.set("model", model);
    url.searchParams.set("input_audio_format", "pcm_s16le_16000");
    url.searchParams.set("turn_detection", "none");
    url.searchParams.set("max_speech_duration_s", "8");

    this.stt = new WebSocket(url.toString(), {
      headers: { Authorization: `Bearer ${process.env.TOGETHER_API_KEY}` },
    });

    this.stt.on("open", () => this.send("state", { state: "listening" }));
    this.stt.on("message", (data) => this.handleSttMessage(data));
    this.stt.on("error", () => {});
    this.stt.on("close", () => {
      if (this.stopped) return;
      if (this.sttFallbackPending) return;
      if (this.fallbackStt("Speech service disconnected.")) return;
      if (this.sttReconnects >= 2) {
        this.send("error", { message: "Speech service disconnected." });
        return;
      }
      this.sttReconnects += 1;
      setTimeout(() => {
        if (!this.stopped) this.connectStt();
      }, 500);
    });
  }

  private connectTts() {
    const config = TTS_MODELS[this.ttsModelIndex] ?? TTS_MODELS[0];
    const url = new URL("wss://api.together.ai/v1/audio/speech/websocket");
    url.searchParams.set("model", config.model);
    url.searchParams.set("voice", config.voice);
    url.searchParams.set("response_format", "pcm");
    url.searchParams.set("sample_rate", "24000");
    url.searchParams.set("segment", "immediate");
    url.searchParams.set("max_partial_length", "80");

    this.tts = new WebSocket(url.toString(), {
      headers: { Authorization: `Bearer ${process.env.TOGETHER_API_KEY}` },
    });

    this.tts.on("message", (data) => this.handleTtsMessage(data));
    this.tts.on("error", () => {});
    this.tts.on("close", () => {
      if (this.stopped) return;
      this.ttsReady = false;
      if (this.ttsFallbackPending) return;
      if (this.fallbackTts("Voice service disconnected.")) return;
      if (this.ttsReconnects >= 2) {
        this.send("error", { message: "Voice service disconnected." });
        return;
      }
      this.ttsReconnects += 1;
      setTimeout(() => {
        if (!this.stopped) this.connectTts();
      }, 500);
    });
  }

  private handleClientMessage(data: WebSocket.RawData) {
    let event: ClientEvent;
    try {
      event = JSON.parse(data.toString()) as ClientEvent;
    } catch {
      return;
    }

    if (event.type === "conversation.start") {
      this.seedHistory(event.history);
      return;
    }

    if (event.type === "conversation.reset") {
      this.cancelResponse();
      this.history = [];
      this.lastUserTranscript = "";
      this.lastUserFinalAt = 0;
      this.userSpeechActive = false;
      this.awaitingCommittedTranscript = false;
      this.deferredAnswer = undefined;
      clearTimeout(this.speechIdleTimer);
      this.lastRawTranscript = "";
      this.lastRepairedTranscript = "";
      this.send("state", { state: "listening" });
      return;
    }

    if (event.type === "conversation.stop") {
      this.close();
      return;
    }

    if (event.type === "response.cancel") {
      this.cancelResponse();
      this.send("state", { state: "listening" });
      return;
    }

    if (event.type === "speech.started") {
      this.userSpeechActive = true;
      this.pausePendingAnswer();
      this.refreshSpeechIdleTimer();
      return;
    }

    if (event.type === "audio.commit") {
      this.userSpeechActive = false;
      this.awaitingCommittedTranscript = true;
      clearTimeout(this.speechIdleTimer);
      this.commitAudio();
      return;
    }

    if (event.type === "audio.input") {
      if (this.userSpeechActive) this.refreshSpeechIdleTimer();
      this.forwardAudio(event.audio, event.sampleRate);
    }
  }

  private handleSttMessage(data: WebSocket.RawData) {
    const message = parseJson(data);
    if (!message) return;

    if (message.type === "conversation.item.input_audio_transcription.delta") {
      const delta = String(message.delta ?? "");
      const mergeBase = this.getPendingMergeBase();
      this.send("transcript.delta", {
        text: normalizeTranscript(delta) ? delta : "",
        ...(mergeBase ? { baseText: mergeBase, merged: true } : {}),
      });
      return;
    }

    if (message.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = cleanTranscript(String(message.transcript ?? ""));
      if (transcript.length === 0 || isGhostTranscript(transcript)) {
        this.awaitingCommittedTranscript = false;
        this.send("transcript.ignored", { text: transcript });
        this.scheduleDeferredAnswerIfIdle();
        return;
      }

      this.awaitingCommittedTranscript = false;
      if (this.isDuplicateTranscript(transcript)) {
        this.scheduleDeferredAnswerIfIdle();
        return;
      }

      const now = Date.now();
      const shouldMerge =
        this.lastUserTranscript.length > 0 &&
        now - this.lastUserFinalAt < TRANSCRIPT_MERGE_WINDOW_MS;
      const finalTranscript = shouldMerge
        ? mergeTranscriptText(this.lastUserTranscript, transcript)
        : transcript;

      if (shouldMerge) this.retractLastTurnForMerge();

      this.lastUserTranscript = finalTranscript;
      this.lastUserFinalAt = now;
      this.scheduleAnswer(finalTranscript, shouldMerge);
      return;
    }

    if (message.type === "conversation.item.input_audio_transcription.failed") {
      this.awaitingCommittedTranscript = false;
      this.scheduleDeferredAnswerIfIdle();
      this.send("error", {
        message: message.error?.message ?? "Transcription failed.",
      });
    }
  }

  private handleTtsMessage(data: WebSocket.RawData) {
    const message = parseJson(data);
    if (!message) return;

    if (message.type === "session.created") {
      this.ttsReady = true;
      this.flushSpeech();
      return;
    }

    // Audio from a cancelled turn's context can still arrive after
    // context.cancel; drop anything not belonging to the current turn.
    if (message.context_id && message.context_id !== this.ttsContextId) {
      return;
    }

    if (message.type === "conversation.item.audio_output.delta") {
      this.send("audio.delta", { audio: message.delta, sampleRate: 24000 });
      return;
    }

    if (message.type === "conversation.item.audio_output.done") {
      this.send("audio.done", {});
      return;
    }

    if (message.type === "conversation.item.tts.failed") {
      if (this.fallbackTts("Voice generation failed.")) return;
      this.send("error", { message: message.error?.message ?? "TTS failed." });
      this.send("state", { state: "listening" });
    }
  }

  private fallbackStt(reason: string) {
    if (this.sttModelIndex >= STT_MODELS.length - 1) return false;

    this.sttModelIndex += 1;
    this.sttReconnects = 0;
    this.sttFallbackPending = true;
    const model = STT_MODELS[this.sttModelIndex];
    this.send("error", { message: `${reason} Falling back to ${model}.` });

    try {
      this.stt?.close();
    } catch {}

    setTimeout(() => {
      this.sttFallbackPending = false;
      if (!this.stopped) this.connectStt();
    }, 250);
    return true;
  }

  private fallbackTts(reason: string) {
    if (this.ttsModelIndex >= TTS_MODELS.length - 1) return false;

    this.ttsModelIndex += 1;
    this.ttsReconnects = 0;
    this.ttsReady = false;
    this.ttsFallbackPending = true;
    const config = TTS_MODELS[this.ttsModelIndex];
    this.send("error", {
      message: `${reason} Falling back to ${config.model}.`,
    });

    try {
      this.tts?.close();
    } catch {}

    setTimeout(() => {
      this.ttsFallbackPending = false;
      if (!this.stopped) this.connectTts();
    }, 250);
    return true;
  }

  private forwardAudio(base64Float32: string, sampleRate: number) {
    if (!this.stt || this.stt.readyState !== WebSocket.OPEN) return;

    const float32 = decodeFloat32(base64Float32);
    const pcm16 = floatTo16BitPcm(resample(float32, sampleRate, 16_000));
    this.stt.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength).toString(
          "base64",
        ),
      }),
    );
  }

  private commitAudio() {
    if (!this.stt || this.stt.readyState !== WebSocket.OPEN) return;
    this.stt.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  }

  private async answer(transcript: string) {
    this.cancelAssistantOutput();
    this.send("state", { state: "thinking" });

    this.turnCount += 1;
    this.ttsContextId = `turn-${this.turnCount}`;

    this.history.push({ role: "user", content: transcript });
    this.trimHistory();

    const chatMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...this.history,
    ];

    const controller = new AbortController();
    this.chatAbort = controller;

    let assistant = "";
    let sentence = "";
    let firstSpeechChunkSent = false;

    try {
      const response = await fetch("https://api.together.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.TOGETHER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: CHAT_MODEL,
          messages: chatMessages,
          max_tokens: 120,
          temperature: 0.45,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const errorBody = await response.text().catch(() => "");
        const message = compactErrorBody(errorBody);
        console.error("Together chat failed", {
          status: response.status,
          model: CHAT_MODEL,
          messageCount: chatMessages.length,
          lastUserLength: transcript.length,
          body: message,
        });
        throw new Error(
          `Together chat failed with ${response.status}${message ? `: ${message}` : ""}`,
        );
      }

      this.send("state", { state: "speaking" });

      for await (const delta of streamTogetherText(response.body)) {
        assistant += delta;
        sentence += delta;
        this.send("assistant.delta", { text: delta });

        const shouldSpeak =
          (!firstSpeechChunkSent && shouldFlushFirstTtsChunk(sentence)) ||
          /[.!?]\s$/.test(sentence) ||
          sentence.length > 150;

        if (shouldSpeak) {
          this.speak(sentence);
          firstSpeechChunkSent = true;
          sentence = "";
        }
      }

      if (sentence.trim()) this.speak(sentence);
      this.commitSpeech();

      if (assistant.trim()) {
        this.history.push({ role: "assistant", content: assistant.trim() });
        this.trimHistory();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.send("error", {
          message: error instanceof Error ? error.message : "Chat failed.",
        });
        this.send("state", { state: "listening" });
      }
    }
  }

  private trimHistory() {
    if (this.history.length > 8) this.history = this.history.slice(-8);
  }

  private scheduleAnswer(rawTranscript: string, merged: boolean) {
    this.deferredAnswer = { rawTranscript, merged };
    this.scheduleDeferredAnswerIfIdle();
  }

  private scheduleDeferredAnswerIfIdle() {
    if (!this.deferredAnswer) return;
    if (this.userSpeechActive || this.awaitingCommittedTranscript) return;

    const { rawTranscript, merged } = this.deferredAnswer;
    clearTimeout(this.answerTimer);
    this.repairAbort?.abort();
    this.repairAbort = undefined;
    const transcriptId = ++this.pendingTranscriptId;

    this.answerTimer = setTimeout(() => {
      this.answerTimer = undefined;
      this.deferredAnswer = undefined;
      if (!this.stopped) {
        void this.settleTranscriptAndAnswer(rawTranscript, merged, transcriptId);
      }
    }, REPLY_GRACE_MS);
  }

  private async settleTranscriptAndAnswer(
    rawTranscript: string,
    merged: boolean,
    transcriptId: number,
  ) {
    const controller = new AbortController();
    this.repairAbort = controller;
    const timeout = setTimeout(
      () => controller.abort(),
      TRANSCRIPT_REPAIR_TIMEOUT_MS,
    );

    let repairedTranscript = rawTranscript;
    try {
      repairedTranscript = await this.repairTranscript(rawTranscript, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error("Together transcript repair failed", {
          model: TRANSCRIPT_REPAIR_MODEL,
          rawLength: rawTranscript.length,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      clearTimeout(timeout);
      if (this.repairAbort === controller) this.repairAbort = undefined;
    }

    if (this.stopped || transcriptId !== this.pendingTranscriptId) return;

    this.lastRawTranscript = rawTranscript;
    this.lastRepairedTranscript = repairedTranscript;
    this.lastUserTranscript = repairedTranscript;
    this.lastUserFinalAt = Date.now();
    this.send("transcript.final", {
      text: repairedTranscript,
      merged,
      repaired:
        normalizeTranscript(repairedTranscript) !== normalizeTranscript(rawTranscript),
    });
    await this.answer(repairedTranscript);
  }

  private async repairTranscript(rawTranscript: string, signal: AbortSignal) {
    if (shouldPreserveTranscript(rawTranscript)) return rawTranscript;

    const response = await fetch("https://api.together.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TOGETHER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TRANSCRIPT_REPAIR_MODEL,
        messages: [
          { role: "system", content: transcriptRepairPrompt },
          { role: "user", content: rawTranscript },
        ],
        max_tokens: 96,
        temperature: 0,
        stream: true,
        reasoning: { enabled: false },
        reasoning_effort: "low",
        chat_template_kwargs: {
          enable_thinking: false,
          thinking: false,
        },
      }),
      signal,
    });

    if (!response.ok || !response.body) {
      const errorBody = await response.text().catch(() => "");
      const message = compactErrorBody(errorBody);
      throw new Error(
        `Together repair failed with ${response.status}${message ? `: ${message}` : ""}`,
      );
    }

    let output = "";
    for await (const delta of streamTogetherText(response.body)) {
      output += delta;
    }

    const repairedTranscript = cleanRepairOutput(output);
    if (isUnsafeRepair(rawTranscript, repairedTranscript)) return rawTranscript;
    return repairedTranscript;
  }

  private retractLastTurnForMerge() {
    if (this.history.at(-1)?.role === "assistant") this.history.pop();
    if (this.history.at(-1)?.role === "user") this.history.pop();
  }

  private getPendingMergeBase() {
    if (!this.lastUserTranscript) return "";
    if (Date.now() - this.lastUserFinalAt >= TRANSCRIPT_MERGE_WINDOW_MS) return "";
    return this.lastUserTranscript;
  }

  // Sessions are per-connection, so a stop/expiry/reconnect would otherwise
  // wipe the assistant's memory while the client still shows the transcript.
  // The client re-seeds prior turns on conversation.start.
  private seedHistory(turns?: { role: string; text: string }[]) {
    if (!Array.isArray(turns) || this.history.length > 0) return;

    this.history = turns
      .filter(
        (turn) =>
          (turn?.role === "user" || turn?.role === "assistant") &&
          typeof turn.text === "string" &&
          turn.text.trim().length > 0,
      )
      .map((turn) => ({
        role: turn.role as "user" | "assistant",
        content: turn.text.trim().slice(0, 800),
      }));
    this.trimHistory();
  }

  private speak(text: string) {
    if (!this.ttsReady || !this.tts || this.tts.readyState !== WebSocket.OPEN) {
      this.pendingSpeech.push(text);
      return;
    }

    this.tts.send(
      JSON.stringify({
        type: "input_text_buffer.append",
        text,
        context_id: this.ttsContextId,
      }),
    );
  }

  private commitSpeech() {
    if (!this.ttsReady || !this.tts || this.tts.readyState !== WebSocket.OPEN) {
      this.pendingCommit = true;
      return;
    }

    this.tts.send(
      JSON.stringify({
        type: "input_text_buffer.commit",
        context_id: this.ttsContextId,
      }),
    );
  }

  private flushSpeech() {
    const pending = this.pendingSpeech;
    this.pendingSpeech = [];
    pending.forEach((text) => this.speak(text));

    if (this.pendingCommit) {
      this.pendingCommit = false;
      this.commitSpeech();
    }
  }

  private cancelResponse() {
    this.cancelPendingAnswer(false);
    this.awaitingCommittedTranscript = false;
    this.userSpeechActive = false;
    clearTimeout(this.speechIdleTimer);
    this.cancelAssistantOutput();
  }

  private pausePendingAnswer() {
    this.cancelPendingAnswer(true);
  }

  private cancelPendingAnswer(keepDeferredAnswer: boolean) {
    clearTimeout(this.answerTimer);
    this.answerTimer = undefined;
    this.pendingTranscriptId += 1;
    this.repairAbort?.abort();
    this.repairAbort = undefined;
    if (!keepDeferredAnswer) this.deferredAnswer = undefined;
  }

  private refreshSpeechIdleTimer() {
    clearTimeout(this.speechIdleTimer);
    this.speechIdleTimer = setTimeout(() => {
      this.userSpeechActive = false;
      this.scheduleDeferredAnswerIfIdle();
    }, 1500);
  }

  private cancelAssistantOutput() {
    this.chatAbort?.abort();
    this.chatAbort = undefined;
    this.pendingSpeech = [];
    this.pendingCommit = false;

    if (this.tts && this.tts.readyState === WebSocket.OPEN) {
      this.tts.send(JSON.stringify({ type: "context.cancel", context_id: this.ttsContextId }));
    }

    // Retire the context id so in-flight deltas from the cancelled turn are
    // dropped by the handleTtsMessage filter instead of reaching the client.
    this.ttsContextId = `turn-${this.turnCount}-cancelled`;

    this.send("audio.clear", {});
  }

  private send(type: string, payload: Record<string, unknown>) {
    if (this.stopped || this.client.readyState !== WebSocket.OPEN) return;
    this.client.send(JSON.stringify({ type, ...payload }));
  }

  private isDuplicateTranscript(transcript: string) {
    const normalized = normalizeTranscript(transcript);
    const now = Date.now();
    const duplicate =
      normalized === this.lastTranscript && now - this.lastTranscriptAt < 3000;

    this.lastTranscript = normalized;
    this.lastTranscriptAt = now;

    return duplicate;
  }

  private close() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.keepaliveTimer);
    clearTimeout(this.expiryTimer);
    clearTimeout(this.answerTimer);
    clearTimeout(this.speechIdleTimer);
    this.repairAbort?.abort();
    this.chatAbort?.abort();
    this.stt?.close();
    this.tts?.close();
    if (this.client.readyState === WebSocket.OPEN) this.client.close();
  }
}

function cleanRepairOutput(output: string) {
  return cleanTranscript(
    output
      .replace(/<think>[\s\S]*?<\/think>/giu, "")
      .replace(/^\s*(?:repaired transcript|transcript|output)\s*:\s*/iu, "")
      .replace(/^["'`]+|["'`]+$/gu, "")
      .trim(),
  );
}

function shouldPreserveTranscript(transcript: string) {
  const normalized = normalizeTranscript(transcript);
  return SHORT_COMMAND_TRANSCRIPTS.has(normalized);
}

function isUnsafeRepair(rawTranscript: string, repairedTranscript: string) {
  const normalizedRaw = normalizeTranscript(rawTranscript);
  const normalizedRepaired = normalizeTranscript(repairedTranscript);
  if (!normalizedRepaired) return true;
  if (SHORT_COMMAND_TRANSCRIPTS.has(normalizedRaw)) {
    return normalizedRepaired !== normalizedRaw;
  }

  const maxLength = Math.max(rawTranscript.length * 3, rawTranscript.length + 120);
  if (repairedTranscript.length > maxLength) return true;

  return ANSWER_LIKE_REPAIR_PREFIXES.some((prefix) =>
    normalizedRepaired.startsWith(prefix),
  );
}

const SHORT_COMMAND_TRANSCRIPTS = new Set([
  "yes",
  "yeah",
  "no",
  "nope",
  "stop",
  "cancel",
  "reset",
  "mute",
  "unmute",
]);

const ANSWER_LIKE_REPAIR_PREFIXES = [
  "sure",
  "i can",
  "i will",
  "here is",
  "here are",
  "the answer",
];
