import {
  definePlugin,
  type Plugin,
  type ProviderConfigurationValue,
  type ProviderCreateRequest,
} from "@alisio/sdk";
import { type OpenAICompatibleConfig, OpenAICompatibleProvider } from "./provider.ts";

const defaults: OpenAICompatibleConfig = {
  baseURL: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_API_KEY",
  model: "",
  apiMode: "chat",
  auth: "bearer",
  tokenParameter: "max_tokens",
  streamUsage: false,
};
const value = <T extends ProviderConfigurationValue>(
  request: ProviderCreateRequest,
  key: string,
  fallback: T,
): T => (request.profile[key] ?? request.legacy?.[key] ?? fallback) as T;

export function createOpenAICompatiblePlugin(): Plugin {
  return definePlugin({
    id: "openai-compatible",
    name: "OpenAI compatible",
    description: "OpenAI Chat Completions or Responses compatible endpoint",
    categories: ["model-provider"],
    version: "0.1.0-alpha.1",
    apiVersion: 1,
    setup(api) {
      api.providers.register({
        id: "openai-compatible",
        name: "OpenAI compatible",
        description: "OpenAI Chat Completions or Responses compatible endpoint",
        capabilities: { nativeWebSearch: { field: "apiMode", values: ["responses"] } },
        fields: [
          {
            key: "baseURL",
            label: "Base URL",
            kind: "url",
            required: true,
            defaultValue: defaults.baseURL,
          },
          {
            key: "apiKey",
            label: "API key",
            kind: "secret",
            description: "Stored only in the global credentials file",
          },
          {
            key: "apiMode",
            label: "API mode",
            kind: "select",
            required: true,
            defaultValue: "chat",
            options: [
              { value: "chat", label: "Chat Completions" },
              { value: "responses", label: "Responses" },
            ],
          },
          {
            key: "auth",
            label: "Authentication",
            kind: "select",
            required: true,
            defaultValue: "bearer",
            options: [
              { value: "bearer", label: "Bearer token" },
              { value: "none", label: "None" },
            ],
          },
          {
            key: "tokenParameter",
            label: "Token parameter",
            kind: "select",
            required: true,
            defaultValue: "max_tokens",
            options: [
              { value: "max_tokens", label: "max_tokens" },
              { value: "max_completion_tokens", label: "max_completion_tokens" },
              { value: "omit", label: "Omit" },
            ],
          },
          {
            key: "streamUsage",
            label: "Request stream usage",
            kind: "boolean",
            defaultValue: false,
          },
        ],
        create(request) {
          const auth = value(request, "auth", defaults.auth) as OpenAICompatibleConfig["auth"];
          const apiKey = request.credentials.apiKey;
          const apiKeyEnv = value(request, "apiKeyEnv", defaults.apiKeyEnv);
          if (auth !== "none" && !apiKey && !process.env[apiKeyEnv])
            throw new Error(
              "API key is required (enter one in /connect or set the configured environment variable)",
            );
          const config: OpenAICompatibleConfig = {
            baseURL: value(request, "baseURL", defaults.baseURL),
            apiKeyEnv,
            model: value(request, "model", defaults.model),
            apiMode: value(
              request,
              "apiMode",
              defaults.apiMode,
            ) as OpenAICompatibleConfig["apiMode"],
            auth,
            tokenParameter: value(
              request,
              "tokenParameter",
              defaults.tokenParameter,
            ) as OpenAICompatibleConfig["tokenParameter"],
            streamUsage: value(request, "streamUsage", defaults.streamUsage),
            ...(typeof request.profile.contextWindow === "number"
              ? { contextWindow: request.profile.contextWindow }
              : {}),
            ...(apiKey ? { apiKey } : {}),
          };
          const url = new URL(config.baseURL);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
            throw new Error("Base URL must be HTTP(S) and must not contain credentials");
          return new OpenAICompatibleProvider(config);
        },
      });
    },
  });
}

export type { OpenAICompatibleConfig } from "./provider.ts";
export { OpenAICompatibleProvider } from "./provider.ts";
export default createOpenAICompatiblePlugin();
