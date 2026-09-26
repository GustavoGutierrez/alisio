import assert from "node:assert/strict";
import type { Message, ProviderEvent } from "@alisio/sdk";
import { configSchema } from "../packages/core/src/config.ts";
import { OpenAICompatibleProvider } from "../packages/plugin-openai-compatible/src/index.ts";
import { isMain, serve } from "./http.ts";

export async function runProviderTest(mode: string): Promise<{ mode: string; ok: boolean }> {
  let count = 0;
  const server = await serve(async (req) => {
    assert.equal(req.headers.get("authorization"), null);
    if (mode === "extensions") {
      if (req.method === "GET") {
        assert.match(req.url, /\/models$/);
        return Response.json({
          object: "list",
          data: [
            { id: "m-a", object: "model", created: 1, owned_by: "x", context_window: 64000 },
            { id: "m-b", object: "model", created: 1, owned_by: "x" },
          ],
        });
      }
      const payload = (await req.json()) as Record<string, unknown>;
      assert.equal(payload.model, "override-model");
      const chunk = (choices: unknown[], usage?: unknown) => ({
        id: "t",
        object: "chat.completion.chunk",
        created: 1,
        model: "override-model",
        choices,
        ...(usage ? { usage } : {}),
      });
      const stream = [
        chunk([{ index: 0, delta: { reasoning_content: "think" }, finish_reason: null }]),
        chunk([{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }]),
        chunk([], { prompt_tokens: 50, completion_tokens: 7, prompt_cache_hit_tokens: 32 }),
      ];
      return new Response(
        stream.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    const body = (await req.json()) as Record<string, unknown>;
    count++;
    const chat = (delta: unknown, finish_reason: string | null = null) => ({
      id: "test",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta, finish_reason }],
    });
    let events: unknown[] = [];
    if (mode === "vision") {
      assert.match(req.url, /\/chat\/completions$/);
      const messages = body.messages as Array<{ role: string; content: unknown }>;
      const last = messages.at(-1);
      assert.deepEqual(last?.content, [
        { type: "text", text: "look at this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } },
      ]);
      events = [chat({ content: "I see a red square" }, "stop")];
    } else if (mode === "vision-responses") {
      assert.match(req.url, /\/responses$/);
      const input = body.input as Array<{ role: string; content: unknown }>;
      const last = input.at(-1);
      assert.deepEqual(last?.content, [
        { type: "input_text", text: "look at this" },
        { type: "input_image", image_url: "data:image/png;base64,QQ==", detail: "auto" },
      ]);
      events = [
        {
          type: "response.completed",
          response: {
            id: "r1",
            object: "response",
            created_at: 1,
            status: "completed",
            output: [
              {
                type: "message",
                id: "msg_1",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: "I see a red square", annotations: [] }],
              },
            ],
            usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
          },
        },
      ];
    } else if (mode === "responses") {
      assert.match(req.url, /\/responses$/);
      assert.equal(body.store, false);
      if (count === 2) assert.match(JSON.stringify(body.input), /encrypted_content/);
      const output =
        count === 1
          ? [
              { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque-reasoning" },
              {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "hello",
                arguments: "{}",
                status: "completed",
              },
            ]
          : [
              {
                type: "message",
                id: "msg_1",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: "done", annotations: [] }],
              },
            ];
      events = [
        {
          type: "response.completed",
          response: {
            id: "r1",
            object: "response",
            created_at: 1,
            status: "completed",
            output,
            usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
          },
        },
      ];
    } else {
      assert.match(req.url, /\/chat\/completions$/);
      assert.equal(body.model, "test-model");
      assert.equal(body.max_tokens, 128);
      if (mode === "incomplete") events = [chat({ content: "partial" })];
      else if (count === 1)
        events = [
          chat({
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "hello", arguments: '{"x":' },
              },
            ],
          }),
          chat({ tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, "tool_calls"),
        ];
      else {
        assert.match(JSON.stringify(body.messages), /tool_call_id/);
        events = [chat({ content: "done" }, "stop")];
      }
    }
    return new Response(
      events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  try {
    const config = configSchema.parse({
      provider: {
        model: "test-model",
        baseURL: `http://127.0.0.1:${server.port}/v1`,
        auth: "none",
        apiMode: mode === "responses" || mode === "vision-responses" ? "responses" : "chat",
      },
    });
    const provider = new OpenAICompatibleProvider(config.provider);
    const request = {
      instructions: "test",
      messages: [{ role: "user" as const, text: "test" }],
      tools: [],
      maxOutputTokens: 128,
      signal: AbortSignal.timeout(5000),
    };
    const consume = async (messages: Message[]) => {
      const result: ProviderEvent[] = [];
      for await (const event of provider.stream({ ...request, messages })) result.push(event);
      return result;
    };
    if (mode === "extensions") {
      const models = await provider.listModels(AbortSignal.timeout(5000));
      assert.deepEqual(models, [{ id: "m-a", contextWindow: 64000 }, { id: "m-b" }]);
      const events: ProviderEvent[] = [];
      for await (const event of provider.stream({ ...request, model: "override-model" }))
        events.push(event);
      assert.deepEqual(events.slice(0, 2), [
        { type: "reasoning_delta", delta: "think" },
        { type: "text_delta", delta: "hi" },
      ]);
      const final = events.at(-1);
      if (final?.type !== "completed") throw new Error("missing completion");
      assert.equal(final.message.text, "hi");
      assert.deepEqual(final.usage, { input: 50, output: 7, cachedInput: 32 });
    } else if (mode === "incomplete")
      await assert.rejects(() => consume(request.messages), /incomplete/);
    else if (mode === "vision" || mode === "vision-responses") {
      const events = await consume([
        {
          role: "user",
          text: "look at this",
          attachments: [{ kind: "image", mimeType: "image/png", data: "QQ==", bytes: 1 }],
        },
      ]);
      const final = events.at(-1);
      assert.equal(final?.type, "completed");
      if (final?.type !== "completed") throw new Error("missing");
      assert.equal(final.message.text, "I see a red square");
    } else {
      const events = await consume(request.messages);
      const final = events.at(-1);
      assert.equal(final?.type, "completed");
      if (final?.type !== "completed") throw new Error("missing");
      assert.equal(final.message.calls[0]?.id, "call_1");
      assert.equal(final.message.calls[0]?.arguments, mode === "responses" ? "{}" : '{"x":1}');
      const next = await consume([
        ...request.messages,
        final.message,
        { role: "tool", callId: "call_1", result: { content: [{ type: "text", text: "ok" }] } },
      ]);
      assert.equal(next.at(-1)?.type, "completed");
    }
    return { mode, ok: true };
  } finally {
    await server.close();
  }
}
if (isMain(import.meta.url))
  console.log(JSON.stringify(await runProviderTest(process.argv[2] ?? "chat")));
