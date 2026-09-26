import { inspect } from "node:util";
import { createDeepSeekPlugin, DeepSeekProvider } from "@alisio/plugin-deepseek";
import { OpenAICompatibleProvider } from "@alisio/plugin-openai-compatible";
import {
  classifyOpenCodeModel,
  createOpenCodePlugin,
  OpenCodeProvider,
} from "@alisio/plugin-opencode";
import {
  classifyOpenCodeGoModel,
  createOpenCodeGoPlugin,
  OpenCodeGoProvider,
} from "@alisio/plugin-opencode-go";
import type { ModelProvider, Plugin, ProviderRegistration } from "@alisio/sdk";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_PLUGINS } from "../packages/cli/src/builtin.ts";

const sse = (events: unknown[]) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
const request = (model: string, sessionId = "00000000-0000-4000-8000-000000000001") => ({
  instructions: "system",
  messages: [{ role: "user" as const, text: "hello" }],
  tools: [
    {
      name: "echo",
      description: "Echo",
      inputSchema: { type: "object" },
      async execute() {
        return { content: [] };
      },
    },
  ],
  maxOutputTokens: 128,
  signal: AbortSignal.timeout(5000),
  model,
  sessionId,
});
const collect = async (provider: ModelProvider, model: string) => {
  const events = [];
  for await (const event of provider.stream(request(model))) events.push(event);
  return events;
};
const registration = (plugin: Plugin): ProviderRegistration => {
  let found: ProviderRegistration | undefined;
  plugin.setup({
    providers: {
      register(value: ProviderRegistration) {
        found = value;
        return () => {};
      },
    },
  } as any);
  if (!found) throw new Error("provider was not registered");
  return found;
};

it("registers all dedicated providers as default CLI built-ins", () => {
  expect(BUILTIN_PLUGINS.map((plugin) => plugin.id)).toEqual(
    expect.arrayContaining(["deepseek", "opencode", "opencode-go", "openai-compatible"]),
  );
});

describe("DeepSeek provider", () => {
  it("registers dedicated masked credentials and provider-specific defaults", () => {
    const value = registration(createDeepSeekPlugin());
    expect(value.id).toBe("deepseek");
    expect(value.fields.find((field) => field.key === "apiKey")).toMatchObject({
      kind: "secret",
      required: true,
    });
    expect(value.fields.find((field) => field.key === "baseURL")?.defaultValue).toBe(
      "https://api.deepseek.com",
    );
  });

  it("parses the exact official catalog metadata shape", async () => {
    const fakeKey = "fake-deepseek-key";
    const client = {
      models: {
        async *list() {
          yield {
            id: "deepseek-flash",
            object: "model",
            owned_by: "deepseek",
            name: "Flash",
            context_window: 1000000,
            max_output_tokens: 64000,
            input_modalities: ["text", "image"],
            output_modalities: ["text"],
            api_capabilities: {
              anthropic_messages: { system_prompt_update: "in-history" },
            },
            effort: { supported_levels: ["low", "high"], default_level: "high" },
          };
        },
      },
    };
    const provider = new DeepSeekProvider(
      {
        baseURL: "https://api.deepseek.com",
        apiKey: fakeKey,
        apiKeyEnv: "UNUSED",
        model: "deepseek-flash",
        apiMode: "chat",
        auth: "bearer",
        tokenParameter: "max_tokens",
        streamUsage: true,
      },
      client as any,
    );
    expect(await provider.listModels(AbortSignal.timeout(1000))).toEqual([
      {
        id: "deepseek-flash",
        ownedBy: "deepseek",
        name: "Flash",
        contextWindow: 1000000,
        maxOutputTokens: 64000,
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        apiCapabilities: {
          anthropic_messages: { system_prompt_update: "in-history" },
        },
        effort: { supportedLevels: ["low", "high"], defaultLevel: "high" },
      },
    ]);
    expect(JSON.stringify(provider)).not.toContain(fakeKey);
  });

  it.each(["chat", "responses"] as const)(
    "streams tools and continuation in %s mode",
    async (mode) => {
      let calls = 0;
      const client = {
        models: { async *list() {} },
        chat: {
          completions: {
            async create() {
              calls++;
              return (async function* () {
                yield {
                  choices: [
                    {
                      delta: {
                        reasoning_content: "think",
                        tool_calls: [
                          { index: 0, id: "call-1", function: { name: "echo", arguments: "{}" } },
                        ],
                      },
                      finish_reason: "tool_calls",
                    },
                  ],
                };
              })();
            },
          },
        },
        responses: {
          async create() {
            calls++;
            return (async function* () {
              yield {
                type: "response.completed",
                response: {
                  output: [
                    { type: "function_call", call_id: "call-1", name: "echo", arguments: "{}" },
                  ],
                },
              };
            })();
          },
        },
      };
      const provider = new DeepSeekProvider(
        {
          baseURL: "https://api.deepseek.com",
          apiKey: "fake",
          apiKeyEnv: "UNUSED",
          model: "deepseek-flash",
          apiMode: mode,
          auth: "bearer",
          tokenParameter: "max_tokens",
          streamUsage: true,
        },
        client as any,
      );
      const events = await collect(provider, "deepseek-flash");
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        message: { calls: [{ id: "call-1", name: "echo", arguments: "{}" }] },
      });
      expect(calls).toBe(1);
    },
  );

  it("emits official Responses reasoning text and supported summary deltas", async () => {
    const client = {
      responses: {
        async create() {
          return (async function* () {
            yield { type: "response.reasoning_text.delta", delta: "private-visible" };
            yield { type: "response.reasoning_summary_text.delta", delta: "summary" };
            yield { type: "response.completed", response: { output: [] } };
          })();
        },
      },
    };
    const provider = new DeepSeekProvider(
      {
        baseURL: "https://api.deepseek.com",
        apiKey: "fake",
        apiKeyEnv: "UNUSED",
        model: "deepseek-reasoner",
        apiMode: "responses",
        auth: "bearer",
        tokenParameter: "max_tokens",
        streamUsage: true,
      },
      client as any,
    );
    expect(await collect(provider, "deepseek-reasoner")).toEqual([
      { type: "reasoning_delta", delta: "private-visible" },
      { type: "reasoning_delta", delta: "summary" },
      { type: "completed", message: { role: "assistant", text: "", calls: [], providerData: [] } },
    ]);
  });
});

