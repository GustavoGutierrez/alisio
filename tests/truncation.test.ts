import { DeepSeekProvider } from "@alisio/plugin-deepseek";
import { OpenAICompatibleProvider } from "@alisio/plugin-openai-compatible";
import { OpenCodeProvider } from "@alisio/plugin-opencode";
import { OpenCodeGoProvider } from "@alisio/plugin-opencode-go";
import type { ModelProvider, ProviderEvent } from "@alisio/sdk";
import { describe, expect, it, vi } from "vitest";

const sse = (events: unknown[]) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );

const request = (model: string) => ({
  instructions: "system",
  messages: [{ role: "user" as const, text: "hello" }],
  tools: [],
  maxOutputTokens: 128,
  signal: AbortSignal.timeout(5000),
  model,
});

const collect = async (provider: ModelProvider, model: string) => {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(request(model))) events.push(event);
  return events;
};

/** A chat-completions chunk helper for the OpenAI SDK-shaped clients. */
const chatChunk = (text: string, finish_reason: string | null) => ({
  choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason }],
});

const openAICompatible = (client: unknown) =>
  new OpenAICompatibleProvider(
    {
      baseURL: "https://example.invalid/v1",
      apiKey: "fake",
      apiKeyEnv: "UNUSED",
      model: "fixture",
      apiMode: "chat",
      auth: "bearer",
      tokenParameter: "max_tokens",
      streamUsage: false,
    },
    client as any,
  );

const deepseek = (client: unknown, apiMode: "chat" | "responses" = "chat") =>
  new DeepSeekProvider(
    {
      baseURL: "https://api.deepseek.com",
      apiKey: "fake",
      apiKeyEnv: "UNUSED",
      model: "fixture",
      apiMode,
      auth: "bearer",
      tokenParameter: "max_tokens",
      streamUsage: false,
    },
    client as any,
  );

const openCode = (model: string, fetchMock: typeof fetch, go = false) =>
  go
    ? new OpenCodeGoProvider({
        apiKey: "fake",
        model,
        baseURL: "http://127.0.0.1/v1",
        fetch: fetchMock,
      })
    : new OpenCodeProvider({
        apiKey: "fake",
        model,
        baseURL: "http://127.0.0.1/v1",
        fetch: fetchMock,
      });

