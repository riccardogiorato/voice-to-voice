import {
  RealtimeProtocolError,
  type JsonObject,
  type RealtimeModels,
  type RealtimeSessionConfig,
  type RealtimeTool,
  type TurnDetection,
} from "./types.js";

const DEFAULT_INSTRUCTIONS = "You are a concise, helpful voice assistant.";

const SESSION_UPDATE_FIELDS = new Set([
  "type",
  "model",
  "instructions",
  "output_modalities",
  "modalities",
  "tools",
  "tool_choice",
  "truncation",
  "max_output_tokens",
  "audio",
  "input_audio_format",
  "output_audio_format",
  "voice",
  "turn_detection",
  "tracing",
  "include",
  "temperature",
  "reasoning",
  "prompt",
  "mcp_servers",
  "parallel_tool_calls",
]);

export function createSessionConfig(input: {
  sessionId: string;
  models: RealtimeModels;
  maxOutputTokens: number;
  defaultVoice: string;
}): RealtimeSessionConfig {
  return {
    type: "realtime",
    object: "realtime.session",
    id: input.sessionId,
    model: "together-realtime",
    output_modalities: ["audio"],
    instructions: DEFAULT_INSTRUCTIONS,
    tools: [],
    tool_choice: "auto",
    max_output_tokens: input.maxOutputTokens,
    truncation: "auto",
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },
        transcription: { model: input.models.stt },
        noise_reduction: null,
        turn_detection: {
          type: "server_vad",
          create_response: true,
          interrupt_response: true,
        },
      },
      output: {
        format: { type: "audio/pcm", rate: 24000 },
        voice: input.defaultVoice,
        speed: 1,
      },
    },
  };
}

export function applySessionUpdate(
  current: RealtimeSessionConfig,
  update: JsonObject,
  options: { voiceLocked: boolean; models: RealtimeModels; serverMaxOutputTokens: number },
) {
  rejectUnknownCostFields(update);
  const next = structuredClone(current);

  if ("model" in update && update.model !== current.model) {
    reject("The realtime pipeline models are server-controlled.", "model");
  }
  if ("type" in update && update.type !== "realtime") {
    reject("Only realtime sessions are supported.", "type");
  }
  if ("instructions" in update) {
    if (typeof update.instructions !== "string" || update.instructions.length > 32_000) {
      reject("instructions must be a string no longer than 32000 characters.", "instructions");
    }
    next.instructions = update.instructions;
  }
  if ("output_modalities" in update) {
    if (!sameStringArray(update.output_modalities, ["audio"])) {
      reject("Only audio output is supported.", "output_modalities");
    }
  }
  if ("modalities" in update && !sameStringArray(update.modalities, ["audio"])) {
    reject("Only audio output is supported.", "modalities");
  }
  if ("tools" in update) next.tools = validateTools(update.tools);
  if ("tool_choice" in update) next.tool_choice = validateToolChoice(update.tool_choice, next.tools);
  if ("truncation" in update) {
    if (update.truncation === "retention_ratio" || isRetentionRatio(update.truncation)) {
      reject("retention_ratio truncation is not supported.", "truncation");
    }
    if (update.truncation !== "auto" && update.truncation !== "disabled") {
      reject("truncation must be auto or disabled.", "truncation");
    }
    next.truncation = update.truncation;
  }
  if ("max_output_tokens" in update) {
    if (update.max_output_tokens !== options.serverMaxOutputTokens) {
      reject("max_output_tokens is server-controlled.", "max_output_tokens");
    }
  }

  if ("audio" in update) {
    if (!isObject(update.audio)) reject("audio must be an object.", "audio");
    const audio = update.audio as JsonObject;
    if ("input" in audio) applyInputAudio(next, audio.input, options.models);
    if ("output" in audio) applyOutputAudio(next, audio.output, options.voiceLocked);
  }

  // GA clients may still send these top-level beta-compatible aliases.
  if ("input_audio_format" in update && update.input_audio_format !== "pcm16") {
    reject("Only mono PCM16 input at 24 kHz is supported.", "input_audio_format");
  }
  if ("output_audio_format" in update && update.output_audio_format !== "pcm16") {
    reject("Only mono PCM16 output at 24 kHz is supported.", "output_audio_format");
  }
  if ("voice" in update) setVoice(next, update.voice, options.voiceLocked, "voice");
  if ("turn_detection" in update) {
    next.audio.input.turn_detection = validateTurnDetection(update.turn_detection);
  }

  return next;
}

function applyInputAudio(
  next: RealtimeSessionConfig,
  input: unknown,
  models: RealtimeModels,
) {
  if (!isObject(input)) reject("audio.input must be an object.", "audio.input");
  const value = input as JsonObject;
  if ("format" in value && !isPcm24k(value.format)) {
    reject("Only mono PCM16 input at 24 kHz is supported.", "audio.input.format");
  }
  if ("transcription" in value && value.transcription !== null) {
    if (!isObject(value.transcription)) {
      reject("audio.input.transcription must be an object or null.", "audio.input.transcription");
    }
    const transcription = value.transcription as JsonObject;
    if ("model" in transcription && transcription.model !== models.stt) {
      reject("The transcription model is server-controlled.", "audio.input.transcription.model");
    }
  }
  if ("noise_reduction" in value && value.noise_reduction !== null) {
    reject("Input noise reduction is not supported.", "audio.input.noise_reduction");
  }
  if ("turn_detection" in value) {
    next.audio.input.turn_detection = validateTurnDetection(value.turn_detection);
  }
}

