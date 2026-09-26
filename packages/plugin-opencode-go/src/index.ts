import { definePlugin, type Plugin, type ProviderCreateRequest } from "@alisio/sdk";
import { OpenCodeGoProvider } from "./provider.ts";

const profileString = (request: ProviderCreateRequest, key: string) =>
  typeof request.profile[key] === "string" ? String(request.profile[key]) : "";

export function createOpenCodeGoPlugin(): Plugin {
  return definePlugin({
    id: "opencode-go",
    name: "OpenCode Go",
    description: "OpenCode Go multi-protocol model gateway",
    categories: ["model-provider"],
    version: "0.1.0-alpha.1",
    apiVersion: 1,
    setup(api) {
      api.providers.register({
        id: "opencode-go",
        name: "OpenCode Go",
        description: "OpenCode Go multi-protocol model gateway",
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
          if (!apiKey) throw new Error("OpenCode Go API key is required");
          return new OpenCodeGoProvider({ apiKey, model: profileString(request, "model") });
        },
      });
    },
  });
}

export * from "./provider.ts";
export default createOpenCodeGoPlugin();
