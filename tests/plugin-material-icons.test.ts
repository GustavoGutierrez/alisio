import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { IconThemeProvider, Plugin, PluginAPI } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import materialIconsPlugin, {
  createMaterialIconsPlugin,
} from "../packages/plugin-material-icons/src/index.ts";

const packageRoot = resolve("packages/plugin-material-icons");

/** The plugin's `setup` only touches `api.extensions.register`; capture what it registers. */
function register(plugin: Plugin): Array<{ point: string; provider: IconThemeProvider }> {
  const registered: Array<{ point: string; provider: IconThemeProvider }> = [];
  const api = {
    extensions: {
      register(point: string, provider: IconThemeProvider) {
        registered.push({ point, provider });
        return () => {};
      },
    },
  } as unknown as PluginAPI;
  plugin.setup(api);
  return registered;
}

function manifestOf(provider: IconThemeProvider): { iconDefinitions: Record<string, unknown> } {
  return JSON.parse(readFileSync(provider.manifestPath, "utf8")) as {
    iconDefinitions: Record<string, unknown>;
  };
}

describe("@alisio/plugin-material-icons", () => {
  it("registers one icon-theme provider whose manifest and icons exist on disk", () => {
    const registered = register(createMaterialIconsPlugin());

    expect(registered).toHaveLength(1);
    expect(registered[0]?.point).toBe("icon-theme");
    const provider = registered[0]?.provider;
    expect(provider).toBeDefined();
    expect(provider?.id).toBe("material-icon-theme");
    expect(provider?.label).toBe("Material Icon Theme");

    expect(isAbsolute(provider?.manifestPath ?? "")).toBe(true);
    expect(statSync(provider?.manifestPath ?? "").isFile()).toBe(true);
    expect(
      Object.keys(manifestOf(provider as IconThemeProvider).iconDefinitions).length,
    ).toBeGreaterThan(0);

    expect(isAbsolute(provider?.iconsDir ?? "")).toBe(true);
    expect(statSync(provider?.iconsDir ?? "").isDirectory()).toBe(true);
  });

  it("is self-contained: vendored assets at the package root, no material-icon-theme dependency", () => {
    const provider = register(createMaterialIconsPlugin())[0]?.provider as IconThemeProvider;

    // Vendored: both paths live in the package root, so no createRequire/resolution is involved.
    expect(dirname(provider.manifestPath)).toBe(packageRoot);
    expect(dirname(provider.iconsDir)).toBe(packageRoot);
    expect(basename(provider.manifestPath)).toBe("material-icons.json");
    expect(basename(provider.iconsDir)).toBe("icons");
    expect(existsSync(join(packageRoot, "icons"))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      files?: string[];
    };
    for (const section of ["dependencies", "devDependencies", "peerDependencies"] as const)
      expect(Object.keys(manifest[section] ?? {})).not.toContain("material-icon-theme");
    expect(manifest.files).toContain("icons");
    expect(manifest.files).toContain("material-icons.json");
    expect(manifest.files).toContain("LICENSE.material-icon-theme");

    const source = readFileSync(join(packageRoot, "src", "index.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']material-icon-theme["']/);
    expect(source).not.toMatch(/require\(\s*["']material-icon-theme["']\s*\)/);
    expect(source).not.toMatch(/createRequire/);
  });

  it("exposes a ready-to-load default Plugin for external installation", () => {
    expect(materialIconsPlugin.id).toBe("material-icons");
    expect(materialIconsPlugin.apiVersion).toBe(1);
    expect(materialIconsPlugin.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(materialIconsPlugin.categories).toEqual(["ui"]);
    expect(register(materialIconsPlugin).map((entry) => entry.provider.id)).toEqual([
      "material-icon-theme",
    ]);
  });
});
