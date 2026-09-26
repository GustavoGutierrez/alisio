import { definePlugin, type Plugin, type ProviderCreateRequest } from "@alisio/sdk";
import { type DeepSeekConfig, DeepSeekProvider } from "./provider.ts";
import { loadVersion } from "./version.ts";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const profileString = (request: ProviderCreateRequest, key: string, fallback: string) =>
  typeof request.profile[key] === "string" ? String(request.profile[key]) : fallback;

export function createDeepSeekPlugin(): Plugin {
  return definePlugin({
    id: "deepseek",
    name: "DeepSeek",
    description: "Dedicated DeepSeek Chat Completions and Responses provider",
    categories: ["model-provider"],
    version: loadVersion(import.meta.url),
    apiVersion: 1,
    setup(api) {
      api.providers.register({
        id: "deepseek",
        name: "DeepSeek",
        description: "DeepSeek Chat Completions and Responses APIs",
        fields: [
          {
            key: "apiKey",
            label: "API key",
            kind: "secret",
            required: true,
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
            key: "baseURL",
            label: "DeepSeek API base URL",
            kind: "url",
            required: true,
            defaultValue: DEFAULT_BASE_URL,
            description: "Change only for a DeepSeek-compatible proxy",
          },
        ],
        create(request) {
          const apiKey = request.credentials.apiKey;
          if (!apiKey) throw new Error("DeepSeek API key is required");
          const baseURL = profileString(request, "baseURL", DEFAULT_BASE_URL);
          const url = new URL(baseURL);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
            throw new Error("DeepSeek base URL must be HTTP(S) and must not contain credentials");
          const apiMode = profileString(request, "apiMode", "chat");
          if (apiMode !== "chat" && apiMode !== "responses")
            throw new Error(`Unsupported DeepSeek API mode: ${apiMode}`);
          const config: DeepSeekConfig = {
            baseURL,
            apiKey,
            apiKeyEnv: "DEEPSEEK_API_KEY",
            model: profileString(request, "model", ""),
            apiMode,
            auth: "bearer",
            tokenParameter: "max_tokens",
            streamUsage: true,
          };
          return new DeepSeekProvider(config);
        },
      });
    },
  });
}

export type { DeepSeekConfig } from "./provider.ts";
export { DeepSeekProvider } from "./provider.ts";
export default createDeepSeekPlugin();
