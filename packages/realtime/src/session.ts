import { fitConversation } from "./context.js";
import { pcm16DurationMs, resamplePcm16Base64 } from "./audio.js";
import { realtimeId } from "./ids.js";
import { applySessionUpdate, createSessionConfig } from "./session-config.js";
import {
  RealtimeProtocolError,
  type ConversationMessage,
  type DebugLogger,
  type JsonObject,
  type RealtimeEngineOptions,
  type RealtimeProvider,
  type RealtimeSessionConfig,
  type RealtimeSocket,
  type SpeechConnection,
  type TextConversationMessage,
  type TranscriptionConnection,
} from "./types.js";

const SOCKET_OPEN = 1;

type ActiveResponse = {
  id: string;
  controller: AbortController;
  output: JsonObject[];
  assistantItem?: JsonObject;
  assistantMessage?: TextConversationMessage;
  transcript: string;
  audioMs: number;
  replyDone: boolean;
  ttsDone: boolean;
  finalized: boolean;
  maxOutputTokens: number;
  failed?: Error;
};

export class RealtimeSession {
  readonly id: string;
  private config: RealtimeSessionConfig;
  private readonly provider: RealtimeProvider;
  private readonly controller = new AbortController();
  private transcription: TranscriptionConnection | undefined;
  private speech: SpeechConnection | undefined;
  private transcriptionPromise: Promise<void> | undefined;
  private speechPromise: Promise<SpeechConnection> | undefined;
  private pendingAudio: string[] = [];
  private history: ConversationMessage[] = [];
  private pendingCalls = new Map<string, { name: string; itemId: string }>();
  private active?: ActiveResponse;
  private voiceLocked = false;
  private stopped = false;
  private currentInputItemId = realtimeId("item");
  private committedTranscriptions = 0;
  private responseAfterTranscription = false;
  private messageChain = Promise.resolve();
  private speechActive = false;

  constructor(
    private readonly socket: RealtimeSocket,
    private readonly options: RealtimeEngineOptions & {
      provider: RealtimeProvider;
      maxOutputTokens: number;
      defaultVoice: string;
      logger: DebugLogger;
    },
    input: { sessionId: string; policy?: JsonObject },
  ) {
    this.id = input.sessionId;
    this.provider = options.provider;
    this.config = createSessionConfig({
      sessionId: this.id,
      models: options.models,
      maxOutputTokens: options.maxOutputTokens,
      defaultVoice: options.defaultVoice,
    });
    if (input.policy?.voice && typeof input.policy.voice === "string") {
      this.config.audio.output.voice = input.policy.voice;
    }
    if (input.policy?.truncation === "disabled") this.config.truncation = "disabled";
  }

  start() {
    this.send("session.created", { session: this.config });
    this.socket.on("message", (data) => {
      this.messageChain = this.messageChain.then(() => this.handleMessage(data));
    });
    this.socket.on("close", () => this.close("client_closed"));
    this.socket.on("error", (error) => {
      this.log("client.error", { message: error.message });
      this.close("client_error");
    });
    this.transcriptionPromise = this.openTranscription();
  }

  private async handleMessage(raw: unknown) {
    if (this.stopped) return;
    let event: JsonObject;
    try {
      const value = JSON.parse(rawDataToString(raw)) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      event = value as JsonObject;
    } catch {
      this.sendError(new RealtimeProtocolError("Client events must be JSON objects.", "invalid_request_error"));
      return;
    }

    try {
      await this.dispatch(event);
    } catch (error) {
      const normalized = normalizeError(error);
      this.sendError(normalized, typeof event.event_id === "string" ? event.event_id : undefined);
      if (normalized instanceof RealtimeProtocolError && normalized.fatal) {
        this.close(normalized.code, 1008);
      }
    }
  }

  private async dispatch(event: JsonObject) {
    switch (event.type) {
      case "session.update":
        await this.updateSession(event.session);
        return;
      case "input_audio_buffer.append":
        this.appendAudio(event.audio);
        return;
      case "input_audio_buffer.commit":
        await this.commitAudio();
        return;
      case "input_audio_buffer.clear":
        this.pendingAudio = [];
        this.send("input_audio_buffer.cleared", {});
        return;
      case "conversation.item.create":
        this.createConversationItem(event.item, event.previous_item_id);
        return;
      case "conversation.item.delete":
        this.deleteConversationItem(event.item_id);
        return;
      case "conversation.item.retrieve":
        this.retrieveConversationItem(event.item_id);
        return;
      case "conversation.item.truncate":
        this.truncateConversationItem(event);
        return;
      case "response.create":
        this.validateResponseCreate(event.response);
        if (this.committedTranscriptions > 0) this.responseAfterTranscription = true;
        else void this.createResponse().catch((error) => this.sendError(normalizeError(error)));
        return;
      case "response.cancel":
        this.cancelResponse("client_cancelled");
        return;
      default:
        throw new RealtimeProtocolError(
          `Unsupported client event: ${String(event.type ?? "missing type")}.`,
          "invalid_request_error",
          "type",
        );
    }
  }

