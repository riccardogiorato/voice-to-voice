import { describe, expect, it } from "vitest";
import {
  createRealtimeEngine,
  extractBrowserClientSecret,
  RealtimeProtocolError,
  signClientSecret,
  verifyClientSecret,
} from "../src/index.js";

describe("stateless client secrets", () => {
  const payload = { sid: "sess_test", exp: 2_000, aud: "demo", policy: { voice: "test" } };

  it("round trips a signed, audience-bound token", () => {
    const token = signClientSecret(payload, "secret");
    expect(verifyClientSecret(token, "secret", "demo", 1_000)).toEqual(payload);
  });

  it("rejects expiry, tampering, and audience mismatch", () => {
    const token = signClientSecret(payload, "secret");
    expect(() => verifyClientSecret(token, "secret", "demo", 2_001)).toThrow("expired");
    expect(() => verifyClientSecret(`${token}x`, "secret", "demo", 1_000)).toThrow("Invalid");
    expect(() => verifyClientSecret(token, "secret", "other", 1_000)).toThrow("audience");
  });

  it("extracts the browser WebSocket capability subprotocol", () => {
    expect(extractBrowserClientSecret("realtime, openai-insecure-api-key.ek_abc")).toBe("ek_abc");
    expect(() => extractBrowserClientSecret("openai-insecure-api-key.ek_abc")).toThrow(RealtimeProtocolError);
  });

  it("rejects non-object creation bodies and short configured signing secrets", async () => {
    const engine = createRealtimeEngine({
      realtimeSecret: "short",
      models: { stt: "stt", reply: "reply", tts: "tts" },
      replyContextWindowTokens: 4096,
      defaultVoice: "voice",
    });
    await expect(engine.createClientSecret([])).rejects.toThrow("JSON object");
    await expect(engine.createClientSecret()).rejects.toThrow("at least 32 bytes");
  });
});
