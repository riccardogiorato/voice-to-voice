export type JsonObject = Record<string, unknown>;

export type RealtimeTool = {
  type: "function";
  name: string;
  description?: string;
  parameters: JsonObject;
};

export type TurnDetection =
  | {
      type: "server_vad";
      threshold?: number;
      prefix_padding_ms?: number;
      silence_duration_ms?: number;
      create_response?: boolean;
      interrupt_response?: boolean;
    }
  | null;

export type RealtimeSessionConfig = {
  type: "realtime";
  object: "realtime.session";
  id: string;
  model: "together-realtime";
  output_modalities: ["audio"];
  instructions: string;
  tools: RealtimeTool[];
  tool_choice: "auto" | "none" | "required" | { type: "function"; name: string };
  max_output_tokens: number;
  truncation: "auto" | "disabled";
  audio: {
    input: {
      format: { type: "audio/pcm"; rate: 24000 };
      transcription: { model: string };
      noise_reduction: null;
      turn_detection: TurnDetection;
    };
    output: {
      format: { type: "audio/pcm"; rate: 24000 };
      voice: string;
      speed: 1;
    };
  };
};

export type SessionUpdateHook = (
  requested: JsonObject,
  context: { sessionId: string; phase: "client_secret" | "session_update" },
) => JsonObject | Promise<JsonObject>;

export type RealtimeModels = {
  stt: string;
  reply: string;
  tts: string;
};

export type DebugLogger = (entry: {
  sessionId?: string;
  event: string;
  detail?: JsonObject;
}) => void;

export type RealtimeEngineOptions = {
  apiKey?: string;
  realtimeSecret?: string;
  audience?: string;
  models: RealtimeModels;
  replyContextWindowTokens: number;
  maxOutputTokens?: number;
  defaultVoice: string;
  clientSecretTtlSeconds?: number;
  onSessionUpdate?: SessionUpdateHook;
  debug?: boolean | DebugLogger;
  provider?: RealtimeProvider;
};

export type ClientSecretResponse = {
  value: string;
  expires_at: number;
  session: RealtimeSessionConfig;
};

export type RealtimeSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: (code: number, reason: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

export type TextConversationMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type ConversationMessage =
  | TextConversationMessage
  | {
      id: string;
      role: "assistant";
      toolCall: { callId: string; name: string; arguments: string };
    }
  | {
      id: string;
      role: "tool";
      toolResult: { callId: string; name: string; output: string };
    };

export type ReplyStreamEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; callId: string; name: string; arguments: string }
  | { type: "done"; finishReason?: string }
  | { type: "error"; error: Error };

export interface RealtimeProvider {
  openTranscription(input: {
    sessionId: string;
    model: string;
    turnDetection: TurnDetection;
    signal: AbortSignal;
    onEvent: (event: JsonObject) => void;
  }): Promise<TranscriptionConnection>;
  streamReply(input: {
    model: string;
    instructions: string;
    messages: ConversationMessage[];
    tools: RealtimeTool[];
    toolChoice: RealtimeSessionConfig["tool_choice"];
    maxOutputTokens: number;
    signal: AbortSignal;
  }): AsyncIterable<ReplyStreamEvent>;
  openSpeech(input: {
    sessionId: string;
    model: string;
    voice: string;
    signal: AbortSignal;
    onEvent: (event: JsonObject) => void;
  }): Promise<SpeechConnection>;
}

export interface TranscriptionConnection {
  append(pcm16At16KhzBase64: string): void;
  commit(): void;
  close(): void;
}

export interface SpeechConnection {
  append(text: string): void;
  commit(): void;
  cancel(): void;
  close(): void;
}

export class RealtimeProtocolError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly param?: string,
    readonly fatal = false,
  ) {
    super(message);
    this.name = "RealtimeProtocolError";
  }
}
