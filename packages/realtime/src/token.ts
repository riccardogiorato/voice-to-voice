import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { RealtimeProtocolError, type JsonObject } from "./types.js";

type TokenPayload = {
  sid: string;
  exp: number;
  aud: string;
  policy: JsonObject;
};

let localSecret: string | undefined;

export function resolveSigningSecret(configured?: string) {
  const secret = configured?.trim() || process.env.TOGETHER_REALTIME_SECRET?.trim();
  if (secret) {
    if (Buffer.byteLength(secret) < 32) {
      throw new Error("TOGETHER_REALTIME_SECRET must contain at least 32 bytes.");
    }
    return secret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("TOGETHER_REALTIME_SECRET is required in production.");
  }
  if (!localSecret) {
    localSecret = randomBytes(32).toString("base64url");
    console.warn(
      "[together-realtime] Generated an in-memory development signing secret. Restarting invalidates outstanding client secrets.",
    );
  }
  return localSecret;
}

export function signClientSecret(payload: TokenPayload, secret: string) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `ek_${encoded}.${signature}`;
}

export function verifyClientSecret(
  token: string,
  secret: string,
  audience: string,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  if (!token.startsWith("ek_")) {
    throw new RealtimeProtocolError("Invalid client secret.", "invalid_api_key", undefined, true);
  }
  const [encoded, supplied] = token.slice(3).split(".");
  if (!encoded || !supplied) {
    throw new RealtimeProtocolError("Invalid client secret.", "invalid_api_key", undefined, true);
  }
  const expected = createHmac("sha256", secret).update(encoded).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(supplied, "base64url");
  } catch {
    throw new RealtimeProtocolError("Invalid client secret.", "invalid_api_key", undefined, true);
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new RealtimeProtocolError("Invalid client secret.", "invalid_api_key", undefined, true);
  }
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as TokenPayload;
  } catch {
    throw new RealtimeProtocolError("Invalid client secret.", "invalid_api_key", undefined, true);
  }
  if (payload.aud !== audience) {
    throw new RealtimeProtocolError("Client secret audience mismatch.", "invalid_api_key", undefined, true);
  }
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= nowSeconds) {
    throw new RealtimeProtocolError("Client secret has expired.", "expired_api_key", undefined, true);
  }
  if (typeof payload.sid !== "string" || !payload.policy || typeof payload.policy !== "object") {
    throw new RealtimeProtocolError("Invalid client secret payload.", "invalid_api_key", undefined, true);
  }
  return payload;
}

export function extractBrowserClientSecret(protocols: string | string[] | undefined) {
  const values = Array.isArray(protocols)
    ? protocols
    : (protocols ?? "").split(",").map((entry) => entry.trim());
  if (!values.includes("realtime")) {
    throw new RealtimeProtocolError(
      "The realtime WebSocket subprotocol is required.",
      "invalid_request_error",
      "Sec-WebSocket-Protocol",
      true,
    );
  }
  const auth = values.find((value) => value.startsWith("openai-insecure-api-key."));
  if (!auth) {
    throw new RealtimeProtocolError(
      "A client secret WebSocket subprotocol is required.",
      "invalid_api_key",
      "Sec-WebSocket-Protocol",
      true,
    );
  }
  return auth.slice("openai-insecure-api-key.".length);
}
