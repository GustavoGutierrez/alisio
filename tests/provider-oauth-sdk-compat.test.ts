import type {
  ModelProvider,
  ProviderAuthMethod,
  ProviderCreateRequest,
  ProviderRegistration,
} from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { ProviderAuthDeclarationError, ProviderRegistry } from "../packages/core/src/index.ts";

const owner = { plugin: "test", builtin: false };
const provider = (id: string): ModelProvider => ({ id, model: "m", async *stream() {} });
const method = (id: string): ProviderAuthMethod => ({
  id,
  label: id,
  kind: "oauth",
  start: async () => ({ type: "oauth", access: "a" }),
});

describe("additive contract (OA-AC-01)", () => {
  it("an existing-style registration, written without any of the new types, still registers, creates and works", async () => {
    // This literal is what a plugin built against the previous SDK looks like: it must keep compiling.
    const old: ProviderRegistration = {
      id: "legacy",
      name: "Legacy",
      fields: [{ key: "apiKey", label: "API key", kind: "secret", required: true }],
      create: (request: ProviderCreateRequest) => provider(`legacy:${request.credentials.apiKey}`),
    };
    const registry = new ProviderRegistry();
    registry.register(old, owner);
    expect(registry.get("legacy")?.auth).toBeUndefined();
    const created = await registry.create("legacy", { profile: {}, credentials: { apiKey: "k" } });
    expect(created.id).toBe("legacy:k");
  });

  it("keeps the auth declaration of a registration that has one", () => {
    const auth = [method("browser")];
    const registry = new ProviderRegistry();
    registry.register(
      { id: "chatgpt", name: "ChatGPT", fields: [], auth, create: () => provider("c") },
      owner,
    );
    expect(registry.get("chatgpt")?.auth).toBe(auth);
    expect(registry.list()[0]?.auth?.[0]?.id).toBe("browser");
  });
});

describe("method id validation at registration (OA-AC-61)", () => {
  const register = (...ids: string[]) =>
    new ProviderRegistry().register(
      { id: "p", name: "P", fields: [], auth: ids.map(method), create: () => provider("p") },
      owner,
    );

  it.each([
    ["empty", [""]],
    ["uppercase", ["Browser"]],
    ["41 characters", ["a".repeat(41)]],
    ["characters outside [a-z0-9_-]", ["web.browser"]],
    ["a space", ["web browser"]],
    ["repeated", ["browser", "browser"]],
  ])("rejects a method id that is %s", (_name, ids) => {
    expect(() => register(...(ids as string[]))).toThrow(ProviderAuthDeclarationError);
  });

  it("rejects the registration without leaving it behind", () => {
    const registry = new ProviderRegistry();
    expect(() =>
      registry.register(
        { id: "p", name: "P", fields: [], auth: [method("Bad")], create: () => provider("p") },
        owner,
      ),
    ).toThrow(/auth method id/);
    expect(registry.get("p")).toBeUndefined();
  });

  it.each([["browser"], ["device_code-2"], ["a".repeat(40)], ["a", "b"]])(
    "accepts valid ids %j",
    (...ids) => {
      expect(() => register(...ids)).not.toThrow();
    },
  );

  it("rejects an auth value that is not an array", () => {
    expect(() =>
      new ProviderRegistry().register(
        { id: "p", name: "P", fields: [], auth: "browser" as never, create: () => provider("p") },
        owner,
      ),
    ).toThrow(ProviderAuthDeclarationError);
  });
});
