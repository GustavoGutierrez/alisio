/**
 * Provider usage parsing of cached input tokens (specs/012 protocol v2, `cachedInput`): the
 * OpenAI-compatible provider reports `cachedInput` only when the provider's usage carries it, in
 * any of the shapes it normalizes, and leaves it absent otherwise (absent means unknown, never 0).
 * The clients are fakes; no network.
 */
import { OpenAICompatibleProvider } from "@alisio/plugin-openai-compatible";
import type { ProviderEvent, Usage } from "@alisio/sdk";
import { describe, expect, it } from "vitest";

const request = {
  instructions: "system",
  messages: [{ role: "user" as const, text: "hello" }],
  tools: [],
  maxOutputTokens: 128,
  signal: AbortSignal.timeout(5000),
  model: "fixture",
};

const provider = (apiMode: "chat" | "responses", client: unknown) =>
  new OpenAICompatibleProvider(
    {
      baseURL: "https://example.invalid/v1",
      apiKey: "fake",
      apiKeyEnv: "UNUSED",
      model: "fixture",
      apiMode,
      auth: "bearer",
      tokenParameter: "max_tokens",
      streamUsage: true,
    },
    client as never,
  );

async function usageOf(p: OpenAICompatibleProvider): Promise<Usage | undefined> {
  const events: ProviderEvent[] = [];
  for await (const event of p.stream(request)) events.push(event);
  const completed = events.find((e) => e.type === "completed");
  return completed?.type === "completed" ? completed.usage : undefined;
}

const chat = (usage: Record<string, unknown>) =>
  provider("chat", {
    chat: {
      completions: {
        async create() {
          return (async function* () {
            yield { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] };
            yield { choices: [], usage };
          })();
        },
      },
    },
  });

const responses = (usage: Record<string, unknown>) =>
  provider("responses", {
    responses: {
      async create() {
        return (async function* () {
          yield { type: "response.completed", response: { output: [], usage } };
        })();
      },
    },
  });

describe("chat completions usage", () => {
  it.each([
    [
      "OpenAI prompt_tokens_details.cached_tokens",
      { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 60 } },
      { input: 100, output: 10, cachedInput: 60 },
    ],
    [
      "DeepSeek prompt_cache_hit_tokens",
      { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 80 },
      { input: 100, output: 10, cachedInput: 80 },
    ],
    [
      "an explicit zero is a report, not an omission",
      { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } },
      { input: 100, output: 10, cachedInput: 0 },
    ],
    [
      "no cache field at all: cachedInput stays absent",
      { prompt_tokens: 100, completion_tokens: 10 },
      { input: 100, output: 10 },
    ],
    [
      "a non-numeric cache field is ignored, not coerced",
      { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: "80" },
      { input: 100, output: 10 },
    ],
  ])("%s", async (_name, usage, expected) => {
    const result = await usageOf(chat(usage));
    expect(result).toEqual(expected);
    if (!("cachedInput" in expected)) expect(result).not.toHaveProperty("cachedInput");
  });
});

describe("responses API usage", () => {
  it("reads input_tokens_details.cached_tokens", async () => {
    expect(
      await usageOf(
        responses({
          input_tokens: 50,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 20 },
        }),
      ),
    ).toEqual({ input: 50, output: 5, cachedInput: 20 });
  });

  it("leaves cachedInput absent when the details are missing", async () => {
    const result = await usageOf(responses({ input_tokens: 50, output_tokens: 5 }));
    expect(result).toEqual({ input: 50, output: 5 });
    expect(result).not.toHaveProperty("cachedInput");
  });
});
