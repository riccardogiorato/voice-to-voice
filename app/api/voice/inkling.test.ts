import { afterEach, expect, test } from "bun:test";
import {
  buildInklingAudioRequest,
  buildInklingSystemPrompt,
  createInklingAudioCompletion,
  generateInklingVoiceTurn,
  getTogetherModelAvailability,
  parseInklingVoiceResponse,
  pcm16ToWav,
  readPcmWavMetadata,
  TOGETHER_INKLING_MODEL,
} from "./inkling";
import { setToolCallRunnerForTest } from "./tools";

const originalExaKey = process.env.EXA_API_KEY;

afterEach(() => {
  process.env.EXA_API_KEY = originalExaKey;
  setToolCallRunnerForTest(null);
});

test("builds the official OpenAI-compatible Inkling audio content shape", () => {
  const request = buildInklingAudioRequest({
    audio: {
      data: "UklGRg==",
      format: "wav",
      numFrames: 16_000,
      sampleRate: 16_000,
    },
    instruction: "Answer the spoken request directly.",
    maxTokens: 128,
    system: "Keep the answer concise.",
  });

  expect(request).toEqual({
    model: TOGETHER_INKLING_MODEL,
    messages: [
      { role: "system", content: "Keep the answer concise." },
      {
        role: "user",
        content: [
          { type: "text", text: "Answer the spoken request directly." },
          {
            type: "input_audio",
            input_audio: {
              data: "UklGRg==",
              format: "wav",
              num_frames: 16_000,
              sample_rate: 16_000,
            },
          },
        ],
      },
    ],
    max_tokens: 128,
    reasoning_effort: "low",
    stream: false,
  });
});

test("parses Inkling's transcript and language-prefixed reply", () => {
  expect(
    parseInklingVoiceResponse(
      "<transcript>Hello, how are you?</transcript>\n<lang:en>I'm well, thanks!</lang:en>",
    ),
  ).toEqual({
    transcript: "Hello, how are you?",
    language: "en",
    reply: "I'm well, thanks!",
  });
});

test("rejects a response that does not include the spoken transcript", () => {
  expect(() => parseInklingVoiceResponse("<lang:en>Hello!")).toThrow(
    "Together Inkling returned no transcript.",
  );
});

test("describes Inkling as audio understanding while keeping TTS separate", () => {
  const prompt = buildInklingSystemPrompt();

  expect(prompt).toContain("understand the user's latest speech directly");
  expect(prompt).toContain("separate text-to-speech model");
  expect(prompt).toContain("Do not call or propose tools");
  expect(prompt).toContain("app routes any required live lookup");
});

test("wraps browser PCM16 in a WAV container with correct metadata", () => {
  const pcm = new Uint8Array(32_000);
  const wav = pcm16ToWav(pcm, 16_000, 1);

  expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
  expect(readPcmWavMetadata(wav)).toEqual({
    bitsPerSample: 16,
    channels: 1,
    dataBytes: 32_000,
    numFrames: 16_000,
    sampleRate: 16_000,
  });
});

test("detects whether Inkling is in Together's live model catalog", async () => {
  const live = await getTogetherModelAvailability({
    apiKey: "test-key",
    fetchImpl: mockFetch([
      { id: "Qwen/Qwen3.5-9B" },
      { id: TOGETHER_INKLING_MODEL, type: "chat" },
    ]),
  });
  const absent = await getTogetherModelAvailability({
    apiKey: "test-key",
    fetchImpl: mockFetch({ data: [{ id: "Qwen/Qwen3.5-9B" }] }),
  });

  expect(live).toEqual({
    available: true,
    model: { id: TOGETHER_INKLING_MODEL, type: "chat" },
  });
  expect(absent).toEqual({ available: false, model: null });
});

test("reads the text response from a non-streaming Inkling completion", async () => {
  let sentBody: unknown;
  const request = buildInklingAudioRequest({
    audio: {
      data: "UklGRg==",
      format: "wav",
      numFrames: 1,
      sampleRate: 16_000,
    },
    instruction: "Answer the audio.",
  });

  const completion = await createInklingAudioCompletion({
    apiKey: "test-key",
    request,
    fetchImpl: (async (_input, init) => {
      sentBody = JSON.parse(String(init?.body));
      return Response.json({
        choices: [{ message: { content: "The audio says hello." } }],
      });
    }) as typeof fetch,
  });

  expect(sentBody).toEqual(request);
  expect(completion).toEqual({
    content: "The audio says hello.",
    toolCalls: [],
  });
});

test("runs one audio completion for both transcript and reply", async () => {
  let sentBody: any;
  const result = await generateInklingVoiceTurn({
    apiKey: "test-key",
    history: [{ role: "assistant", content: "Previous answer" }],
    pcm16: new Uint8Array([0, 0, 1, 0]),
    signal: new AbortController().signal,
    fetchImpl: (async (_input, init) => {
      sentBody = JSON.parse(String(init?.body));
      return Response.json({
        choices: [
          {
            message: {
              content:
                "<transcript>Hello there</transcript>\n<lang:en>Hi! Nice to hear from you.",
            },
          },
        ],
      });
    }) as typeof fetch,
  });

  expect(result).toEqual({
    transcript: "Hello there",
    language: "en",
    reply: "Hi! Nice to hear from you.",
  });
  expect(sentBody.model).toBe(TOGETHER_INKLING_MODEL);
  expect(sentBody.reasoning_effort).toBe("low");
  expect(sentBody.messages.at(-1).content[1].type).toBe("input_audio");
});