describe("chat completions: finish_reason length", () => {
  const client = (events: unknown[]) => ({
    models: { async *list() {} },
    chat: {
      completions: {
        async create() {
          return clientStream(events);
        },
      },
    },
  });
  const clientStream = (events: unknown[]) =>
    (async function* () {
      for (const event of events) yield event;
    })();

  it("emits a completed+truncated message when text was produced", async () => {
    const provider = openAICompatible(
      client([{ ...chatChunk("partial ", null) }, { ...chatChunk("answer", "length") }]),
    );
    const events = await collect(provider, "fixture");
    expect(events).toEqual([
      { type: "text_delta", delta: "partial " },
      { type: "text_delta", delta: "answer" },
      {
        type: "completed",
        message: { role: "assistant", text: "partial answer", calls: [], truncated: true },
      },
    ]);
  });

  it("deepseek chat: finish length after text also completes truncated", async () => {
    const provider = deepseek(
      client([{ ...chatChunk("partial ", null) }, { ...chatChunk("answer", "length") }]),
    );
    const events = await collect(provider, "fixture");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      message: { role: "assistant", text: "partial answer", calls: [], truncated: true },
    });
  });

  it.each([
    ["deepseek (chat)", deepseek(client([{ ...chatChunk("", "length") }]))],
    [
      "deepseek (responses)",
      deepseek(
        {
          responses: {
            async create() {
              return (async function* () {
                yield { type: "response.incomplete", response: { output: [] } };
              })();
            },
          },
        },
        "responses",
      ),
    ],
  ] as const)("%s keeps throwing on length with nothing usable", async (_name, provider) => {
    await expect(collect(provider, "fixture")).rejects.toThrow(/max output tokens/);
  });

  it("throws on length with empty text", async () => {
    const provider = openAICompatible(client([{ ...chatChunk("", "length") }]));
    await expect(collect(provider, "fixture")).rejects.toThrow(/max output tokens/);
  });

  it("throws on length with a partial (unfinished) tool call", async () => {
    const provider = openAICompatible(
      client([
        {
          choices: [
            {
              index: 0,
              delta: {
                content: "trying a tool",
                tool_calls: [{ index: 0, id: "c1", function: { arguments: '{"x":' } }],
              },
              finish_reason: "length",
            },
          ],
        },
      ]),
    );
    await expect(collect(provider, "fixture")).rejects.toThrow(/Incomplete tool call/);
  });

  it("keeps throwing when the stream just ends without a finish reason", async () => {
    const provider = openAICompatible(client([{ ...chatChunk("partial", null) }]));
    await expect(collect(provider, "fixture")).rejects.toThrow(/incomplete/);
  });

  it("keeps normal stop and tool_calls unchanged", async () => {
    const stop = openAICompatible(client([{ ...chatChunk("done", "stop") }]));
    const stopEvents = await collect(stop, "fixture");
    expect(stopEvents.at(-1)).toEqual({
      type: "completed",
      message: { role: "assistant", text: "done", calls: [] },
    });
    const calls = openAICompatible(
      client([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: "c1", function: { name: "echo", arguments: "{}" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]),
    );
    const callEvents = await collect(calls, "fixture");
    expect(callEvents.at(-1)).toMatchObject({
      type: "completed",
      message: { calls: [{ id: "c1", name: "echo", arguments: "{}" }] },
    });
    expect(callEvents.at(-1)).not.toHaveProperty("truncated");
  });
});

describe("responses API: response.incomplete", () => {
  const responsesClient = (events: unknown[]) => ({
    responses: {
      async create() {
        return (async function* () {
          for (const event of events) yield event;
        })();
      },
    },
  });
  const incomplete = (output: unknown[]) => ({
    type: "response.incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    response: { output },
  });
  const message = (text: string) => [{ type: "message", content: [{ type: "output_text", text }] }];

  it("emits completed+truncated when partial output text exists", async () => {
    const provider = deepseek(
      responsesClient([incomplete(message("partial answer"))]),
      "responses",
    );
    const events = await collect(provider, "fixture");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      message: { role: "assistant", text: "partial answer", calls: [], truncated: true },
    });
  });

  it("throws when the incomplete response carries no usable text", async () => {
    const provider = deepseek(responsesClient([incomplete([])]), "responses");
    await expect(collect(provider, "fixture")).rejects.toThrow(/max output tokens/);
  });

  it("throws on an incomplete response with a partial function call", async () => {
    const provider = deepseek(
      responsesClient([
        incomplete([
          ...message("calling"),
          { type: "function_call", call_id: "c1", arguments: '{"x":' },
        ]),
      ]),
      "responses",
    );
    await expect(collect(provider, "fixture")).rejects.toThrow(/Incomplete tool call/);
  });
});

