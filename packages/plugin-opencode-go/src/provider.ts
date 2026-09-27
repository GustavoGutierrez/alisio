import type {
  Attachment,
  Message,
  ModelInfo,
  ModelProvider,
  ProviderEvent,
  ToolCall,
  ToolDefinition,
  Usage,
} from "@alisio/sdk";
import { loadVersion } from "./version.ts";

export type OpenCodeProtocol = "responses" | "chat" | "messages";
export type OpenCodeProduct = "opencode-go";

const protocolMap = (groups: Partial<Record<OpenCodeProtocol, string[]>>) =>
  new Map(
    Object.entries(groups).flatMap(([protocol, models]) =>
      (models ?? []).map((model) => [model, protocol as OpenCodeProtocol] as const),
    ),
  );

const GO_MODELS = protocolMap({
  responses: [
    "grok-4.7",
    "grok-4.6",
    "gpt-6-luna",
    "gpt-5.6-luna",
    "muse-spark-1.3-contributor",
    "muse-spark-1.2-contributor",
  ],
  chat: [
    "glm-5.3-flash",
    "glm-5.3",
    "glm-5.2",
    "glm-5.1",
    "kimi-k3",
    "kimi-k2.7-code",
    "kimi-k2.6",
    "longcat-2.0",
    "deepseek-v4.1-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-v4-flash-vision-exp",
    "mimo-v2.6-flash",
    "mimo-v2.6-pro",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "hy4-preview",
    "hy3",
    "space-bunny-free",
    "longcat-2.5-preview-free",
  ],
  messages: [
    "minimax-m3",
    "minimax-m2.7",
    "minimax-m2.5",
    "qwen3.8-max",
    "qwen3.8-flash",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.6-plus",
  ],
});

