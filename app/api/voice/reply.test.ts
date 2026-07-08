import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateAssistantReply } from "./reply";
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