describe("OpenCode providers", () => {
  it("chat: length with text completes truncated; length with empty text throws", async () => {
    const fetchMock = vi.fn(async () =>
      sse([{ choices: [{ delta: { content: "partial" }, finish_reason: "length" }] }]),
    );
    const provider = openCode("deepseek-v4-pro", fetchMock as typeof fetch);
    const events = await collect(provider, "deepseek-v4-pro");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      message: { text: "partial", truncated: true },
    });

    const emptyMock = vi.fn(async () =>
      sse([{ choices: [{ delta: { content: "" }, finish_reason: "length" }] }]),
    );
    const emptyProvider = openCode("deepseek-v4-pro", emptyMock as typeof fetch);
    await expect(collect(emptyProvider, "deepseek-v4-pro")).rejects.toThrow(/max output tokens/);
  });

  it("chat: length with a partial tool call throws", async () => {
    const fetchMock = vi.fn(async () =>
      sse([
        {
          choices: [
            {
              delta: {
                content: "trying",
                tool_calls: [{ index: 0, id: "c1", function: { arguments: '{"x":' } }],
              },
              finish_reason: "length",
            },
          ],
        },
      ]),
    );
    const provider = openCode("deepseek-v4-pro", fetchMock as typeof fetch);
    await expect(collect(provider, "deepseek-v4-pro")).rejects.toThrow(/Incomplete tool call/);
  });

  it("responses: response.incomplete with text completes truncated", async () => {
    const fetchMock = vi.fn(async () =>
      sse([
        {
          type: "response.incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          response: {
            output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }],
          },
        },
      ]),
    );
    const provider = openCode("gpt-6-sol", fetchMock as typeof fetch);
    const events = await collect(provider, "gpt-6-sol");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      message: { text: "partial", truncated: true },
    });
  });

  it("messages: stop_reason max_tokens with text completes truncated", async () => {
    const fetchMock = vi.fn(async () =>
      sse([
        { type: "message_start", message: { usage: { input_tokens: 2 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
        {
          type: "message_delta",
          delta: { stop_reason: "max_tokens" },
          usage: { output_tokens: 1 },
        },
      ]),
    );
    const provider = openCode("claude-sonnet-5", fetchMock as typeof fetch);
    const events = await collect(provider, "claude-sonnet-5");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      message: { text: "partial", truncated: true },
    });
  });

  it("messages: max_tokens with a cut tool-call argument throws", async () => {
    const fetchMock = vi.fn(async () =>
      sse([
        { type: "message_start", message: { usage: { input_tokens: 2 } } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "c1", name: "echo", input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"x":' },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "max_tokens" },
          usage: { output_tokens: 1 },
        },
      ]),
    );
    const provider = openCode("claude-sonnet-5", fetchMock as typeof fetch);
    await expect(collect(provider, "claude-sonnet-5")).rejects.toThrow(/cut off/);
  });

  it("messages: max_tokens with no text and no calls throws", async () => {
    const fetchMock = vi.fn(async () =>
      sse([
        { type: "message_start", message: { usage: { input_tokens: 2 } } },
        {
          type: "message_delta",
          delta: { stop_reason: "max_tokens" },
          usage: { output_tokens: 1 },
        },
      ]),
    );
    const provider = openCode("claude-sonnet-5", fetchMock as typeof fetch);
    await expect(collect(provider, "claude-sonnet-5")).rejects.toThrow(/max output tokens/);
  });

  it("opencode-go chat mirror keeps parity", async () => {
    const fetchMock = vi.fn(async () =>
      sse([{ choices: [{ delta: { content: "partial" }, finish_reason: "length" }] }]),
    );
    const provider = openCode("glm-5.3", fetchMock as typeof fetch, true);
    const events = await collect(provider, "glm-5.3");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      message: { text: "partial", truncated: true },
    });
  });

  it("opencode-go responses: incomplete after text completes truncated", async () => {
    const fetchMock = vi.fn(async () =>
      sse([
        { type: "response.output_text.delta", delta: "partial " },
        { type: "response.output_text.delta", delta: "answer" },
        {
          type: "response.incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          response: {
            output: [
              { type: "message", content: [{ type: "output_text", text: "partial answer" }] },
            ],
          },
        },
      ]),
    );
    const provider = openCode("gpt-5.6-luna", fetchMock as typeof fetch, true);
    const events = await collect(provider, "gpt-5.6-luna");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      message: { text: "partial answer", truncated: true },
    });
  });

  it("opencode-go responses: incomplete before any text throws actionably", async () => {
    const fetchMock = vi.fn(async () =>
      sse([
        {
          type: "response.incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          response: { output: [] },
        },
      ]),
    );
    const provider = openCode("gpt-5.6-luna", fetchMock as typeof fetch, true);
    await expect(collect(provider, "gpt-5.6-luna")).rejects.toThrow(/max output tokens/);
  });
});
