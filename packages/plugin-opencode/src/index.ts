import { definePlugin, type Plugin, type ProviderCreateRequest } from "@alisio/sdk";
import { OpenCodeProvider } from "./provider.ts";
import { loadVersion } from "./version.ts";

const profileString = (request: ProviderCreateRequest, key: string) =>
  typeof request.profile[key] === "string" ? String(request.profile[key]) : "";

export function createOpenCodePlugin(): Plugin {
  return definePlugin({
    id: "opencode",
    name: "OpenCode Console (Zen)",
    description: "OpenCode Console gateway for Responses, Chat, and Messages models",
    categories: ["model-provider"],
    version: loadVersion(import.meta.url),
    apiVersion: 1,
    setup(api) {
      api.providers.register({
        id: "opencode",
        name: "OpenCode Console (Zen)",
        description: "OpenCode Console gateway for supported Responses, Chat, and Messages models",
        fields: [
          {
            key: "apiKey",
            label: "API key",
            kind: "secret",
            required: true,
            description: "Stored only in the global credentials file",
          },
        ],
        create(request) {
          const apiKey = request.credentials.apiKey;
          if (!apiKey) throw new Error("OpenCode Console API key is required");
          return new OpenCodeProvider({ apiKey, model: profileString(request, "model") });
        },
      });
    },
  });
}

export * from "./provider.ts";
export default createOpenCodePlugin();
