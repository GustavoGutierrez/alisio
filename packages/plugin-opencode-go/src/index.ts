import { definePlugin, type Plugin, type ProviderCreateRequest } from "@alisio/sdk";
import { OpenCodeGoProvider } from "./provider.ts";
import { loadVersion } from "./version.ts";

const profileString = (request: ProviderCreateRequest, key: string) =>
  typeof request.profile[key] === "string" ? String(request.profile[key]) : "";

export function createOpenCodeGoPlugin(): Plugin {
  return definePlugin({
    id: "opencode-go",
    name: "OpenCode Go",
    description: "OpenCode Go multi-protocol model gateway",
    categories: ["model-provider"],
    version: loadVersion(import.meta.url),
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
