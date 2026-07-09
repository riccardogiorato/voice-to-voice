import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  buildSystemMessageContent,
  extractTextToolCall,
  generateAssistantReply,
  stripToolMarkup,
} from "./reply";
import { setToolCallRunnerForTest } from "./tools";

const originalFetch = globalThis.fetch;
const originalTogetherKey = process.env.TOGETHER_API_KEY;
const originalExaKey = process.env.EXA_API_KEY;

beforeEach(() => {
  process.env.TOGETHER_API_KEY = "test-together-key";
  process.env.EXA_API_KEY = "test-exa-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setToolCallRunnerForTest(null);
  process.env.TOGETHER_API_KEY = originalTogetherKey;
  process.env.EXA_API_KEY = originalExaKey;
});

test("does not stream assistant text from a tool-call planning turn", async () => {
  let togetherCalls = 0;
  setToolCallRunnerForTest(async (toolCall) => {
    expect(toolCall).toMatchObject({
      id: "call_search",
      function: { name: "web_search" },
    });
    return JSON.stringify({
      query: "weather in Venice now",
      results: [
        {
          title: "Venice weather",
          url: "https://example.com/weather",
          highlights: ["Venice is mild and clear."],
          text: "Venice is mild and clear.",
        },
      ],
    });
  });

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (!url.includes("api.together.ai")) throw new Error(`Unexpected fetch: ${url}`);

    togetherCalls += 1;
    if (togetherCalls === 1) {
      return sseResponse([
        {
          choices: [
            {
              delta: {
                content: "I'll look that up.",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_search",
                    type: "function",
                    function: {
                      name: "web_search",
                      arguments: JSON.stringify({
                        query: "weather in Venice now",
                        num_results: 1,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        },
      ]);
    }

    expect(JSON.parse(String(init?.body)).messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call_search",
    });

    return sseResponse([
      { choices: [{ delta: { content: "Venice is mild and clear right now." } }] },
    ]);
  }) as typeof fetch;

  const deltas: string[] = [];
  const reply = await generateAssistantReply({
    history: [{ role: "user", content: "Check the weather in Venice." }],
    transcript: "Check the weather in Venice.",
    signal: new AbortController().signal,
    onDelta: (delta) => deltas.push(delta),
  });

  expect(reply).toBe("Venice is mild and clear right now.");
  expect(deltas).toEqual(["Venice is mild and clear right now."]);
  expect(togetherCalls).toBe(2);
});

test("strips a leading final channel marker from reply deltas", async () => {
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (!url.includes("api.together.ai")) throw new Error(`Unexpected fetch: ${url}`);

    return sseResponse([
      { choices: [{ delta: { content: "final" } }] },
      { choices: [{ delta: { content: "The alphabet is transcribing correctly." } }] },
    ]);
  }) as typeof fetch;

  const deltas: string[] = [];
  const reply = await generateAssistantReply({
    history: [{ role: "user", content: "Say if the alphabet test worked." }],
    transcript: "Say if the alphabet test worked.",
    signal: new AbortController().signal,
    onDelta: (delta) => deltas.push(delta),
  });

  expect(reply).toBe("The alphabet is transcribing correctly.");
  expect(deltas).toEqual(["The alphabet is transcribing correctly."]);
});

test("grounds the assistant prompt in the current date and requires search for current facts", () => {
  const prompt = buildSystemMessageContent(new Date("2026-07-09T12:00:00.000Z"));

  expect(prompt).toContain("Today is Thursday, July 9, 2026 (2026-07-09, UTC).");
  expect(prompt).toContain("current or recent facts");
  expect(prompt).toContain("sports");
  expect(prompt).toContain("Use web_search");
  expect(prompt).toContain("don't answer those from memory");
});

test("parses text-form tool calls instead of speaking their XML", () => {
  const toolCall = extractTextToolCall(`
<tool_call>
<function=web_search>
<parameter=query>
Love Island UK season 13 total episodes 2026
</parameter>
<parameter=num_results>
5
</parameter>
</function>
</tool_call>
`);

  expect(toolCall).toMatchObject({
    function: {
      name: "web_search",
      arguments: JSON.stringify({
        query: "Love Island UK season 13 total episodes 2026",
        num_results: 5,
      }),
    },
  });
});

test("removes text-form tool markup from visible assistant output", () => {
  expect(
    stripToolMarkup(
      "total </parameter>. <parameter=num_results>. 5. </parameter>.",
    ).trim(),
  ).toBe("");
  expect(
    stripToolMarkup(
      "<tool_call><function=web_search><parameter=query>x</parameter></function></tool_call>",
    ),
  ).toBe("");
});

function sseResponse(chunks: unknown[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
  );
}