  private async updateSession(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new RealtimeProtocolError("session must be an object.", "invalid_request_error", "session");
    }
    let requested = value as JsonObject;
    if (this.options.onSessionUpdate) {
      requested = await this.options.onSessionUpdate(requested, {
        sessionId: this.id,
        phase: "session_update",
      });
    }
    const previousTurnDetection = JSON.stringify(this.config.audio.input.turn_detection);
    this.config = applySessionUpdate(this.config, requested, {
      voiceLocked: this.voiceLocked,
      models: this.options.models,
      serverMaxOutputTokens: this.options.maxOutputTokens,
    });
    this.send("session.updated", { session: this.config });
    if (JSON.stringify(this.config.audio.input.turn_detection) !== previousTurnDetection) {
      this.transcription?.close();
      this.transcription = undefined;
      this.transcriptionPromise = this.openTranscription();
    }
  }

  private appendAudio(value: unknown) {
    if (typeof value !== "string") {
      throw new RealtimeProtocolError("audio must be a base64 string.", "invalid_request_error", "audio");
    }
    const converted = resamplePcm16Base64(value);
    if (this.transcription) this.transcription.append(converted);
    else this.pendingAudio.push(converted);
  }

  private async commitAudio() {
    await this.transcriptionPromise;
    if (!this.transcription) throw new Error("Transcription connection is unavailable.");
    this.committedTranscriptions += 1;
    this.transcription.commit();
    this.send("input_audio_buffer.committed", {
      item_id: this.currentInputItemId,
      previous_item_id: this.history.at(-1)?.id ?? null,
    });
  }

  private async openTranscription() {
    try {
      const connection = await this.provider.openTranscription({
        sessionId: this.id,
        model: this.options.models.stt,
        turnDetection: this.config.audio.input.turn_detection,
        signal: this.controller.signal,
        onEvent: (event) => this.handleTranscriptionEvent(event),
      });
      if (this.stopped) return connection.close();
      this.transcription = connection;
      for (const audio of this.pendingAudio.splice(0)) connection.append(audio);
    } catch (error) {
      if (!this.controller.signal.aborted) this.sendProviderFailure("transcription", error);
    }
  }

  private handleTranscriptionEvent(event: JsonObject) {
    if (event.type === "input_audio_buffer.speech_started") {
      if (this.speechActive) return;
      this.speechActive = true;
      this.send("input_audio_buffer.speech_started", {
        audio_start_ms: event.audio_start_ms ?? 0,
        item_id: this.currentInputItemId,
      });
      if (this.config.audio.input.turn_detection?.interrupt_response !== false) {
        this.cancelResponse("turn_detected");
      }
      return;
    }
    if (event.type === "input_audio_buffer.speech_stopped") {
      if (!this.speechActive) return;
      this.speechActive = false;
      this.send("input_audio_buffer.speech_stopped", {
        audio_end_ms: event.audio_end_ms ?? 0,
        item_id: this.currentInputItemId,
      });
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.delta") {
      this.beginServerVadSpeech(event);
      this.send("conversation.item.input_audio_transcription.delta", {
        item_id: this.currentInputItemId,
        content_index: 0,
        delta: String(event.delta ?? ""),
      });
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = String(event.transcript ?? "").trim();
      this.endServerVadSpeech(event);
      if (!transcript) return;
      const itemId = this.currentInputItemId;
      this.currentInputItemId = realtimeId("item");
      const message: ConversationMessage = { id: itemId, role: "user", text: transcript };
      this.history.push(message);
      const item = messageItem(message);
      this.send("conversation.item.added", {
        previous_item_id: this.history.at(-2)?.id ?? null,
        item,
      });
      this.send("conversation.item.done", {
        previous_item_id: this.history.at(-2)?.id ?? null,
        item,
      });
      this.send("conversation.item.input_audio_transcription.completed", {
        item_id: itemId,
        content_index: 0,
        transcript,
      });
      this.committedTranscriptions = Math.max(0, this.committedTranscriptions - 1);
      const shouldRespond = this.responseAfterTranscription ||
        this.config.audio.input.turn_detection?.create_response !== false;
      this.responseAfterTranscription = false;
      if (shouldRespond) {
        void this.createResponse().catch((error) => this.sendError(normalizeError(error)));
      }
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.failed") {
      this.endServerVadSpeech(event);
      this.committedTranscriptions = Math.max(0, this.committedTranscriptions - 1);
      this.responseAfterTranscription = false;
      this.sendError(new RealtimeProtocolError(
        String((event.error as JsonObject | undefined)?.message ?? "Transcription failed."),
        "transcription_error",
      ));
      return;
    }
    if (event.type === "provider.error") {
      this.sendProviderFailure("transcription", String(event.message ?? "Transcription provider failed."));
    }
  }

  private beginServerVadSpeech(event: JsonObject) {
    if (!this.config.audio.input.turn_detection || this.speechActive) return;
    this.speechActive = true;
    this.send("input_audio_buffer.speech_started", {
      audio_start_ms: event.audio_start_ms ?? 0,
      item_id: this.currentInputItemId,
    });
    if (this.config.audio.input.turn_detection.interrupt_response !== false) {
      this.cancelResponse("turn_detected");
    }
  }

  private endServerVadSpeech(event: JsonObject) {
    if (!this.config.audio.input.turn_detection || !this.speechActive) return;
    this.speechActive = false;
    this.send("input_audio_buffer.speech_stopped", {
      audio_end_ms: event.audio_end_ms ?? 0,
      item_id: this.currentInputItemId,
    });
  }

  private createConversationItem(value: unknown, previousItemId: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new RealtimeProtocolError("item must be an object.", "invalid_request_error", "item");
    }
    const item = value as JsonObject;
    const id = typeof item.id === "string" ? item.id : realtimeId("item");
    if (this.history.some((entry) => entry.id === id)) {
      throw new RealtimeProtocolError("Conversation item IDs must be unique.", "invalid_request_error", "item.id");
    }
    let message: ConversationMessage;

    if (item.type === "function_call_output") {
      if (typeof item.call_id !== "string" || typeof item.output !== "string") {
        throw new RealtimeProtocolError(
          "function_call_output requires call_id and string output.",
          "invalid_request_error",
          "item",
        );
      }
      const pending = this.pendingCalls.get(item.call_id);
      if (!pending) {
        throw new RealtimeProtocolError("Unknown function call ID.", "invalid_request_error", "item.call_id");
      }
      message = {
        id,
        role: "tool",
        toolResult: { callId: item.call_id, name: pending.name, output: item.output },
      };
      this.pendingCalls.delete(item.call_id);
    } else if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || typeof item.name !== "string") {
        throw new RealtimeProtocolError("Invalid function_call item.", "invalid_request_error", "item");
      }
      message = {
        id,
        role: "assistant",
        toolCall: {
          callId: item.call_id,
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : "{}",
        },
      };
      this.pendingCalls.set(item.call_id, { name: item.name, itemId: id });
    } else if (item.type === "message" && (item.role === "user" || item.role === "assistant")) {
      const text = extractItemText(item.content);
      if (!text) {
        throw new RealtimeProtocolError("Message items require text content.", "invalid_request_error", "item.content");
      }
      message = { id, role: item.role, text };
    } else {
      throw new RealtimeProtocolError("Unsupported conversation item.", "invalid_request_error", "item.type");
    }

    const previousIndex = typeof previousItemId === "string"
      ? this.history.findIndex((entry) => entry.id === previousItemId)
      : -1;
    if (typeof previousItemId === "string" && previousIndex < 0) {
      throw new RealtimeProtocolError("Unknown previous_item_id.", "invalid_request_error", "previous_item_id");
    }
    if (previousIndex >= 0) this.history.splice(previousIndex + 1, 0, message);
    else this.history.push(message);
    const createdItem = protocolItem(message);
    this.send("conversation.item.added", {
      previous_item_id: this.history.at(this.history.indexOf(message) - 1)?.id ?? null,
      item: createdItem,
    });
    this.send("conversation.item.done", {
      previous_item_id: this.history.at(this.history.indexOf(message) - 1)?.id ?? null,
      item: createdItem,
    });
  }

  private validateResponseCreate(value: unknown) {
    if (value === undefined || value === null) return;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new RealtimeProtocolError("response must be an object.", "invalid_request_error", "response");
    }
    if (Object.keys(value as JsonObject).length > 0) {
      throw new RealtimeProtocolError(
        "Per-response overrides are not supported; configure the session before response.create.",
        "invalid_request_error",
        "response",
      );
    }
  }

  private deleteConversationItem(value: unknown) {
    if (typeof value !== "string") {
      throw new RealtimeProtocolError("item_id is required.", "invalid_request_error", "item_id");
    }
    const index = this.history.findIndex((entry) => entry.id === value);
    if (index < 0) throw new RealtimeProtocolError("Unknown item_id.", "invalid_request_error", "item_id");
    this.history.splice(index, 1);
    this.send("conversation.item.deleted", { item_id: value });
  }

  private retrieveConversationItem(value: unknown) {
    if (typeof value !== "string") {
      throw new RealtimeProtocolError("item_id is required.", "invalid_request_error", "item_id");
    }
    const message = this.history.find((entry) => entry.id === value);
    if (!message) throw new RealtimeProtocolError("Unknown item_id.", "invalid_request_error", "item_id");
    this.send("conversation.item.retrieved", { item: protocolItem(message) });
  }

  private truncateConversationItem(event: JsonObject) {
    if (typeof event.item_id !== "string" || typeof event.audio_end_ms !== "number") {
      throw new RealtimeProtocolError(
        "conversation.item.truncate requires item_id and audio_end_ms.",
        "invalid_request_error",
        "item_id",
      );
    }
    const message = this.history.find(
      (entry): entry is TextConversationMessage =>
        entry.id === event.item_id && "text" in entry && entry.role === "assistant",
    );
    if (!message) throw new RealtimeProtocolError("Unknown assistant audio item.", "invalid_request_error", "item_id");
    if (this.active?.assistantMessage === message && this.active.audioMs > 0) {
      const ratio = Math.max(0, Math.min(1, event.audio_end_ms / this.active.audioMs));
      message.text = message.text.slice(0, Math.floor(message.text.length * ratio)).trimEnd();
    }
    this.send("conversation.item.truncated", {
      item_id: event.item_id,
      content_index: event.content_index ?? 0,
      audio_end_ms: event.audio_end_ms,
    });
  }

  private async createResponse() {
    if (this.active && !this.active.finalized) {
      throw new RealtimeProtocolError("A response is already in progress.", "response_in_progress");
    }
    const fitted = fitConversation({
      instructions: this.config.instructions,
      messages: this.history,
      contextWindowTokens: this.options.replyContextWindowTokens,
      outputReserveTokens: this.options.maxOutputTokens,
      truncation: this.config.truncation,
    });
    this.history = fitted.messages;
    for (const removed of fitted.removed) this.send("conversation.item.deleted", { item_id: removed.id });

    const response: ActiveResponse = {
      id: realtimeId("resp"),
      controller: new AbortController(),
      output: [],
      transcript: "",
      audioMs: 0,
      replyDone: false,
      ttsDone: false,
      finalized: false,
      maxOutputTokens: this.options.maxOutputTokens,
    };
    this.active = response;
    this.send("response.created", { response: responseObject(response, "in_progress") });
    try {
      for await (const part of this.provider.streamReply({
        model: this.options.models.reply,
        instructions: this.config.instructions,
        messages: this.history,
        tools: this.config.tools,
        toolChoice: this.config.tool_choice,
        maxOutputTokens: this.options.maxOutputTokens,
        signal: response.controller.signal,
      })) {
        if (response.finalized) return;
        if (part.type === "text-delta") await this.handleTextDelta(response, part.delta);
        else if (part.type === "tool-call") this.handleToolCall(response, part);
        else if (part.type === "error") throw part.error;
        else if (part.type === "done") response.replyDone = true;
      }
      response.replyDone = true;
      if (!response.transcript) response.ttsDone = true;
      else this.speech?.commit();
      this.maybeFinalize(response);
    } catch (error) {
      if (response.controller.signal.aborted) return;
      response.failed = normalizeError(error);
      response.controller.abort();
      response.replyDone = true;
      response.ttsDone = true;
      this.sendError(response.failed);
      this.maybeFinalize(response);
    }
  }

  private async openSpeech(response: ActiveResponse) {
    const speech = await this.provider.openSpeech({
      sessionId: `${this.id}_${response.id}`,
      model: this.options.models.tts,
      voice: this.config.audio.output.voice,
      signal: response.controller.signal,
      onEvent: (event) => this.handleSpeechEvent(response, event),
    });
    if (response.finalized) {
      speech.close();
      return speech;
    }
    this.speech = speech;
    return speech;
  }

  private async handleTextDelta(response: ActiveResponse, delta: string) {
    if (!delta) return;
    if (!response.assistantItem) this.createAssistantOutput(response);
    response.transcript += delta;
    if (response.assistantMessage) response.assistantMessage.text = response.transcript;
    const itemId = String(response.assistantItem?.id);
    this.send("response.output_audio_transcript.delta", {
      response_id: response.id,
      item_id: itemId,
      output_index: response.output.indexOf(response.assistantItem!),
      content_index: 0,
      delta,
    });
    this.speechPromise ??= this.openSpeech(response);
    const speech = this.speech ?? await this.speechPromise;
    speech?.append(delta);
  }

  private createAssistantOutput(response: ActiveResponse) {
    const itemId = realtimeId("item");
    const message: TextConversationMessage = {
      id: itemId,
      role: "assistant",
      text: "",
    };
    this.history.push(message);
    response.assistantMessage = message;
    response.assistantItem = {
      id: itemId,
      object: "realtime.item",
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [{ type: "audio", transcript: "" }],
    };
    response.output.push(response.assistantItem);
    const outputIndex = response.output.length - 1;
    this.send("response.output_item.added", {
      response_id: response.id,
      output_index: outputIndex,
      item: response.assistantItem,
    });
    this.send("response.content_part.added", {
      response_id: response.id,
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "audio", transcript: "" },
    });
  }

  private handleToolCall(
    response: ActiveResponse,
    call: { callId: string; name: string; arguments: string },
  ) {
    const itemId = realtimeId("item");
    const item = {
      id: itemId,
      object: "realtime.item",
      type: "function_call",
      status: "in_progress",
      call_id: call.callId,
      name: call.name,
      arguments: call.arguments,
    };
    const message: ConversationMessage = {
      id: itemId,
      role: "assistant",
      toolCall: { callId: call.callId, name: call.name, arguments: call.arguments },
    };
    this.history.push(message);
    this.pendingCalls.set(call.callId, { name: call.name, itemId });
    response.output.push(item);
    const outputIndex = response.output.length - 1;
    this.send("response.output_item.added", {
      response_id: response.id,
      output_index: outputIndex,
      item,
    });
    this.send("response.function_call_arguments.done", {
      response_id: response.id,
      item_id: itemId,
      output_index: outputIndex,
      call_id: call.callId,
      name: call.name,
      arguments: call.arguments,
    });
    const completedItem = { ...item, status: "completed" };
    this.send("response.output_item.done", {
      response_id: response.id,
      output_index: outputIndex,
      item: completedItem,
    });
    Object.assign(item, completedItem);
  }

  private handleSpeechEvent(response: ActiveResponse, event: JsonObject) {
    if (response.finalized || this.active !== response) return;
    if (event.type === "conversation.item.audio_output.delta") {
      const delta = String(event.delta ?? "");
      if (!delta || !response.assistantItem) return;
      this.voiceLocked = true;
      response.audioMs += pcm16DurationMs(delta);
      this.send("response.output_audio.delta", {
        response_id: response.id,
        item_id: response.assistantItem.id,
        output_index: response.output.indexOf(response.assistantItem),
        content_index: 0,
        delta,
      });
      return;
    }
    if (event.type === "conversation.item.audio_output.done") {
      response.ttsDone = true;
      this.maybeFinalize(response);
      return;
    }
    if (event.type === "conversation.item.tts.failed" || event.type === "provider.error") {
      response.failed = new Error(String((event.error as JsonObject | undefined)?.message ?? event.message ?? "Speech generation failed."));
      response.controller.abort();
      response.replyDone = true;
      response.ttsDone = true;
      this.sendError(response.failed);
      this.maybeFinalize(response);
    }
  }

  private maybeFinalize(response: ActiveResponse) {
    if (response.finalized || !response.replyDone || !response.ttsDone) return;
    response.finalized = true;
    if (response.assistantItem) {
      const outputIndex = response.output.indexOf(response.assistantItem);
      const completed = {
        ...response.assistantItem,
        status: response.failed ? "incomplete" : "completed",
        content: [{ type: "audio", transcript: response.transcript }],
      };
      this.send("response.output_audio_transcript.done", {
        response_id: response.id,
        item_id: response.assistantItem.id,
        output_index: outputIndex,
        content_index: 0,
        transcript: response.transcript,
      });
      this.send("response.output_audio.done", {
        response_id: response.id,
        item_id: response.assistantItem.id,
        output_index: outputIndex,
        content_index: 0,
      });
      this.send("response.content_part.done", {
        response_id: response.id,
        item_id: response.assistantItem.id,
        output_index: outputIndex,
        content_index: 0,
        part: completed.content[0],
      });
      this.send("response.output_item.done", {
        response_id: response.id,
        output_index: outputIndex,
        item: completed,
      });
      Object.assign(response.assistantItem, completed);
    }
    this.send("response.done", {
      response: responseObject(response, response.failed ? "failed" : "completed"),
    });
    this.speech?.close();
    this.speech = undefined;
    this.speechPromise = undefined;
  }

  private cancelResponse(reason: string) {
    const response = this.active;
    if (!response || response.finalized) return;
    response.controller.abort();
    response.finalized = true;
    this.speech?.cancel();
    this.speech?.close();
    this.speech = undefined;
    this.speechPromise = undefined;
    if (response.assistantItem) {
      const outputIndex = response.output.indexOf(response.assistantItem);
      this.send("response.output_audio.done", {
        response_id: response.id,
        item_id: response.assistantItem.id,
        output_index: outputIndex,
        content_index: 0,
      });
    }
    this.send("response.done", {
      response: {
        ...responseObject(response, "cancelled"),
        status_details: { type: "cancelled", reason },
      },
    });
  }

  private sendProviderFailure(stage: string, error: unknown) {
    this.sendError(new RealtimeProtocolError(
      `${stage} provider failed: ${normalizeError(error).message}`,
      `${stage}_error`,
    ));
  }

  private sendError(error: Error, clientEventId?: string) {
    const protocol = error instanceof RealtimeProtocolError ? error : undefined;
    this.send("error", {
      error: {
        type: protocol?.code === "invalid_request_error" ? "invalid_request_error" : "server_error",
        code: protocol?.code ?? "server_error",
        message: error.message,
        param: protocol?.param ?? null,
        event_id: clientEventId ?? null,
      },
    });
  }

  private send(type: string, payload: JsonObject) {
    if (this.stopped || this.socket.readyState !== SOCKET_OPEN) return;
    const event = { type, event_id: realtimeId("event"), ...payload };
    this.socket.send(JSON.stringify(event));
    this.log("server.event", { type });
  }

  private log(event: string, detail?: JsonObject) {
    this.options.logger(detail
      ? { sessionId: this.id, event, detail }
      : { sessionId: this.id, event });
  }

  close(reason = "session_closed", code = 1000) {
    if (this.stopped) return;
    this.cancelResponse(reason);
    this.stopped = true;
    this.controller.abort();
    this.transcription?.close();
    this.speech?.close();
    if (this.socket.readyState === SOCKET_OPEN) this.socket.close(code, reason.slice(0, 120));
  }
}

