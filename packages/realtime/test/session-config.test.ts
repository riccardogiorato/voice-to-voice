import { describe, expect, it } from "vitest";
import { applySessionUpdate, createSessionConfig } from "../src/index.js";

const models = { stt: "stt-model", reply: "reply-model", tts: "tts-model" };
const base = () => createSessionConfig({
  sessionId: "sess_test",
  models,
  maxOutputTokens: 512,
  defaultVoice: "voice one",
});

describe("session compatibility validation", () => {
  it("accepts instructions, function tools, voice, server VAD, and manual mode", () => {
    const updated = applySessionUpdate(base(), {
      instructions: "Be brief",
      tools: [{ type: "function", name: "clock", parameters: { type: "object" } }],
      audio: {
        input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: null },
        output: { voice: "voice two", format: "pcm16", speed: 1 },
      },
      tracing: null,
    }, { voiceLocked: false, models, serverMaxOutputTokens: 512 });
    expect(updated.instructions).toBe("Be brief");
    expect(updated.tools[0]?.name).toBe("clock");
    expect(updated.audio.input.turn_detection).toBeNull();
    expect(updated.audio.output.voice).toBe("voice two");
  });

  it("rejects client model selection, hosted tools, semantic VAD, and non-PCM audio", () => {
    const options = { voiceLocked: false, models, serverMaxOutputTokens: 512 };
    expect(() => applySessionUpdate(base(), { model: "other" }, options)).toThrow("server-controlled");
    expect(() => applySessionUpdate(base(), { tools: [{ type: "mcp" }] }, options)).toThrow("function tools");
    expect(() => applySessionUpdate(base(), { audio: { input: { turn_detection: { type: "semantic_vad" } } } }, options)).toThrow("semantic_vad");
    expect(() => applySessionUpdate(base(), { audio: { output: { format: "g711_ulaw" } } }, options)).toThrow("PCM16");
  });

  it("locks the selected voice after first output audio", () => {
    expect(() => applySessionUpdate(base(), { voice: "voice two" }, {
      voiceLocked: true,
      models,
      serverMaxOutputTokens: 512,
    })).toThrow("cannot be changed");
  });

  it("ignores only harmless compatibility fields and rejects behavior-changing fields", () => {
    const options = { voiceLocked: false, models, serverMaxOutputTokens: 512 };
    expect(() => applySessionUpdate(base(), { tracing: null, include: [] }, options)).not.toThrow();
    expect(() => applySessionUpdate(base(), { tracing: "auto" }, options)).toThrow("Tracing");
    expect(() => applySessionUpdate(base(), { parallel_tool_calls: true }, options)).toThrow("server-controlled");
    expect(() => applySessionUpdate(base(), { unknown_option: true }, options)).toThrow("supported Realtime session contract");
  });
});
