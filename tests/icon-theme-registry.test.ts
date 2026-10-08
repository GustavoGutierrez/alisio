import type { IconThemeProvider } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { ExtensionRegistry } from "../packages/core/src/extensions/registry.ts";

const provider = (id: string): IconThemeProvider => ({
  id,
  label: id.toUpperCase(),
  manifestPath: `/themes/${id}/manifest.json`,
  iconsDir: `/themes/${id}/icons`,
});

describe("ExtensionRegistry.list", () => {
  it("returns every provider ranked by priority, then registration order", () => {
    const registry = new ExtensionRegistry();
    registry.register("icon-theme", provider("low"), { plugin: "alpha", priority: 1 });
    registry.register("icon-theme", provider("high"), { plugin: "alpha", priority: 9 });
    registry.register("icon-theme", provider("first"), { plugin: "beta" });
    registry.register("icon-theme", provider("second"), { plugin: "beta" });
    const listed = registry.list("icon-theme");
    expect(listed.map((entry) => entry.provider.id)).toEqual(["high", "low", "first", "second"]);
    expect(listed.map((entry) => entry.plugin)).toEqual(["alpha", "alpha", "beta", "beta"]);
  });

  it("is empty for a point with no registrations and drops a disposed provider", () => {
    const registry = new ExtensionRegistry();
    expect(registry.list("icon-theme")).toEqual([]);
    const off = registry.register("icon-theme", provider("only"), { plugin: "p" });
    expect(registry.list("icon-theme").map((entry) => entry.provider.id)).toEqual(["only"]);
    off();
    expect(registry.list("icon-theme")).toEqual([]);
  });

  it("ranks fallbacks below normal providers, matching resolve", () => {
    const registry = new ExtensionRegistry();
    registry.register("icon-theme", provider("fallback"), { plugin: "core", fallback: true });
    registry.register("icon-theme", provider("normal"), { plugin: "p", priority: -10 });
    expect(registry.list("icon-theme").map((entry) => entry.provider.id)).toEqual([
      "normal",
      "fallback",
    ]);
    expect(registry.resolve("icon-theme")?.provider.id).toBe("normal");
  });

  it("rejects an icon-theme provider with an empty id or a relative path", () => {
    const registry = new ExtensionRegistry();
    expect(() =>
      registry.register(
        "icon-theme",
        { id: "  ", label: "x", manifestPath: "/a.json", iconsDir: "/icons" },
        { plugin: "p" },
      ),
    ).toThrow(/non-empty id/);
    expect(() =>
      registry.register(
        "icon-theme",
        { id: "theme", label: "x", manifestPath: "manifest.json", iconsDir: "/icons" },
        { plugin: "p" },
      ),
    ).toThrow(/absolute/);
    expect(() =>
      registry.register(
        "icon-theme",
        { id: "theme", label: "x", manifestPath: "/a.json", iconsDir: "icons" },
        { plugin: "p" },
      ),
    ).toThrow(/absolute/);
  });
});