function responseObject(response: ActiveResponse, status: "in_progress" | "completed" | "failed" | "cancelled") {
  return {
    id: response.id,
    object: "realtime.response",
    status,
    status_details: response.failed
      ? { type: "failed", error: { type: "server_error", code: "provider_error", message: response.failed.message } }
      : null,
    output: response.output,
    conversation_id: "auto",
    output_modalities: ["audio"],
    max_output_tokens: response.maxOutputTokens,
    usage: null,
  };
}

function extractItemText(content: unknown) {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = part as JsonObject;
      return typeof value.text === "string"
        ? value.text
        : typeof value.transcript === "string"
          ? value.transcript
          : "";
    })
    .join("")
    .trim();
}

function protocolItem(message: ConversationMessage): JsonObject {
  if ("text" in message) return messageItem(message);
  if ("toolCall" in message) {
    return {
      id: message.id,
      object: "realtime.item",
      type: "function_call",
      status: "completed",
      call_id: message.toolCall.callId,
      name: message.toolCall.name,
      arguments: message.toolCall.arguments,
    };
  }
  return {
    id: message.id,
    object: "realtime.item",
    type: "function_call_output",
    status: "completed",
    call_id: message.toolResult.callId,
    output: message.toolResult.output,
  };
}

function messageItem(message: Extract<ConversationMessage, { text: string }>): JsonObject {
  return {
    id: message.id,
    object: "realtime.item",
    type: "message",
    status: "completed",
    role: message.role,
    content: [{
      type: message.role === "user" ? "input_text" : "output_text",
      text: message.text,
    }],
  };
}

function rawDataToString(value: unknown) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value && typeof value === "object" && "toString" in value) return String(value);
  return "";
}

function normalizeError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