/** Explicit allow-list by documented family. Unknown future catalog entries fail closed. */
export function classifyOpenCodeGoModel(id: string): OpenCodeProtocol | undefined {
  const model = id.replace(/^opencode-go\//, "").toLowerCase();
  return GO_MODELS.get(model);
}

export interface OpenCodeGatewayConfig {
  apiKey: string;
  model: string;
  product: OpenCodeProduct;
  baseURL: string;
  classify: (id: string) => OpenCodeProtocol | undefined;
  userAgent?: string;
  fetch?: typeof fetch;
}

type Json = Record<string, any>;
const dataUrl = (a: Attachment) => `data:${a.mimeType};base64,${a.data}`;
const modelId = (id: string) => id.replace(/^opencode(?:-go)?\//, "");
/** Default user agent derives from the package manifest at runtime; never a hardcoded version. */
const DEFAULT_USER_AGENT = `alisio/${loadVersion(import.meta.url)}`;

async function* sse(response: Response): AsyncIterable<Json> {
  if (!response.ok) throw new Error(`OpenCode request failed: HTTP ${response.status}`);
  if (!response.body) throw new Error("OpenCode response has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data && data !== "[DONE]") yield JSON.parse(data) as Json;
      boundary = buffer.indexOf("\n\n");
    }
  }
}

function functionTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

function chatMessages(instructions: string, messages: Message[]) {
  const output: Json[] = [{ role: "system", content: instructions }];
  for (const message of messages) {
    if (message.role === "user") {
      const content = message.attachments?.length
        ? [
            ...(message.text.trim() ? [{ type: "text", text: message.text }] : []),
            ...message.attachments.map((a) => ({
              type: "image_url",
              image_url: { url: dataUrl(a) },
            })),
          ]
        : message.text;
      output.push({ role: "user", content });
    } else if (message.role === "tool")
      output.push({
        role: "tool",
        tool_call_id: message.callId,
        content: JSON.stringify(message.result),
      });
    else
      output.push({
        role: "assistant",
        content: message.text || null,
        ...(message.calls.length
          ? {
              tool_calls: message.calls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      });
  }
  return output;
}

export class OpenCodeGatewayProvider implements ModelProvider {
  readonly model: string;
  readonly id: string;
  private readonly baseURL: string;
  private readonly request: typeof fetch;
  readonly #apiKey: string;
  private readonly fallbackSession = crypto.randomUUID();
  private readonly product: OpenCodeProduct;
  private readonly classify: (id: string) => OpenCodeProtocol | undefined;
  private readonly protocol?: OpenCodeProtocol;
  private readonly userAgent: string;
  private readonly displayName: string;
  constructor(config: OpenCodeGatewayConfig) {
    this.model = config.model;
    this.product = config.product;
    this.displayName = "OpenCode Go";
    this.classify = config.classify;
    this.baseURL = config.baseURL.replace(/\/$/, "");
    this.userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    const url = new URL(this.baseURL);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
      throw new Error("OpenCode base URL must use HTTPS");
    if (url.username || url.password)
      throw new Error("OpenCode base URL must not contain credentials");
    this.request = config.fetch ?? fetch;
    this.#apiKey = config.apiKey;
    this.protocol = this.model ? this.classify(this.model) : undefined;
    if (this.model && !this.protocol)
      throw new Error(`Unsupported ${this.displayName} model family: ${modelId(this.model)}`);
    this.id = `${this.product}:${this.protocol ?? "catalog"}:${this.baseURL}`;
  }

  private headers(auth: boolean, sessionId?: string, messages = false): HeadersInit {
    return {
      ...(auth ? { authorization: `Bearer ${this.#apiKey}` } : {}),
      ...(auth ? { "content-type": "application/json" } : {}),
      "user-agent": this.userAgent,
      ...(messages ? { "anthropic-version": "2023-06-01" } : {}),
      ...(sessionId ? { "x-opencode-session": sessionId } : {}),
    };
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const response = await this.request(`${this.baseURL}/models`, {
      headers: this.headers(false),
      signal,
    });
    if (!response.ok)
      throw new Error(`${this.displayName} model catalog failed: HTTP ${response.status}`);
    const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
    return (body.data ?? []).flatMap((entry) => {
      if (typeof entry.id !== "string" || !this.classify(entry.id)) return [];
      const context = [entry.context_window, entry.context_length].find(
        (value): value is number => typeof value === "number" && value > 0,
      );
      const maxOutput = entry.max_output_tokens;
      const modalities = Array.isArray(entry.modalities)
        ? entry.modalities.filter((value): value is string => typeof value === "string")
        : undefined;
      const capabilitySource = [entry.api, entry.capabilities, entry.capability].find(
        (value): value is Record<string, unknown> => !!value && typeof value === "object",
      );
      const capabilities = capabilitySource
        ? Object.fromEntries(
            Object.entries(capabilitySource).filter(
              (value): value is [string, boolean | string | number] =>
                ["boolean", "string", "number"].includes(typeof value[1]),
            ),
          )
        : {};
      return [
        {
          id: `${this.product}/${entry.id}`,
          ...(typeof entry.name === "string" ? { name: entry.name } : {}),
          ...(context ? { contextWindow: context } : {}),
          ...(typeof maxOutput === "number" && maxOutput > 0 ? { maxOutputTokens: maxOutput } : {}),
          ...(modalities?.length ? { modalities } : {}),
          ...(Object.keys(capabilities).length ? { capabilities } : {}),
        },
      ];
    });
  }

  async *stream(request: Parameters<ModelProvider["stream"]>[0]): AsyncIterable<ProviderEvent> {
    const model = modelId(request.model || this.model);
    const protocol = this.classify(model);
    if (!protocol) throw new Error(`Unsupported ${this.displayName} model family: ${model}`);
    if (this.protocol && protocol !== this.protocol)
      throw new Error(
        `Model ${model} uses ${protocol}, but this session is bound to ${this.protocol}; start a fresh session`,
      );
    const sessionId = request.sessionId ?? this.fallbackSession;
    if (protocol === "chat") yield* this.chat(model, request, sessionId);
    else if (protocol === "responses") yield* this.responses(model, request, sessionId);
    else yield* this.messages(model, request, sessionId);
  }

  private async post(
    path: string,
    body: Json,
    signal: AbortSignal,
    sessionId: string,
    messages = false,
  ) {
    return this.request(`${this.baseURL}/${path}`, {
      method: "POST",
      headers: this.headers(true, sessionId, messages),
      body: JSON.stringify(body),
      signal,
    });
  }

  private async *chat(
    model: string,
    request: Parameters<ModelProvider["stream"]>[0],
    sessionId: string,
  ): AsyncIterable<ProviderEvent> {
    const response = await this.post(
      "chat/completions",
      {
        model,
        messages: chatMessages(request.instructions, request.messages),
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: request.maxOutputTokens,
        ...(request.tools.length ? { tools: functionTools(request.tools) } : {}),
      },
      request.signal,
      sessionId,
    );
    let text = "";
    let finish: string | undefined;
    let usage: Usage | undefined;
    const calls = new Map<number, ToolCall>();
    for await (const chunk of sse(response)) {
      if (chunk.usage)
        usage = {
          input: chunk.usage.prompt_tokens ?? 0,
          output: chunk.usage.completion_tokens ?? 0,
          ...(typeof chunk.usage.prompt_cache_hit_tokens === "number"
            ? { cachedInput: chunk.usage.prompt_cache_hit_tokens }
            : {}),
        };
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const reasoning = choice.delta?.reasoning_content;
      if (typeof reasoning === "string" && reasoning)
        yield { type: "reasoning_delta", delta: reasoning };
      if (typeof choice.delta?.content === "string" && choice.delta.content) {
        text += choice.delta.content;
        yield { type: "text_delta", delta: choice.delta.content };
      }
      for (const part of choice.delta?.tool_calls ?? []) {
        const call = calls.get(part.index) ?? { id: "", name: "", arguments: "" };
        if (part.id) call.id = part.id;
        if (part.function?.name) call.name += part.function.name;
        if (part.function?.arguments) call.arguments += part.function.arguments;
        calls.set(part.index, call);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    if (finish !== "stop" && finish !== "tool_calls" && finish !== "length")
      throw new Error(`OpenCode chat response incomplete: ${finish ?? "stream ended"}`);
    const completed = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (completed.some((call) => !call.id || !call.name)) throw new Error("Incomplete tool call");
    if (finish === "length" && !text.trim())
      throw new Error(
        "OpenCode chat response cut off by max output tokens before any usable content; raise limits.maxOutputTokens (/settings → Agent max output tokens)",
      );
    yield {
      type: "completed",
      message: {
        role: "assistant",
        text,
        calls: completed,
        ...(finish === "length" ? { truncated: true } : {}),
      },
      usage,
    };
  }

  private responsesInput(messages: Message[]): Json[] {
    const input: Json[] = [];
    for (const message of messages) {
      if (message.role === "user")
        input.push({
          role: "user",
          content: message.attachments?.length
            ? [
                ...(message.text.trim() ? [{ type: "input_text", text: message.text }] : []),
                ...message.attachments.map((a) => ({ type: "input_image", image_url: dataUrl(a) })),
              ]
            : message.text,
        });
      else if (message.role === "tool")
        input.push({
          type: "function_call_output",
          call_id: message.callId,
          output: JSON.stringify(message.result),
        });
      else if (message.providerData) input.push(...(message.providerData as Json[]));
      else throw new Error("Missing provider continuation data for OpenCode Responses session");
    }
    return input;
  }

  private async *responses(
    model: string,
    request: Parameters<ModelProvider["stream"]>[0],
    sessionId: string,
  ): AsyncIterable<ProviderEvent> {
    const response = await this.post(
      "responses",
      {
        model,
        instructions: request.instructions,
        input: this.responsesInput(request.messages),
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
        max_output_tokens: request.maxOutputTokens,
        tools: request.tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          strict: false,
        })),
      },
      request.signal,
      sessionId,
    );
    let complete = false;
    for await (const event of sse(response)) {
      if (event.type === "response.output_text.delta")
        yield { type: "text_delta", delta: event.delta };
      if (event.type === "response.reasoning_summary_text.delta")
        yield { type: "reasoning_delta", delta: event.delta };
      if (["response.failed", "error"].includes(event.type))
        throw new Error(`OpenCode Responses request failed: ${event.type}`);
      if (event.type === "response.incomplete") {
        complete = true;
        const output = event.response.output as Json[];
        const calls = output
          .filter((item) => item.type === "function_call")
          .map((item) => ({ id: item.call_id, name: item.name, arguments: item.arguments }));
        const text = output
          .filter((item) => item.type === "message")
          .flatMap((item) => item.content ?? [])
          .filter((item) => item.type === "output_text")
          .map((item) => item.text)
          .join("");
        if (!text.trim())
          throw new Error(
            "OpenCode Responses response cut off by max output tokens before any usable content; raise limits.maxOutputTokens (/settings → Agent max output tokens)",
          );
        if (calls.some((call) => !call.id || !call.name)) throw new Error("Incomplete tool call");
        const u = event.response.usage;
        yield {
          type: "completed",
          message: { role: "assistant", text, calls, providerData: output, truncated: true },
          usage: u
            ? {
                input: u.input_tokens ?? 0,
                output: u.output_tokens ?? 0,
                ...(typeof u.input_tokens_details?.cached_tokens === "number"
                  ? { cachedInput: u.input_tokens_details.cached_tokens }
                  : {}),
              }
            : undefined,
        };
      }
      if (event.type === "response.completed") {
        complete = true;
        const output = event.response.output as Json[];
        const calls = output
          .filter((item) => item.type === "function_call")
          .map((item) => ({ id: item.call_id, name: item.name, arguments: item.arguments }));
        const text = output
          .filter((item) => item.type === "message")
          .flatMap((item) => item.content ?? [])
          .filter((item) => item.type === "output_text")
          .map((item) => item.text)
          .join("");
        const u = event.response.usage;
        yield {
          type: "completed",
          message: { role: "assistant", text, calls, providerData: output },
          usage: u
            ? {
                input: u.input_tokens ?? 0,
                output: u.output_tokens ?? 0,
                ...(typeof u.input_tokens_details?.cached_tokens === "number"
                  ? { cachedInput: u.input_tokens_details.cached_tokens }
                  : {}),
              }
            : undefined,
        };
      }
    }
    if (!complete) throw new Error("OpenCode Responses stream ended before completion");
  }

  private anthropicMessages(messages: Message[]): Json[] {
    const output: Json[] = [];
    for (const message of messages) {
      if (message.role === "user") {
        const content: Json[] = [];
        if (message.text) content.push({ type: "text", text: message.text });
        for (const attachment of message.attachments ?? [])
          content.push({
            type: "image",
            source: { type: "base64", media_type: attachment.mimeType, data: attachment.data },
          });
        output.push({ role: "user", content });
      } else if (message.role === "tool")
        if (
          output.at(-1)?.role === "user" &&
          output.at(-1)?.content?.every((part: Json) => part.type === "tool_result")
        )
          output.at(-1)?.content.push({
            type: "tool_result",
            tool_use_id: message.callId,
            content: JSON.stringify(message.result),
          });
        else
          output.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: message.callId,
                content: JSON.stringify(message.result),
              },
            ],
          });
      else
        output.push({
          role: "assistant",
          content: (message.providerData as Json[] | undefined) ?? [
            ...(message.text ? [{ type: "text", text: message.text }] : []),
            ...message.calls.map((call) => ({
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: JSON.parse(call.arguments || "{}"),
            })),
          ],
        });
    }
    return output;
  }

  private async *messages(
    model: string,
    request: Parameters<ModelProvider["stream"]>[0],
    sessionId: string,
  ): AsyncIterable<ProviderEvent> {
    const response = await this.post(
      "messages",
      {
        model,
        system: request.instructions,
        messages: this.anthropicMessages(request.messages),
        max_tokens: request.maxOutputTokens,
        stream: true,
        ...(request.tools.length
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
              })),
            }
          : {}),
      },
      request.signal,
      sessionId,
      true,
    );
    let text = "";
    let input = 0;
    let output = 0;
    let stopReason: string | undefined;
    const blocks: Json[] = [];
    const argumentParts = new Map<number, string>();
    for await (const event of sse(response)) {
      if (event.type === "message_start") input = event.message?.usage?.input_tokens ?? 0;
      if (event.type === "content_block_start") {
        blocks[event.index] = event.content_block;
        if (event.content_block?.type === "text" && event.content_block.text) {
          text += event.content_block.text;
          yield { type: "text_delta", delta: event.content_block.text };
        }
        if (event.content_block?.type === "tool_use") argumentParts.set(event.index, "");
      }
      if (event.type === "content_block_delta") {
        if (event.delta?.type === "text_delta") {
          text += event.delta.text;
          const block = blocks[event.index];
          if (block?.type === "text") block.text = (block.text ?? "") + event.delta.text;
          yield { type: "text_delta", delta: event.delta.text };
        }
        if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
          const block = blocks[event.index];
          if (block?.type === "thinking")
            block.thinking = (block.thinking ?? "") + event.delta.thinking;
          yield { type: "reasoning_delta", delta: event.delta.thinking };
        }
        if (event.delta?.type === "input_json_delta")
          argumentParts.set(
            event.index,
            (argumentParts.get(event.index) ?? "") + event.delta.partial_json,
          );
        if (event.delta?.type === "signature_delta" && event.delta.signature) {
          const block = blocks[event.index];
          if (block?.type === "thinking") block.signature = event.delta.signature;
        }
      }
      if (event.type === "message_delta") {
        output = event.usage?.output_tokens ?? output;
        stopReason = event.delta?.stop_reason ?? stopReason;
      }
    }
    const truncated = stopReason === "max_tokens";
    if (!truncated && stopReason !== "end_turn" && stopReason !== "tool_use")
      throw new Error(`OpenCode Messages response incomplete: ${stopReason ?? "stream ended"}`);
    const calls: ToolCall[] = [];
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      if (!block || block.type !== "tool_use") continue;
      const args = argumentParts.get(index) || JSON.stringify(block.input ?? {});
      calls.push({ id: block.id, name: block.name, arguments: args });
      try {
        block.input = JSON.parse(args || "{}");
      } catch {
        if (!truncated) throw new Error("Incomplete tool call");
        throw new Error(
          `OpenCode Messages response incomplete: tool call arguments cut off for ${block.name}`,
        );
      }
    }
    if (truncated) {
      if (!text.trim())
        throw new Error(
          "OpenCode Messages response cut off by max output tokens before any usable content; raise limits.maxOutputTokens (/settings → Agent max output tokens)",
        );
      yield {
        type: "completed",
        message: { role: "assistant", text, calls, providerData: blocks, truncated: true },
        usage: { input, output },
      };
      return;
    }
    yield {
      type: "completed",
      message: { role: "assistant", text, calls, providerData: blocks },
      usage: { input, output },
    };
  }
}

export interface OpenCodeGoConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
  userAgent?: string;
  fetch?: typeof fetch;
}

export class OpenCodeGoProvider extends OpenCodeGatewayProvider {
  constructor(config: OpenCodeGoConfig) {
    super({
      ...config,
      product: "opencode-go",
      baseURL: config.baseURL ?? "https://opencode.ai/zen/go/v1",
      classify: classifyOpenCodeGoModel,
    });
  }
}
