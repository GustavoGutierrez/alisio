import { OpenAICompatibleProvider } from "@alisio/plugin-openai-compatible";
import type { ModelProvider, ProviderEvent } from "@alisio/sdk";
import { describe, expect, it } from "vitest";

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
    client as never,
  );

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

  it("reports length with empty text as a truncated completion instead of throwing", async () => {
    const provider = openAICompatible(client([{ ...chatChunk("", "length") }]));
    const events = await collect(provider, "fixture");
    expect(events.at(-1)).toEqual({
      type: "completed",
      message: { role: "assistant", text: "", calls: [], truncated: true },
    });
  });

  it("reports a partial (unfinished) tool call on length as truncated and leaves it to the host", async () => {
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
    const events = await collect(provider, "fixture");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      message: { truncated: true, calls: [{ id: "c1", name: "", arguments: '{"x":' }] },
    });
  });

  it("still throws on an incomplete tool call when the model did not hit the length limit", async () => {
    const provider = openAICompatible(
      client([
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: "c1", function: { arguments: "{}" } }] },
              finish_reason: "tool_calls",
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
