import { describe, expect, it } from "vitest";
import { serve } from "../fixtures/http.ts";
import { DeepSeekProvider } from "../packages/plugin-deepseek/src/provider.ts";

/**
 * Network-free fixture over the local HTTP server: asserts the request body the DeepSeek provider
 * builds carries `reasoning_effort` (chat) / `reasoning.effort` (responses) exactly when the
 * caller supplies `reasoningEffort`, and omits it otherwise.
 */
async function probe(apiMode: "chat" | "responses", reasoningEffort?: string) {
  let body: Record<string, unknown> | undefined;
  const server = await serve(async (req) => {
    body = (await req.json()) as Record<string, unknown>;
    if (!req.url.includes("/chat/completions") && !req.url.includes("/responses"))
      return new Response("not found", { status: 404 });
    if (apiMode === "responses")
      return new Response(
        [
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "r1",
              object: "response",
              created_at: 1,
              status: "completed",
              output: [],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    return new Response(
      [
        `data: ${JSON.stringify({
          id: "t",
          object: "chat.completion.chunk",
          created: 1,
          model: "deepseek-test",
          choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  try {
    const provider = new DeepSeekProvider({
      baseURL: `http://127.0.0.1:${server.port}/v1`,
      apiKeyEnv: "DEEPSEEK_API_KEY",
      model: "deepseek-test",
      apiMode,
      auth: "none",
      tokenParameter: "max_tokens",
      streamUsage: false,
    });
    const events: string[] = [];
    for await (const event of provider.stream({
      instructions: "test",
      messages: [{ role: "user" as const, text: "hi" }],
      tools: [],
      maxOutputTokens: 128,
      signal: AbortSignal.timeout(5000),
      model: "deepseek-test",
      ...(reasoningEffort ? { reasoningEffort } : {}),
    })) {
      if (event.type === "completed" || event.type === "text_delta") events.push(event.type);
    }
    return { body, events };
  } finally {
    await server.close();
  }
}

describe("DeepSeek reasoning effort", () => {
  it("sends reasoning_effort in chat mode only when set", async () => {
    const withEffort = await probe("chat", "max");
    expect(withEffort.events).toContain("completed");
    expect(withEffort.body?.reasoning_effort).toBe("max");

    const without = await probe("chat");
    expect(without.body?.reasoning_effort).toBeUndefined();
  });

  it("sends reasoning.effort in responses mode only when set", async () => {
    const withEffort = await probe("responses", "high");
    expect(withEffort.events).toContain("completed");
    expect(withEffort.body?.reasoning).toEqual({ effort: "high" });

    const without = await probe("responses");
    expect(without.body?.reasoning).toBeUndefined();
  });
});