describe("provider credential encapsulation", () => {
  const expectHidden = (provider: ModelProvider, fakeKey: string) => {
    expect(inspect(provider, { showHidden: true, depth: 8 })).not.toContain(fakeKey);
    expect(JSON.stringify(provider)).not.toContain(fakeKey);
    expect(Object.keys(provider).map((key) => inspect((provider as any)[key]))).not.toContain(
      expect.stringContaining(fakeKey),
    );
  };

  it("hides credentials held by real OpenAI SDK clients", () => {
    const genericKey = "fake-generic-inspection-key";
    expectHidden(
      new OpenAICompatibleProvider({
        baseURL: "https://example.invalid/v1",
        apiKey: genericKey,
        apiKeyEnv: "UNUSED",
        model: "fixture",
        apiMode: "chat",
        auth: "bearer",
        tokenParameter: "max_tokens",
        streamUsage: false,
      }),
      genericKey,
    );
    const deepSeekKey = "fake-deepseek-inspection-key";
    expectHidden(
      new DeepSeekProvider({
        baseURL: "https://api.deepseek.com",
        apiKey: deepSeekKey,
        apiKeyEnv: "UNUSED",
        model: "deepseek-chat",
        apiMode: "chat",
        auth: "bearer",
        tokenParameter: "max_tokens",
        streamUsage: true,
      }),
      deepSeekKey,
    );
  });

  it("hides OpenCode credentials", () => {
    const zenKey = "fake-zen-inspection-key";
    expectHidden(new OpenCodeProvider({ apiKey: zenKey, model: "gpt-6-sol" }), zenKey);
    const goKey = "fake-go-inspection-key";
    expectHidden(new OpenCodeGoProvider({ apiKey: goKey, model: "gpt-5.6-luna" }), goKey);
  });
});