test("runs Inkling tools and returns the final transcript and reply", async () => {
  process.env.EXA_API_KEY = "test-exa-key";
  const requests: any[] = [];
  const activities: any[] = [];
  const responses = [
    {
      choices: [
        {
          message: {
            content:
              "<transcript>What are the latest Together AI models?</transcript>\n" +
              "<lang:en>I don't have the latest model list.",
          },
        },
      ],
    },
    {
      choices: [
        {
          message: {
            content:
              "<transcript>What are the latest Together AI models?</transcript>\n" +
              "<lang:en>Inkling is now available on Together AI Serverless.",
          },
        },
      ],
    },
  ];
  setToolCallRunnerForTest(() =>
    JSON.stringify({ results: [{ title: "Inkling is live" }] }),
  );

  const result = await generateInklingVoiceTurn({
    apiKey: "test-key",
    history: [],
    pcm16: new Uint8Array([0, 0, 1, 0]),
    signal: new AbortController().signal,
    onToolActivity: (activity) => activities.push(activity),
    fetchImpl: (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json(responses[requests.length - 1]);
    }) as typeof fetch,
  });

  expect(requests).toHaveLength(2);
  expect(requests[0].tool_choice).toBeUndefined();
  expect(requests[0].tools).toBeUndefined();
  expect(requests[1].tools).toBeUndefined();
  expect(requests[1].tool_choice).toBe("none");
  expect(requests[1].messages.at(-2)).toEqual({
    role: "tool",
    tool_call_id: expect.stringContaining("web-search-"),
    content: JSON.stringify({ results: [{ title: "Inkling is live" }] }),
  });
  expect(activities).toEqual([
    {
      id: expect.stringContaining("web-search-"),
      name: "web_search",
      input: "What are the latest Together AI models 2026",
      status: "running",
    },
    {
      id: expect.stringContaining("web-search-"),
      name: "web_search",
      input: "What are the latest Together AI models 2026",
      status: "completed",
      summary: "1 result: Inkling is live",
    },
  ]);
  expect(result).toEqual({
    transcript: "What are the latest Together AI models?",
    language: "en",
    reply: "Inkling is now available on Together AI Serverless.",
  });
});

test("routes a latest sports request to web search instead of current time", async () => {
  process.env.EXA_API_KEY = "test-exa-key";
  const requests: any[] = [];
  const activities: any[] = [];
  const responses = [
    {
      choices: [
        {
          message: {
            content:
              "<transcript>Can you tell me the latest matches from the World Cup?</transcript>\n" +
              "<lang:en>The World Cup is not being held right now.",
          },
        },
      ],
    },
    {
      choices: [
        {
          message: {
            content:
              "<transcript>Can you tell me the latest matches from the World Cup?</transcript>\n" +
              "<lang:en>Portugal beat Uzbekistan 3–0 in their latest group match.",
          },
        },
      ],
    },
  ];
  setToolCallRunnerForTest(() =>
    JSON.stringify({
      results: [{ title: "Portugal 3–0 Uzbekistan", text: "World Cup result" }],
    }),
  );

  const result = await generateInklingVoiceTurn({
    apiKey: "test-key",
    history: [],
    pcm16: new Uint8Array([0, 0, 1, 0]),
    signal: new AbortController().signal,
    userContext: { timeZone: "Europe/Rome" },
    onToolActivity: (activity) => activities.push(activity),
    fetchImpl: (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json(responses[requests.length - 1]);
    }) as typeof fetch,
  });

  expect(requests).toHaveLength(2);
  expect(requests[0].tools).toBeUndefined();
  expect(requests[1].messages.at(-2).tool_call_id).toStartWith("web-search-");
  expect(activities.map((activity) => activity.name)).toEqual([
    "web_search",
    "web_search",
  ]);
  expect(result.reply).toContain("Portugal");
});

test("does not run a tool for an identity question", async () => {
  process.env.EXA_API_KEY = "test-exa-key";
  const requests: any[] = [];
  const activities: any[] = [];

  const result = await generateInklingVoiceTurn({
    apiKey: "test-key",
    history: [],
    pcm16: new Uint8Array([0, 0, 1, 0]),
    signal: new AbortController().signal,
    onToolActivity: (activity) => activities.push(activity),
    fetchImpl: (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        choices: [
          {
            message: {
              content:
                "<transcript>What's your name?</transcript>\n" +
                "<lang:en>I'm Inkling, your voice assistant.",
            },
          },
        ],
      });
    }) as typeof fetch,
  });

  expect(requests).toHaveLength(1);
  expect(requests[0].tools).toBeUndefined();
  expect(activities).toEqual([]);
  expect(result.reply).toBe("I'm Inkling, your voice assistant.");
});

function mockFetch(payload: unknown) {
  return (async () => Response.json(payload)) as unknown as typeof fetch;
}
