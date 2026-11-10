import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMMANDS,
  CommandCatalog,
  type CommandHost,
} from "../packages/core/src/commands/catalog.ts";
import { memoryEmbedding, memoryStore } from "./fixtures/memory-semantic.ts";
import { setupSemantic } from "./semantic-helpers.ts";

function run(setup: ReturnType<typeof setupSemantic>, withHost = true) {
  const host = {
    workspace: "/w",
    provider: { id: "p" },
    config: { agents: {}, semantic: setup.cfg },
    ...(withHost ? { semantic: { service: setup.service } } : {}),
  } as unknown as CommandHost;
  return new CommandCatalog(host)
    .execute("semantic", "", { sessionId: "s1" })
    .then((r) => r.text ?? "");
}

describe("/semantic", () => {
  it("is a read-only core built-in on every surface", () => {
    expect(BUILTIN_COMMANDS.find((c) => c.name === "semantic")).toMatchObject({
      execution: "core",
      surfaces: ["tui", "web", "api"],
    });
  });

  it("with a provider whose health never answers shows unavailable after ~1 s and finishes (SE-AC-17)", async () => {
    const setup = setupSemantic();
    setup.embedding.healthMode = "hang";
    const started = Date.now();
    const text = await run(setup);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(3000);
    expect(text).toContain("health: unavailable (health check timed out)");
    expect(text).toContain("model mem/model@1 · 16 dimensions");
    expect(text).toContain("Store: mem-store (Memory store) · health: ready");
  }, 10_000);

  it("lists registered providers with their owning plugin", async () => {
    const text = await run(setupSemantic());
    expect(text).toContain("- mem-embed (Memory embedding) · plugin provider-plugin");
    expect(text).toContain("- mem-store (Memory store) · plugin provider-plugin");
    expect(text).toContain("Status: enabled · available");
  });

  it("without providers suggests installing one, without naming a package", async () => {
    const text = await run(setupSemantic({ embedding: null, store: null }, { register: false }));
    expect(text).toContain("no provider configured");
    expect(text).toContain("No semantic provider is installed");
    expect(text).not.toMatch(/@alisio|plugin-semantic/);
  });

  it("reports a configured id that is not registered, and disabled", async () => {
    const missing = await run(setupSemantic({ store: "gone" }, { register: false }));
    expect(missing).toContain('Store: "gone" is not registered');
    expect(await run(setupSemantic({ enabled: false }))).toContain("Status: disabled");
  });

  it("a notice when the host does not offer the service", async () => {
    const text = await run(setupSemantic(), false);
    expect(text).toBe("Semantic search is unavailable here");
    void memoryEmbedding;
    void memoryStore;
  });
});
