import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  buildSystemMessageContent,
  extractTextToolCall,
  generateAssistantReply,
  parseReplyLanguagePrefix,
  stripAssistantMarkdown,
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

    const messages = JSON.parse(String(init?.body)).messages;
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_search",
      }),
    );
    expect(messages.at(-1)).toMatchObject({
      role: "system",
      content: expect.stringContaining("<lang:xx>"),
    });

    return sseResponse([
      { choices: [{ delta: { content: "<lang:it>Venezia è mite e serena." } }] },
    ]);
  }) as typeof fetch;

  const deltas: string[] = [];
  const languages: string[] = [];
  const toolActivities: unknown[] = [];
  const reply = await generateAssistantReply({
    history: [{ role: "user", content: "Check the weather in Venice." }],
    transcript: "Check the weather in Venice.",
    signal: new AbortController().signal,
    onDelta: (delta) => deltas.push(delta),
    onLanguage: (language) => languages.push(language),
    onToolActivity: (activity) => toolActivities.push(activity),
  });

  expect(reply).toBe("Venezia è mite e serena.");
  expect(deltas).toEqual(["Venezia è mite e serena."]);
  expect(languages).toEqual(["it"]);
  expect(toolActivities).toEqual([
    {
      id: "call_search",
      name: "web_search",
      status: "running",
      input: "weather in Venice now",
    },
    {
      id: "call_search",
      name: "web_search",
      status: "completed",
      input: "weather in Venice now",
      summary: "1 result: Venice weather",
    },
  ]);
  expect(togetherCalls).toBe(2);
});

test("does not reset the active voice when a final answer omits its language tag", async () => {
  process.env.EXA_API_KEY = "";
  globalThis.fetch = (async (_input) =>
    sseResponse([
      { choices: [{ delta: { content: "Il Mondiale è ancora in corso." } }] },
    ])) as typeof fetch;

  const languages: string[] = [];
  const reply = await generateAssistantReply({
    history: [{ role: "user", content: "Chi ha vinto i mondiali?" }],
    transcript: "Chi ha vinto i mondiali?",
    signal: new AbortController().signal,
    onLanguage: (language) => languages.push(language),
    onDelta: () => {},
  });

  expect(reply).toBe("Il Mondiale è ancora in corso.");
  expect(languages).toEqual([]);
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

test("streams plain spoken text when the model emits markdown", async () => {
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (!url.includes("api.together.ai")) throw new Error(`Unexpected fetch: ${url}`);

    return sseResponse([
      { choices: [{ delta: { content: "The **" } }] },
      { choices: [{ delta: { content: "short answer" } }] },
      { choices: [{ delta: { content: "** is `yes`." } }] },
    ]);
  }) as typeof fetch;

  const deltas: string[] = [];
  const reply = await generateAssistantReply({
    history: [{ role: "user", content: "Can I use this?" }],
    transcript: "Can I use this?",
    signal: new AbortController().signal,
    onDelta: (delta) => deltas.push(delta),
  });

  expect(reply).toBe("The short answer is yes.");
  expect(deltas.join("")).toBe("The short answer is yes.");
  expect(deltas.join("")).not.toContain("*");
  expect(deltas.join("")).not.toContain("`");
});

test("extracts a split model language tag before streaming spoken text", async () => {
  process.env.EXA_API_KEY = "";
  globalThis.fetch = (async (_input) =>
    sseResponse([
      { choices: [{ delta: { content: "<la" } }] },
      { choices: [{ delta: { content: "ng:it>" } }] },
      { choices: [{ delta: { content: "Certo, posso aiutarti." } }] },
      { choices: [{ delta: { content: " </lang" } }] },
      { choices: [{ delta: { content: ":it>" } }] },
    ])) as typeof fetch;

  const events: string[] = [];
  const reply = await generateAssistantReply({
    history: [{ role: "user", content: "Puoi aiutarmi?" }],
    transcript: "Puoi aiutarmi?",
    signal: new AbortController().signal,
    onLanguage: (language) => events.push(`language:${language}`),
    onDelta: (delta) => events.push(`text:${delta}`),
  });

  expect(reply).toBe("Certo, posso aiutarti.");
  expect(events).toEqual(["language:it", "text:Certo, posso aiutarti."]);
});

test("accepts locale tags and hides malformed language metadata", () => {
  expect(parseReplyLanguagePrefix("<lang:pt-br> Olá!")).toEqual({
    pending: false,
    language: "pt-br",
    content: "Olá!",
  });
  expect(parseReplyLanguagePrefix("<lang:Italian> Ciao!")).toEqual({
    pending: false,
    language: null,
    content: "Ciao!",
  });
});

test("grounds the assistant prompt in the current date without encouraging unnecessary search", () => {
  const prompt = buildSystemMessageContent(
    new Date("2026-07-10T12:00:00.000Z"),
    { timeZone: "Europe/Rome", city: "Rome", country: "IT" },
  );

  expect(prompt).toContain("CURRENT DATE: Friday July 10, 2026 (UTC).");
  expect(prompt).toContain("USER TIME ZONE: Europe/Rome.");
  expect(prompt).not.toContain("USER APPROXIMATE LOCATION");
  expect(prompt).toContain("call get_current_time");
  expect(prompt).toContain("Do not use web search as a clock");
  expect(prompt).toContain("Call get_user_location only when");
  expect(prompt).not.toMatch(/IP-derived|IP address|request headers/i);
  expect(prompt).toContain("Web search rules:\n-");
  expect(prompt).toContain("Search for current facts or explicit lookup");
  expect(prompt).toContain("Always search: news, live or recent sports");
  expect(prompt).toContain("Do not search: casual or creative requests");
  expect(prompt).toContain("your identity or capabilities");
  expect(prompt).toContain("<lang:xx>");
  expect(prompt).toContain("Never output a closing language tag");
  expect(prompt).toContain("include 2026 in the query");
  expect(prompt).toContain("Never use an older year from memory");
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

test("strips assistant markdown without changing plain speech", () => {
  expect(stripAssistantMarkdown("**Yes**, use `voice mode`.")).toBe(
    "Yes, use voice mode.",
  );
  expect(stripAssistantMarkdown("- first\n- second")).toBe("first second");
  expect(stripAssistantMarkdown("[Together](https://together.ai) works.")).toBe(
    "Together works.",
  );
  expect(stripAssistantMarkdown("Fast\u2014but plain.")).toBe("Fast, but plain.");
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
