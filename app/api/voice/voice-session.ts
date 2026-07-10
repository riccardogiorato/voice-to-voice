import WebSocket from "ws";
import {
  cleanTranscript,
  decodeFloat32,
  floatTo16BitPcm,
  isGhostTranscript,
  mergeTranscriptText,
  normalizeTranscript,
  parseJson,
  REPLY_GRACE_INCOMPLETE_MS,
  REPLY_GRACE_MS,
  resample,
  transcriptLooksComplete,
  shouldFlushFirstTtsChunk,
  STT_MODELS,
  TRANSCRIPT_MERGE_WINDOW_MS,
  TRANSCRIPT_REPAIR_MODEL,
  TRANSCRIPT_REPAIR_TIMEOUT_MS,
  TTS_MODELS,
  ttsVoiceForLanguage,
  wordChangeRatio,
} from "./voice-utils";
import { generateAssistantReply } from "./reply";
import { repairTranscript } from "./transcript-repair";
import type { ToolActivity } from "./reply";
import type { ChatMessage, ClientEvent } from "./voice-utils";

const TTS_DONE_AFTER_COMMIT_MS = 8_000;
const TTS_DONE_AFTER_AUDIO_IDLE_MS = 4_000;
const STT_COMMIT_AWAIT_TIMEOUT_MS = 2_000;
const MAX_CLOSE_REASON_LENGTH = 120;
let nextSessionId = 1;

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
  private pendingTranscriptCompletions = 0;
  private transcriptAwaitTimer?: NodeJS.Timeout;
  private deferredAnswer?: { rawTranscript: string; merged: boolean };
  private answerAudioStarted = false;
  private continuationPending = false;
  private ttsLanguage = "en";
  private lastRawTranscript = "";
  private lastRepairedTranscript = "";
  private ttsDoneWatchdog?: NodeJS.Timeout;
  private readonly sessionId = nextSessionId++;

  constructor(private client: WebSocket) {}

  start() {
    this.log("client.open");
    this.client.on("message", (data) => this.handleClientMessageSafely(data));
    this.client.on("close", (code, reason) => {
      this.log("client.close", { code, reason: reason.toString() });
      this.close("client closed");
    });
    this.client.on("error", (error) => {
      this.logError("client.error", error);
      this.close("client socket error", 1011);
    });

    if (!process.env.TOGETHER_API_KEY) {
      this.send("error", { message: "Missing TOGETHER_API_KEY on the server." });
      this.client.close(1011, "missing server API key");
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
      this.close("call time limit reached", 1000);
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

    this.stt.on("open", () => {
      this.log("stt.open", { model });
      this.send("state", { state: "listening" });
    });
    this.stt.on("message", (data) => this.handleSttMessageSafely(data));
    this.stt.on("error", (error) => {
      this.logError("stt.error", error, { model });
    });
    this.stt.on("close", (code, reason) => {
      this.log("stt.close", { code, reason: reason.toString(), model });
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
    const voice = ttsVoiceForLanguage(config, this.ttsLanguage);
    const url = new URL("wss://api.together.ai/v1/audio/speech/websocket");
    url.searchParams.set("model", config.model);
    url.searchParams.set("voice", voice);
    url.searchParams.set("response_format", "pcm");
    url.searchParams.set("sample_rate", "24000");
    url.searchParams.set("segment", "immediate");
    url.searchParams.set("max_partial_length", "80");
    url.searchParams.set("alignment", "word");
    // Reconnects and fallbacks keep speaking the conversation's language.
    url.searchParams.set("language", this.ttsLanguage);

    this.tts = new WebSocket(url.toString(), {
      headers: { Authorization: `Bearer ${process.env.TOGETHER_API_KEY}` },
    });

    this.tts.on("open", () => {
      this.log("tts.open", { model: config.model, voice, language: this.ttsLanguage });
    });
    this.tts.on("message", (data) => this.handleTtsMessageSafely(data));
    this.tts.on("error", (error) => {
      this.logError("tts.error", error, {
        model: config.model,
        voice,
      });
    });
    this.tts.on("close", (code, reason) => {
      this.log("tts.close", {
        code,
        reason: reason.toString(),
        model: config.model,
        voice,
      });
      if (this.stopped) return;
      this.ttsReady = false;
      if (this.ttsFallbackPending) return;
      if (this.fallbackTts("Voice service disconnected.")) return;
      if (this.ttsReconnects >= 2) {
        this.clearTtsDoneWatchdog();
        this.send("error", { message: "Voice service disconnected." });
        this.send("audio.done", {});
        this.send("state", { state: "listening" });
        return;
      }
      this.ttsReconnects += 1;
      setTimeout(() => {
        if (!this.stopped) this.connectTts();
      }, 500);
    });
  }

  private handleClientMessageSafely(data: WebSocket.RawData) {
    try {
      this.handleClientMessage(data);
    } catch (error) {
      this.failSession("client message handler failed", error);
    }
  }

  private handleSttMessageSafely(data: WebSocket.RawData) {
    try {
      this.handleSttMessage(data);
    } catch (error) {
      this.failSession("STT message handler failed", error);
    }
  }

  private handleTtsMessageSafely(data: WebSocket.RawData) {
    try {
      this.handleTtsMessage(data);
    } catch (error) {
      this.failSession("TTS message handler failed", error);
    }
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
      this.pendingTranscriptCompletions = 0;
      this.continuationPending = false;
      this.deferredAnswer = undefined;
      clearTimeout(this.speechIdleTimer);
      clearTimeout(this.transcriptAwaitTimer);
      this.lastRawTranscript = "";
      this.lastRepairedTranscript = "";
      this.send("state", { state: "listening" });
      return;
    }

    if (event.type === "conversation.stop") {
      this.close("client requested stop", 1000);
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
      this.send("state", { state: "listening" });
      // The user resumed speaking shortly after their last turn, before
      // hearing any reply: void the in-flight answer now and let the
      // upcoming transcript merge into the previous turn. Measured from
      // when speech resumed, not when its transcript arrives.
      if (
        !this.answerAudioStarted &&
        this.lastUserTranscript.length > 0 &&
        Date.now() - this.lastUserFinalAt < TRANSCRIPT_MERGE_WINDOW_MS &&
        !this.continuationPending
      ) {
        this.continuationPending = true;
        this.cancelAssistantOutput();
        this.retractLastTurnForMerge();
        // If the resumed speech turns out to be a ghost/noise, this
        // re-answers the original turn; merged:true makes the client
        // replace (not duplicate) the existing bubble.
        this.deferredAnswer = { rawTranscript: this.lastUserTranscript, merged: true };
      }
      this.refreshSpeechIdleTimer();
      return;
    }

    if (event.type === "audio.commit") {
      this.userSpeechActive = false;
      clearTimeout(this.speechIdleTimer);
      this.pendingTranscriptCompletions += 1;
      this.refreshTranscriptAwaitTimer();
      this.commitAudio();
      return;
    }

    if (event.type === "audio.input") {
      if (this.userSpeechActive) this.refreshSpeechIdleTimer();
      this.forwardAudio(event.audio, event.sampleRate, event.format);
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
        this.finishCommittedTranscript();
        this.continuationPending = false;
        this.send("transcript.ignored", { text: transcript });
        this.scheduleDeferredAnswerIfIdle();
        return;
      }

      this.finishCommittedTranscript();
      if (this.isDuplicateTranscript(transcript)) {
        this.continuationPending = false;
        this.scheduleDeferredAnswerIfIdle();
        return;
      }

      const now = Date.now();
      // Merging retracts the previous turn, so it is only safe while the
      // user hasn't heard any of the reply yet. continuationPending means
      // speech resumed inside the window (history already retracted then).
      const deferredTranscript = this.deferredAnswer?.rawTranscript ?? "";
      const shouldMergeDeferred =
        deferredTranscript.length > 0 && !this.answerAudioStarted;
      const mergeBase = shouldMergeDeferred
        ? deferredTranscript
        : this.lastUserTranscript;
      const shouldMerge =
        mergeBase.length > 0 &&
        (shouldMergeDeferred ||
          this.continuationPending ||
          (!this.answerAudioStarted &&
            now - this.lastUserFinalAt < TRANSCRIPT_MERGE_WINDOW_MS));
      const finalTranscript = shouldMerge
        ? mergeTranscriptText(mergeBase, transcript)
        : transcript;

      if (shouldMerge && !shouldMergeDeferred && !this.continuationPending) {
        this.retractLastTurnForMerge();
      }
      this.continuationPending = false;

      this.lastUserTranscript = finalTranscript;
      this.lastUserFinalAt = now;
      this.scheduleAnswer(finalTranscript, shouldMerge);
      return;
    }

    if (message.type === "conversation.item.input_audio_transcription.failed") {
      this.finishCommittedTranscript();
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
      // The reply language may have changed while the socket was connecting.
      // Apply the latest profile before releasing any queued text.
      this.updateTtsSession();
      this.flushSpeech();
      return;
    }

    // Audio from a cancelled turn's context can still arrive after
    // context.cancel; drop anything not belonging to the current turn.
    if (message.context_id && message.context_id !== this.ttsContextId) {
      return;
    }

    if (message.type === "conversation.item.audio_output.delta") {
      this.answerAudioStarted = true;
      this.send("audio.delta", {
        audio: message.delta,
        sampleRate: 24000,
        itemId: String(message.item_id ?? ""),
      });
      this.scheduleTtsDoneWatchdog(TTS_DONE_AFTER_AUDIO_IDLE_MS);
      return;
    }

    if (message.type === "conversation.item.word_timestamps") {
      this.send("assistant.words", {
        itemId: String(message.item_id ?? ""),
        words: Array.isArray(message.words) ? message.words : [],
        startSeconds: Array.isArray(message.start_seconds)
          ? message.start_seconds
          : [],
        endSeconds: Array.isArray(message.end_seconds) ? message.end_seconds : [],
      });
      return;
    }

    if (message.type === "conversation.item.audio_output.done") {
      this.clearTtsDoneWatchdog();
      this.send("audio.done", {});
      return;
    }

    if (message.type === "conversation.item.tts.failed") {
      this.clearTtsDoneWatchdog();
      if (this.fallbackTts("Voice generation failed.")) return;
      this.send("error", { message: message.error?.message ?? "TTS failed." });
      this.send("audio.done", {});
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

    this.clearTtsDoneWatchdog();
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

  private forwardAudio(
    audio: string,
    sampleRate: number,
    format?: "float32le" | "pcm_s16le",
  ) {
    if (!this.stt || this.stt.readyState !== WebSocket.OPEN) return;

    const encodedAudio =
      format === "pcm_s16le" && sampleRate === 16_000
        ? audio
        : encodeFloat32AsPcm16(audio, sampleRate);

    this.stt.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: encodedAudio,
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
    this.answerAudioStarted = false;

    this.history.push({ role: "user", content: transcript });
    this.trimHistory();

    const controller = new AbortController();
    this.chatAbort = controller;

    let assistant = "";
    let sentence = "";
    let firstSpeechChunkSent = false;
    let speakingStarted = false;

    const handleDelta = (delta: string) => {
      if (!delta) return;
      if (!speakingStarted) {
        speakingStarted = true;
        this.send("state", { state: "speaking" });
      }

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
    };

    try {
      await generateAssistantReply({
        history: this.history,
        transcript,
        signal: controller.signal,
        onDelta: handleDelta,
        onLanguage: (language) => this.setTtsLanguage(language),
        onToolActivity: (activity) => this.sendToolActivity(activity),
        onDebug: (event) => this.send("reply.debug", event),
      });

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
    if (this.userSpeechActive || this.pendingTranscriptCompletions > 0) return;

    const { rawTranscript, merged } = this.deferredAnswer;
    clearTimeout(this.answerTimer);
    this.repairAbort?.abort();
    this.repairAbort = undefined;
    const transcriptId = ++this.pendingTranscriptId;

    // A transcript that reads as an unfinished thought usually means the
    // user paused to think; give them room before answering. speech.started
    // cancels this timer either way.
    const grace = transcriptLooksComplete(rawTranscript)
      ? REPLY_GRACE_MS
      : REPLY_GRACE_INCOMPLETE_MS;

    this.answerTimer = setTimeout(() => {
      this.answerTimer = undefined;
      this.deferredAnswer = undefined;
      if (!this.stopped) {
        this.startTurn(rawTranscript, merged, transcriptId);
      }
    }, grace);
  }

  private startTurn(rawTranscript: string, merged: boolean, transcriptId: number) {
    this.lastRawTranscript = rawTranscript;
    this.lastRepairedTranscript = rawTranscript;
    this.lastUserTranscript = rawTranscript;
    this.lastUserFinalAt = Date.now();
    this.send("transcript.final", { text: rawTranscript, merged });

    // Repair is a display-only cosmetic track: the answer never waits for it.
    void this.repairForDisplay(rawTranscript, transcriptId);
    void this.answer(rawTranscript);
  }

  private async repairForDisplay(rawTranscript: string, transcriptId: number) {
    const controller = new AbortController();
    this.repairAbort = controller;
    const timeout = setTimeout(
      () => controller.abort(),
      TRANSCRIPT_REPAIR_TIMEOUT_MS,
    );

    let repairedTranscript = rawTranscript;
    try {
      repairedTranscript = await repairTranscript(rawTranscript, controller.signal);
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

    // A late or runaway repair is discarded, never applied: text must not
    // change after the client's settle window, and a "repair" that rewrites
    // most of the words is worse than a typo.
    if (this.stopped || transcriptId !== this.pendingTranscriptId) return;
    if (normalizeTranscript(repairedTranscript) === normalizeTranscript(rawTranscript)) {
      return;
    }
    if (wordChangeRatio(rawTranscript, repairedTranscript) > 0.4) return;

    this.lastRepairedTranscript = repairedTranscript;
    if (this.lastUserTranscript === rawTranscript) {
      this.lastUserTranscript = repairedTranscript;
    }
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      if (this.history[i].role === "user") {
        if (this.history[i].content === rawTranscript) {
          this.history[i] = { role: "user", content: repairedTranscript };
        }
        break;
      }
    }
    this.send("transcript.updated", { text: repairedTranscript });
  }

  private retractLastTurnForMerge() {
    if (this.history.at(-1)?.role === "assistant") this.history.pop();
    if (this.history.at(-1)?.role === "user") this.history.pop();
  }

  private getPendingMergeBase() {
    if (!this.lastUserTranscript) return "";
    if (this.continuationPending) return this.lastUserTranscript;
    if (this.answerAudioStarted) return "";
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

  private setTtsLanguage(language: string) {
    if (language === this.ttsLanguage) return;
    this.ttsLanguage = language;
    this.updateTtsSession();
  }

  private updateTtsSession() {
    if (!this.ttsReady || !this.tts || this.tts.readyState !== WebSocket.OPEN) return;

    const config = TTS_MODELS[this.ttsModelIndex] ?? TTS_MODELS[0];
    this.tts.send(
      JSON.stringify({
        type: "tts_session.updated",
        session: {
          language: this.ttsLanguage,
          voice: ttsVoiceForLanguage(config, this.ttsLanguage),
        },
      }),
    );
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
    this.scheduleTtsDoneWatchdog(TTS_DONE_AFTER_COMMIT_MS);
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
    this.pendingTranscriptCompletions = 0;
    clearTimeout(this.transcriptAwaitTimer);
    this.userSpeechActive = false;
    clearTimeout(this.speechIdleTimer);
    this.cancelAssistantOutput();
  }

  private finishCommittedTranscript() {
    this.pendingTranscriptCompletions = Math.max(
      0,
      this.pendingTranscriptCompletions - 1,
    );
    if (this.pendingTranscriptCompletions === 0) {
      clearTimeout(this.transcriptAwaitTimer);
    }
  }

  private refreshTranscriptAwaitTimer() {
    clearTimeout(this.transcriptAwaitTimer);
    this.transcriptAwaitTimer = setTimeout(() => {
      this.pendingTranscriptCompletions = 0;
      this.scheduleDeferredAnswerIfIdle();
    }, STT_COMMIT_AWAIT_TIMEOUT_MS);
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
    this.clearTtsDoneWatchdog();

    if (this.tts && this.tts.readyState === WebSocket.OPEN) {
      this.tts.send(JSON.stringify({ type: "context.cancel", context_id: this.ttsContextId }));
    }

    // Retire the context id so in-flight deltas from the cancelled turn are
    // dropped by the handleTtsMessage filter instead of reaching the client.
    this.ttsContextId = `turn-${this.turnCount}-cancelled`;

    this.send("audio.clear", {});
  }

  private scheduleTtsDoneWatchdog(
    delayMs: number,
    contextId = this.ttsContextId,
  ) {
    this.clearTtsDoneWatchdog();
    this.ttsDoneWatchdog = setTimeout(() => {
      if (this.stopped || contextId !== this.ttsContextId) return;

      if (this.tts && this.tts.readyState === WebSocket.OPEN) {
        this.tts.send(JSON.stringify({ type: "context.cancel", context_id: contextId }));
      }

      this.ttsContextId = `${contextId}-timed-out`;
      this.send("audio.done", {});
      this.send("state", { state: "listening" });
    }, delayMs);
  }

  private clearTtsDoneWatchdog() {
    clearTimeout(this.ttsDoneWatchdog);
    this.ttsDoneWatchdog = undefined;
  }

  private send(type: string, payload: Record<string, unknown>) {
    if (this.stopped || this.client.readyState !== WebSocket.OPEN) return;
    this.client.send(JSON.stringify({ type, ...payload }));
  }

  private sendToolActivity(activity: ToolActivity) {
    this.send("tool.activity", activity);
  }

  private failSession(message: string, error: unknown) {
    this.logError(message, error);
    this.send("error", {
      message: `${message}. Reconnect and check server logs for session ${this.sessionId}.`,
    });
    this.close(message, 1011);
  }

  private log(event: string, details: Record<string, unknown> = {}) {
    console.info("[voice-session]", {
      sessionId: this.sessionId,
      event,
      ...details,
    });
  }

  private logError(
    event: string,
    error: unknown,
    details: Record<string, unknown> = {},
  ) {
    console.error("[voice-session]", {
      sessionId: this.sessionId,
      event,
      ...details,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : error,
    });
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

  private close(reason = "session closed", code = 1000) {
    if (this.stopped) return;
    this.log("session.close", { code, reason });
    this.stopped = true;
    clearInterval(this.keepaliveTimer);
    clearTimeout(this.expiryTimer);
    clearTimeout(this.answerTimer);
    clearTimeout(this.speechIdleTimer);
    clearTimeout(this.transcriptAwaitTimer);
    this.clearTtsDoneWatchdog();
    this.repairAbort?.abort();
    this.chatAbort?.abort();
    this.stt?.close();
    this.tts?.close();
    if (this.client.readyState === WebSocket.OPEN) {
      this.client.close(code, formatCloseReason(reason));
    }
  }
}

function formatCloseReason(reason: string) {
  return reason.slice(0, MAX_CLOSE_REASON_LENGTH);
}

function encodeFloat32AsPcm16(base64Float32: string, sampleRate: number) {
  const float32 = decodeFloat32(base64Float32);
  const pcm16 = floatTo16BitPcm(resample(float32, sampleRate, 16_000));
  return Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength).toString(
    "base64",
  );
}