describe("OpenCode Console provider", () => {
  it("registers separately with a masked API key", () => {
    const value = registration(createOpenCodePlugin());
    expect(value).toMatchObject({ id: "opencode", name: "OpenCode Console (Zen)" });
    expect(value.fields).toEqual([expect.objectContaining({ key: "apiKey", kind: "secret" })]);
  });

  it.each([
    ["gpt-6-sol", "responses"],
    ["grok-4.7", "responses"],
    ["muse-spark-1.3", "responses"],
    ["deepseek-v4-pro", "chat"],
    ["minimax-m3", "chat"],
    ["qwen3.8-max", "chat"],
    ["qwen3.8-flash", "messages"],
    ["claude-sonnet-5", "messages"],
    ["gemini-3.8-flash", undefined],
    ["jev-1.13", undefined],
    ["future-model", undefined],
  ] as const)("classifies %s as %s", (model, protocol) => {
    expect(classifyOpenCodeModel(model)).toBe(protocol);
  });

  it("uses an unauthenticated catalog, preserves metadata, and hides unsupported models", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("user-agent")).toBe("alisio/test");
      return Response.json({
        data: [
          {
            id: "claude-sonnet-5",
            name: "Claude Sonnet 5",
            context_window: 200000,
            max_output_tokens: 64000,
            modalities: ["text", "image"],
            capabilities: { tools: true },
          },
          { id: "gemini-3.8-flash" },
          { id: "jev-1.13" },
          { id: "future-model" },
        ],
      });
    });
    const provider = new OpenCodeProvider({
      apiKey: "fake-opencode-key",
      model: "",
      baseURL: "http://127.0.0.1/v1",
      userAgent: "alisio/test",
      fetch: fetchMock as typeof fetch,
    });
    expect(await provider.listModels(AbortSignal.timeout(1000))).toEqual([
      {
        id: "opencode/claude-sonnet-5",
        name: "Claude Sonnet 5",
        contextWindow: 200000,
        maxOutputTokens: 64000,
        modalities: ["text", "image"],
        capabilities: { tools: true },
      },
    ]);
    expect(JSON.stringify(provider)).not.toContain("fake-opencode-key");
  });

  it("generates one opaque stable fallback session id when a caller omits it", async () => {
    const sessionHeaders: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sessionHeaders.push(new Headers(init?.headers).get("x-opencode-session") ?? "");
      return sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
    });
    const provider = new OpenCodeProvider({
      apiKey: "fake",
      model: "deepseek-v4-pro",
      baseURL: "http://127.0.0.1/v1",
      fetch: fetchMock as typeof fetch,
    });
    const withoutSession = { ...request("deepseek-v4-pro"), sessionId: undefined };
    for (let index = 0; index < 2; index++)
      for await (const _ of provider.stream(withoutSession)) void _;
    expect(sessionHeaders[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessionHeaders[1]).toBe(sessionHeaders[0]);
  });

  it("keeps explicit OpenCode session headers stable and distinct per child", async () => {
    const sessionHeaders: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sessionHeaders.push(new Headers(init?.headers).get("x-opencode-session") ?? "");
      return sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
    });
    const provider = new OpenCodeProvider({
      apiKey: "fake",
      model: "deepseek-v4-pro",
      baseURL: "http://127.0.0.1/v1",
      fetch: fetchMock as typeof fetch,
    });
    for (const sessionId of ["parent-session", "child-session", "child-session"])
      for await (const _ of provider.stream(request("deepseek-v4-pro", sessionId))) void _;
    expect(sessionHeaders).toEqual(["parent-session", "child-session", "child-session"]);
  });

  it.each([
    [
      "deepseek-v4-pro",
      "/chat/completions",
      [{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }],
    ],
    [
      "gpt-6-sol",
      "/responses",
      [
        {
          type: "response.completed",
          response: {
            output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
          },
        },
      ],
    ],
    [
      "claude-sonnet-5",
      "/messages",
      [
        { type: "message_start", message: { usage: { input_tokens: 2 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ],
    ],
  ] as const)("routes %s to %s with required identity headers", async (model, route, events) => {
    const sessionId = "00000000-0000-4000-8000-000000000002";
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer fake-opencode-key");
      expect(headers.get("user-agent")).toBe("alisio/test");
      expect(headers.get("x-opencode-session")).toBe(sessionId);
      if (route === "/messages") expect(headers.get("anthropic-version")).toBe("2023-06-01");
      return sse([...events]);
    });
    const provider = new OpenCodeProvider({
      apiKey: "fake-opencode-key",
      model,
      baseURL: "http://127.0.0.1/v1",
      userAgent: "alisio/test",
      fetch: fetchMock as typeof fetch,
    });
    const result: unknown[] = [];
    for await (const event of provider.stream(request(model, sessionId))) result.push(event);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(route);
    expect(result.at(-1)).toMatchObject({ type: "completed", message: { text: "ok" } });
  });

  it("rejects a protocol change on an existing provider session", async () => {
    const provider = new OpenCodeProvider({
      apiKey: "fake",
      model: "gpt-6-sol",
      baseURL: "http://127.0.0.1/v1",
      fetch: vi.fn() as typeof fetch,
    });
    await expect(async () => {
      for await (const _ of provider.stream(request("deepseek-v4-pro"))) void _;
    }).rejects.toThrow("session is bound to responses");
  });

  it("replays Messages reasoning signatures, tool blocks, results, and image attachments", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as any;
      calls++;
      if (calls === 1) {
        expect(body.messages[0].content[1]).toMatchObject({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "QQ==" },
        });
        return sse([
          { type: "message_start", message: { usage: { input_tokens: 4 } } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "considering" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "opaque-signature" },
          },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "c1", name: "echo", input: {} },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"x":1}' },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 2 },
          },
        ]);
      }
      expect(body.messages[1].content).toEqual([
        { type: "thinking", thinking: "considering", signature: "opaque-signature" },
        { type: "tool_use", id: "c1", name: "echo", input: { x: 1 } },
      ]);
      expect(body.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "c1" });
      return sse([
        { type: "message_start", message: { usage: { input_tokens: 6 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ]);
    });
    const provider = new OpenCodeProvider({
      apiKey: "fake",
      model: "claude-sonnet-5",
      baseURL: "http://127.0.0.1/v1",
      fetch: fetchMock as typeof fetch,
    });
    const firstRequest: Parameters<ModelProvider["stream"]>[0] = {
      ...request("claude-sonnet-5"),
      messages: [
        {
          role: "user",
          text: "look",
          attachments: [{ kind: "image", mimeType: "image/png", data: "QQ==", bytes: 1 }],
        },
      ],
    };
    const attachmentEvents = [];
    for await (const event of provider.stream(firstRequest)) attachmentEvents.push(event);
    const completed = attachmentEvents.at(-1);
    if (!completed || completed.type !== "completed") throw new Error("missing completion");
    const secondRequest = {
      ...request("claude-sonnet-5"),
      messages: [
        ...firstRequest.messages,
        completed.message,
        {
          role: "tool" as const,
          callId: "c1",
          result: { content: [{ type: "text" as const, text: "ok" }] },
        },
      ],
    };
    const second = [];
    for await (const event of provider.stream(secondRequest)) second.push(event);
    expect(second.at(-1)).toMatchObject({ type: "completed", message: { text: "done" } });
  });
});

