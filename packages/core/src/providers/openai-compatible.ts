import type {
  Attachment,
  ModelInfo,
  ModelProvider,
  ProviderEvent,
  ToolCall,
  Usage,
} from "@alisio/sdk";
import OpenAI from "openai";
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type {
  ResponseCreateParams,
  ResponseInputContent,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import type { Config } from "../config.ts";

const dataUrl = (a: Attachment) => `data:${a.mimeType};base64,${a.data}`;
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly model: string;
  private client: OpenAI;
  constructor(
    private config: Config["provider"],
    client?: OpenAI,
  ) {
    this.model = config.model;
    if (!this.model) throw new Error("Set ALISIO_MODEL, --model, or provider.model");
    const key = config.auth === "none" ? "unused" : process.env[config.apiKeyEnv];
    if (!client && !key)
      throw new Error(`Missing API key environment variable: ${config.apiKeyEnv}`);
    this.id = `openai-compatible:${config.apiMode}:${config.baseURL.replace(/\/$/, "")}`;
    this.client =
      client ??
      new OpenAI({
        baseURL: config.baseURL,
        apiKey: key,
        maxRetries: 0,
        timeout: 120_000,
        ...(config.auth === "none" ? { defaultHeaders: { Authorization: null } } : {}),
      });
  }
  /** Lists models from GET /models. Context window fields are provider extensions. */
  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    for await (const m of this.client.models.list({ signal })) {
      const extra = m as unknown as Record<string, unknown>;
      const window = [extra.context_window, extra.context_length, extra.max_context_length].find(
        (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
      );
      models.push({ id: m.id, ...(window ? { contextWindow: window } : {}) });
      if (models.length >= 1000) break;
    }
    return models;
  }
  async *stream(request: Parameters<ModelProvider["stream"]>[0]): AsyncIterable<ProviderEvent> {
    if (this.config.apiMode === "responses") {
      yield* this.responses(request);
      return;
    }
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: request.instructions },
    ];
    for (const m of request.messages) {
      if (m.role === "user") {
        if (m.attachments?.length) {
          const parts: ChatCompletionContentPart[] = [];
          if (m.text.trim()) parts.push({ type: "text", text: m.text });
          for (const a of m.attachments)
            parts.push({ type: "image_url", image_url: { url: dataUrl(a) } });
          messages.push({ role: "user", content: parts });
        } else messages.push({ role: "user", content: m.text });
      } else if (m.role === "tool")
        messages.push({ role: "tool", tool_call_id: m.callId, content: JSON.stringify(m.result) });
      else
        messages.push({
          role: "assistant",
          content: m.text || null,
          ...(m.calls.length
            ? {
                tool_calls: m.calls.map((c) => ({
                  id: c.id,
                  type: "function" as const,
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        });
    }
    const limit =
      this.config.tokenParameter === "omit"
        ? {}
        : { [this.config.tokenParameter]: request.maxOutputTokens };
    const stream = await this.client.chat.completions.create(
      {
        model: request.model || this.model,
        messages,
        stream: true,
        ...limit,
        ...(this.config.streamUsage ? { stream_options: { include_usage: true } } : {}),
        ...(request.tools.length || request.nativeTools?.length
          ? {
              tools: [
                ...request.tools.map((t) => ({
                  type: "function" as const,
                  function: { name: t.name, description: t.description, parameters: t.inputSchema },
                })),
                ...(request.nativeTools ?? []),
              ] as unknown as ChatCompletionTool[],
            }
          : {}),
      },
      { signal: request.signal },
    );
    let text = "",
      finish: string | null = null,
      usage: Usage | undefined;
    const calls = new Map<number, ToolCall>();
    for await (const chunk of stream) {
      if (chunk.usage) {
        // DeepSeek reports prompt_cache_hit_tokens; OpenAI uses prompt_tokens_details.
        const extra = chunk.usage as unknown as { prompt_cache_hit_tokens?: number };
        const cached =
          chunk.usage.prompt_tokens_details?.cached_tokens ?? extra.prompt_cache_hit_tokens;
        usage = {
          input: chunk.usage.prompt_tokens,
          output: chunk.usage.completion_tokens,
          ...(typeof cached === "number" ? { cachedInput: cached } : {}),
        };
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      const reasoning = (choice.delta as { reasoning_content?: unknown }).reasoning_content;
      if (typeof reasoning === "string" && reasoning)
        yield { type: "reasoning_delta", delta: reasoning };
      if (choice.delta.content) {
        text += choice.delta.content;
        yield { type: "text_delta", delta: choice.delta.content };
      }
      if (choice.delta.refusal) throw new Error(`Provider refusal: ${choice.delta.refusal}`);
      for (const part of choice.delta.tool_calls ?? []) {
        const c = calls.get(part.index) ?? { id: "", name: "", arguments: "" };
        if (part.id) c.id = part.id;
        if (part.function?.name) c.name += part.function.name;
        if (part.function?.arguments) c.arguments += part.function.arguments;
        calls.set(part.index, c);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    if (finish !== "stop" && finish !== "tool_calls")
      throw new Error(`Provider response incomplete: ${finish ?? "stream ended"}`);
    const completed = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
    if (completed.some((c) => !c.id || !c.name)) throw new Error("Incomplete tool call");
    yield { type: "completed", message: { role: "assistant", text, calls: completed }, usage };
  }
  private async *responses(
    request: Parameters<ModelProvider["stream"]>[0],
  ): AsyncIterable<ProviderEvent> {
    const input: ResponseInputItem[] = [];
    for (const m of request.messages) {
      if (m.role === "user") {
        if (m.attachments?.length) {
          const content: ResponseInputContent[] = [];
          if (m.text.trim()) content.push({ type: "input_text", text: m.text });
          for (const a of m.attachments)
            content.push({ type: "input_image", image_url: dataUrl(a), detail: "auto" });
          input.push({ role: "user", content });
        } else input.push({ role: "user", content: m.text });
      } else if (m.role === "tool")
        input.push({
          type: "function_call_output",
          call_id: m.callId,
          output: JSON.stringify(m.result),
        });
      else if (m.providerData) input.push(...(m.providerData as ResponseInputItem[]));
      else throw new Error("Missing provider continuation data for Responses session");
    }
    const stream = await this.client.responses.create(
      {
        model: request.model || this.model,
        instructions: request.instructions,
        input,
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
        max_output_tokens: request.maxOutputTokens,
        tools: [
          ...request.tools.map((t) => ({
            type: "function" as const,
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
            strict: false,
          })),
          ...(request.nativeTools ?? []),
        ] as unknown as ResponseCreateParams["tools"],
      },
      { signal: request.signal },
    );
    let complete = false;
    for await (const event of stream) {
      if (event.type === "response.output_text.delta")
        yield { type: "text_delta", delta: event.delta };
      if (event.type === "response.reasoning_summary_text.delta")
        yield { type: "reasoning_delta", delta: event.delta };
      if (
        event.type === "response.failed" ||
        event.type === "response.incomplete" ||
        event.type === "error"
      )
        throw new Error(`Provider response failed: ${event.type}`);
      if (event.type === "response.completed") {
        complete = true;
        const r = event.response;
        const calls: ToolCall[] = r.output
          .filter((x) => x.type === "function_call")
          .map((x) => ({ id: x.call_id, name: x.name, arguments: x.arguments }));
        const text = r.output
          .filter((x) => x.type === "message")
          .flatMap((x) => x.content)
          .filter((x) => x.type === "output_text")
          .map((x) => x.text)
          .join("");
        yield {
          type: "completed",
          message: { role: "assistant", text, calls, providerData: r.output },
          usage: r.usage
            ? {
                input: r.usage.input_tokens,
                output: r.usage.output_tokens,
                ...(typeof r.usage.input_tokens_details?.cached_tokens === "number"
                  ? { cachedInput: r.usage.input_tokens_details.cached_tokens }
                  : {}),
              }
            : undefined,
        };
      }
    }
    if (!complete) throw new Error("Responses stream ended before completion");
  }
}
