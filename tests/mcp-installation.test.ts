import { describe, expect, it } from "vitest";
import { configSchema } from "../packages/core/src/index.ts";
import { mcpIdentity } from "../packages/core/src/mcp/alias.ts";

const validAlias = (alias: string) =>
  configSchema.parse({ mcp: { servers: { [alias]: { command: "node" } } } }).mcp.servers;

describe("MCP-CAT-05: registry identity versus internal alias", () => {
  it("gives two upstream names with the same slug separate identities and valid aliases", () => {
    const a = mcpIdentity("io.github.acme/files", { title: "Files" });
    const b = mcpIdentity("io.github.other/files", { title: "Files" });
    expect(a.registryName).toBe("io.github.acme/files");
    expect(b.registryName).toBe("io.github.other/files");
    expect(a.alias).not.toBe(b.alias);
    for (const identity of [a, b])
      expect(Object.keys(validAlias(identity.alias))).toEqual([identity.alias]);
    // The slash of the registry name never reaches the alias, and the slug stays readable.
    expect(a.alias).toMatch(/^files-[0-9a-f]{6}$/);
  });

  it("is stable for the same name and falls back when the title has no usable characters", () => {
    expect(mcpIdentity("io.github.acme/files", { title: "Files" }).alias).toBe(
      mcpIdentity("io.github.acme/files", { title: "Files" }).alias,
    );
    const fallback = mcpIdentity("io.github.acme/日本語", { title: "日本語" });
    expect(Object.keys(validAlias(fallback.alias))).toEqual([fallback.alias]);
  });

  it("never reuses an alias that already exists, without renaming the existing entry", () => {
    const first = mcpIdentity("io.github.acme/files", { title: "Files" });
    const second = mcpIdentity("io.github.acme/files", { title: "Files", taken: [first.alias] });
    expect(second.alias).not.toBe(first.alias);
    expect(second.alias.startsWith(`${first.alias.split("-")[0]}-`)).toBe(true);
    expect(second.registryName).toBe(first.registryName);
  });

  it("keeps a valid manual alias and rejects an invalid or colliding one", () => {
    expect(mcpIdentity("io.github.acme/files", { alias: "my-files" }).alias).toBe("my-files");
    expect(() => mcpIdentity("io.github.acme/files", { alias: "bad/alias" })).toThrow(/alias/i);
    expect(() => mcpIdentity("io.github.acme/files", { alias: "mine", taken: ["mine"] })).toThrow(
      /already/i,
    );
  });
});