describe("OpenCode Go provider", () => {
  it("registers separately with a masked API key", () => {
    let found: ProviderRegistration | undefined;
    createOpenCodeGoPlugin().setup({
      providers: {
        register(value: ProviderRegistration) {
          found = value;
          return () => {};
        },
      },
    } as any);
    expect(found?.id).toBe("opencode-go");
    expect(found?.fields).toEqual([expect.objectContaining({ key: "apiKey", kind: "secret" })]);
  });

  it.each([
    ["gpt-5.6-luna", "responses"],
    ["grok-4.7", "responses"],
    ["muse-spark-1.3-contributor", "responses"],
    ["glm-5.3", "chat"],
    ["kimi-k3", "chat"],
    ["longcat-2.0", "chat"],
    ["deepseek-v4-pro", "chat"],
    ["mimo-v2.6-pro", "chat"],
    ["hy4-preview", "chat"],
    ["space-bunny-free", "chat"],
    ["minimax-m3", "messages"],
    ["qwen3.8-max", "messages"],
  ] as const)("classifies %s as %s", (model, protocol) => {
    expect(classifyOpenCodeGoModel(model)).toBe(protocol);
  });

  it("filters unknown catalog families and fails closed when selected", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [{ id: "gpt-5.6-luna" }, { id: "omen-alpha" }, { id: "future-unknown" }],
      }),
    );
    const provider = new OpenCodeGoProvider({
      apiKey: "fake-opencode-key",
      model: "",
      baseURL: "http://127.0.0.1/v1",
      fetch: fetchMock as typeof fetch,
    });
    expect(await provider.listModels(AbortSignal.timeout(1000))).toEqual([
      { id: "opencode-go/gpt-5.6-luna" },
    ]);
    await expect(async () => {
      for await (const _ of provider.stream(request("omen-alpha"))) void _;
    }).rejects.toThrow("Unsupported OpenCode Go model family");
  });

  it.each([
    [
      "glm-5.3",
      "/chat/completions",
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "c1", function: { name: "echo", arguments: "{}" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ],
    ],
    [
      "gpt-5.6-luna",
      "/responses",
      [
        {
          type: "response.completed",
          response: {
            output: [{ type: "function_call", call_id: "c1", name: "echo", arguments: "{}" }],
            usage: { input_tokens: 4, output_tokens: 2 },
          },
        },
      ],
    ],
    [
      "minimax-m3",
      "/messages",
      [
        { type: "message_start", message: { usage: { input_tokens: 4 } } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "c1", name: "echo", input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{}" },
        },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ],
    ],
  ] as const)(
    "routes %s to %s with required headers and tool calls",
    async (model, route, events) => {
      const fakeKey = "fake-opencode-key";
      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${fakeKey}`);
        expect(headers.get("user-agent")).toBe("alisio/0.1.0-alpha.1");
        expect(headers.get("x-opencode-session")).toBe("00000000-0000-4000-8000-000000000001");
        return sse([...events]);
      });
      const provider = new OpenCodeGoProvider({
        apiKey: fakeKey,
        model,
        baseURL: "http://127.0.0.1/v1",
        fetch: fetchMock as typeof fetch,
      });
      const result = await collect(provider, model);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(route);
      expect(result.at(-1)).toMatchObject({
        type: "completed",
        message: { calls: [{ id: "c1", name: "echo", arguments: "{}" }] },
      });
      expect(JSON.stringify(result)).not.toContain(fakeKey);
    },
  );
});
