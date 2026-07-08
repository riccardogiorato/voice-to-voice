import {
  cleanTranscript,
  compactErrorBody,
  normalizeTranscript,
  streamTogetherText,
  TRANSCRIPT_REPAIR_MODEL,
  transcriptRepairPrompt,
} from "./voice-utils";

export async function repairTranscript(rawTranscript: string, signal: AbortSignal) {
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