function applyOutputAudio(
  next: RealtimeSessionConfig,
  output: unknown,
  voiceLocked: boolean,
) {
  if (!isObject(output)) reject("audio.output must be an object.", "audio.output");
  const value = output as JsonObject;
  if ("format" in value && !isPcm24k(value.format)) {
    reject("Only mono PCM16 output at 24 kHz is supported.", "audio.output.format");
  }
  if ("voice" in value) setVoice(next, value.voice, voiceLocked, "audio.output.voice");
  if ("speed" in value && value.speed !== 1) {
    reject("Audio speed control is not supported.", "audio.output.speed");
  }
}

function setVoice(
  next: RealtimeSessionConfig,
  voice: unknown,
  locked: boolean,
  param: string,
) {
  if (typeof voice !== "string" || !voice.trim() || voice.length > 120) {
    reject("voice must be a non-empty string.", param);
  }
  if (locked && voice !== next.audio.output.voice) {
    reject("Voice cannot be changed after audio has been emitted.", param);
  }
  next.audio.output.voice = voice.trim();
}

function validateTurnDetection(value: unknown): TurnDetection {
  if (value === null) return null;
  if (!isObject(value)) reject("turn_detection must be server_vad or null.", "turn_detection");
  const turn = value as JsonObject;
  if (turn.type === "semantic_vad") {
    reject("semantic_vad is not supported.", "turn_detection.type");
  }
  if (turn.type !== "server_vad") {
    reject("turn_detection must be server_vad or null.", "turn_detection.type");
  }
  const result: Exclude<TurnDetection, null> = { type: "server_vad" };
  copyNumber(turn, result, "threshold", 0, 1);
  copyNumber(turn, result, "prefix_padding_ms", 0, 5000);
  copyNumber(turn, result, "silence_duration_ms", 100, 10_000);
  copyBoolean(turn, result, "create_response");
  copyBoolean(turn, result, "interrupt_response");
  return result;
}

function validateTools(value: unknown): RealtimeTool[] {
  if (!Array.isArray(value)) reject("tools must be an array.", "tools");
  return value.map((tool, index) => {
    if (!isObject(tool) || tool.type !== "function") {
      reject("Only client-executed function tools are supported.", `tools.${index}.type`);
    }
    if (typeof tool.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name)) {
      reject("Function tool names must contain 1 to 64 letters, numbers, underscores, or hyphens.", `tools.${index}.name`);
    }
    if (!isObject(tool.parameters)) {
      reject("Function tool parameters must be a JSON Schema object.", `tools.${index}.parameters`);
    }
    const parsed: RealtimeTool = {
      type: "function",
      name: tool.name,
      parameters: structuredClone(tool.parameters),
    };
    if (typeof tool.description === "string") parsed.description = tool.description.slice(0, 4000);
    return parsed;
  });
}

function validateToolChoice(
  value: unknown,
  tools: RealtimeTool[],
): RealtimeSessionConfig["tool_choice"] {
  if (value === "auto" || value === "none" || value === "required") return value;
  if (isObject(value) && value.type === "function" && typeof value.name === "string") {
    if (!tools.some((tool) => tool.name === value.name)) {
      reject("tool_choice references an unknown function.", "tool_choice.name");
    }
    return { type: "function", name: value.name };
  }
  reject("Unsupported tool_choice.", "tool_choice");
}

function rejectUnknownCostFields(update: JsonObject) {
  for (const key of Object.keys(update)) {
    if (!SESSION_UPDATE_FIELDS.has(key)) {
      reject(`${key} is not part of the supported Realtime session contract.`, key);
    }
  }
  for (const key of ["temperature", "reasoning", "prompt", "mcp_servers"]) {
    if (key in update && update[key] !== null) {
      reject(`${key} is not supported and cannot be ignored safely.`, key);
    }
  }
  if ("parallel_tool_calls" in update && update.parallel_tool_calls !== null) {
    reject("parallel_tool_calls is server-controlled.", "parallel_tool_calls");
  }
  if ("tracing" in update && update.tracing !== null) {
    reject("Tracing is not implemented by the realtime engine.", "tracing");
  }
  if ("include" in update) {
    const include = update.include;
    if (include !== null && (!Array.isArray(include) || include.length > 0)) {
      reject("Additional response fields are not supported.", "include");
    }
  }
}

function isPcm24k(value: unknown) {
  return value === "pcm16" || (isObject(value) && value.type === "audio/pcm" && value.rate === 24000);
}

function isRetentionRatio(value: unknown) {
  return isObject(value) && value.type === "retention_ratio";
}

function sameStringArray(value: unknown, expected: string[]) {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function copyNumber(
  source: JsonObject,
  target: Exclude<TurnDetection, null>,
  key: "threshold" | "prefix_padding_ms" | "silence_duration_ms",
  min: number,
  max: number,
) {
  if (!(key in source)) return;
  const value = source[key];
  if (typeof value !== "number" || value < min || value > max) {
    reject(`${key} must be between ${min} and ${max}.`, `turn_detection.${key}`);
  }
  target[key] = value;
}

function copyBoolean(
  source: JsonObject,
  target: Exclude<TurnDetection, null>,
  key: "create_response" | "interrupt_response",
) {
  if (!(key in source)) return;
  if (typeof source[key] !== "boolean") {
    reject(`${key} must be a boolean.`, `turn_detection.${key}`);
  }
  target[key] = source[key] as boolean;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function reject(message: string, param: string): never {
  throw new RealtimeProtocolError(message, "invalid_request_error", param);
}
