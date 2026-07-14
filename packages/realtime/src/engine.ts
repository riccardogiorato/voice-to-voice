import { realtimeId } from "./ids.js";
import { applySessionUpdate, createSessionConfig } from "./session-config.js";
import { RealtimeSession } from "./session.js";
import { resolveSigningSecret, signClientSecret, verifyClientSecret } from "./token.js";
import { TogetherRealtimeProvider } from "./together-provider.js";
import {
  RealtimeProtocolError,
  type ClientSecretResponse,
  type DebugLogger,
  type JsonObject,
  type RealtimeEngineOptions,
  type RealtimeProvider,
  type RealtimeSocket,
} from "./types.js";

export class RealtimeEngine {
  readonly audience: string;
  readonly provider: RealtimeProvider;
  readonly maxOutputTokens: number;
  readonly defaultVoice: string;
  readonly logger: DebugLogger;
  private signingSecret?: string;

  constructor(readonly options: RealtimeEngineOptions) {
    validateEngineOptions(options);
    this.audience = options.audience ?? "together-realtime";
    this.maxOutputTokens = options.maxOutputTokens ?? 1024;
    this.defaultVoice = options.defaultVoice;
    const apiKey = options.apiKey ?? process.env.TOGETHER_API_KEY ?? "";
    this.provider = options.provider ?? new TogetherRealtimeProvider(apiKey);
    this.logger = resolveLogger(options.debug);
  }

  async createClientSecret(body: unknown = {}): Promise<ClientSecretResponse> {
    if (!isObject(body)) {
      throw new RealtimeProtocolError(
        "The client-secret request body must be a JSON object.",
        "invalid_request_error",
      );
    }
    const request = body;
    const sessionId = realtimeId("sess");
    let session = createSessionConfig({
      sessionId,
      models: this.options.models,
      maxOutputTokens: this.maxOutputTokens,
      defaultVoice: this.defaultVoice,
    });
    const requestedSession = isObject(request.session) ? request.session : {};
    const hooked = this.options.onSessionUpdate
      ? await this.options.onSessionUpdate(requestedSession, { sessionId, phase: "client_secret" })
      : requestedSession;
    session = applySessionUpdate(session, hooked, {
      voiceLocked: false,
      models: this.options.models,
      serverMaxOutputTokens: this.maxOutputTokens,
    });

    const ttl = parseTtl(request.expires_after, this.options.clientSecretTtlSeconds ?? 60);
    const expiresAt = Math.floor(Date.now() / 1000) + ttl;
    const policy: JsonObject = {
      voice: session.audio.output.voice,
      truncation: session.truncation,
    };
    return {
      value: signClientSecret(
        { sid: sessionId, exp: expiresAt, aud: this.audience, policy },
        this.getSigningSecret(),
      ),
      expires_at: expiresAt,
      session,
    };
  }

  authorize(clientSecret: string) {
    return verifyClientSecret(clientSecret, this.getSigningSecret(), this.audience);
  }

  acceptSocket(socket: RealtimeSocket, clientSecret: string) {
    const token = this.authorize(clientSecret);
    const session = new RealtimeSession(
      socket,
      {
        ...this.options,
        provider: this.provider,
        maxOutputTokens: this.maxOutputTokens,
        defaultVoice: this.defaultVoice,
        logger: this.logger,
      },
      { sessionId: token.sid, policy: token.policy },
    );
    session.start();
    return session;
  }

  private getSigningSecret() {
    this.signingSecret ??= resolveSigningSecret(this.options.realtimeSecret);
    return this.signingSecret;
  }
}

export function createRealtimeEngine(options: RealtimeEngineOptions) {
  return new RealtimeEngine(options);
}

function validateEngineOptions(options: RealtimeEngineOptions) {
  for (const key of ["stt", "reply", "tts"] as const) {
    if (!options.models?.[key]?.trim()) {
      throw new Error(`models.${key} is required; realtime model IDs have no package defaults.`);
    }
  }
  if (!Number.isSafeInteger(options.replyContextWindowTokens) || options.replyContextWindowTokens <= 0) {
    throw new Error("replyContextWindowTokens must be a positive integer.");
  }
  if (!options.defaultVoice?.trim()) {
    throw new Error("defaultVoice is required and must be supported by the configured TTS model.");
  }
  if (options.maxOutputTokens !== undefined && (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens <= 0)) {
    throw new Error("maxOutputTokens must be a positive integer.");
  }
  if ((options.maxOutputTokens ?? 1024) >= options.replyContextWindowTokens) {
    throw new Error("replyContextWindowTokens must exceed maxOutputTokens.");
  }
}

function parseTtl(value: unknown, defaultSeconds: number) {
  if (value === undefined) return defaultSeconds;
  if (!isObject(value) || value.anchor !== "created_at" || !Number.isSafeInteger(value.seconds)) {
    throw new RealtimeProtocolError(
      "expires_after must use anchor created_at and integer seconds.",
      "invalid_request_error",
      "expires_after",
    );
  }
  const seconds = value.seconds as number;
  if (seconds < 10 || seconds > 600) {
    throw new RealtimeProtocolError(
      "Client secret lifetime must be between 10 and 600 seconds.",
      "invalid_request_error",
      "expires_after.seconds",
    );
  }
  return seconds;
}

function resolveLogger(debug: RealtimeEngineOptions["debug"]): DebugLogger {
  if (typeof debug === "function") return debug;
  if (debug === true) return (entry) => console.debug("[together-realtime]", entry);
  return () => {};
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
