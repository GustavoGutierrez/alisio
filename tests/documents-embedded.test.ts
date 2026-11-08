import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  embeddedModuleSource,
  materializeAssets,
} from "../packages/core/src/documents/embedded.ts";
import { ASSETS_ROOT } from "../packages/core/src/documents/themes.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alisio-embedded-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("embedded document assets (D-28)", () => {
  it("generates a module with every theme and font file, within the 4 MB budget", async () => {
    const source = await embeddedModuleSource(ASSETS_ROOT);
    expect(source.length).toBeLessThan(4 * 1024 * 1024);
    const file = join(root, "mod.mjs");
    await writeFile(file, source);
    const { EMBEDDED_ASSETS } = (await import(file)) as {
      EMBEDDED_ASSETS: { version: string; files: Record<string, string> };
    };
    const names = Object.keys(EMBEDDED_ASSETS.files);
    expect(names).toEqual(
      expect.arrayContaining([
        "base/print-base.css",
        "base/fonts.css",
        "fonts/coverage.json",
        "themes/executive-clean/manifest.json",
        "fonts/inter/inter-latin-400-normal.woff2",
      ]),
    );
    expect(EMBEDDED_ASSETS.version).toMatch(/^[0-9a-f]{16}$/);
    expect(
      Buffer.from(
        EMBEDDED_ASSETS.files["themes/executive-clean/manifest.json"] as string,
        "base64",
      ).toString(),
    ).toBe(await readFile(join(ASSETS_ROOT, "themes/executive-clean/manifest.json"), "utf8"));
  });

  it("extracts the files once, byte for byte, and skips unsafe names", async () => {
    const assets = {
      version: "v1",
      files: {
        "a/b.txt": Buffer.from("hello").toString("base64"),
        "../escape.txt": Buffer.from("x").toString("base64"),
      },
    };
    const target = join(root, "out");
    const dir = await materializeAssets(assets, target);
    expect(dir).toBe(`${target}/`);
    expect(await readFile(join(target, "a", "b.txt"), "utf8")).toBe("hello");
    await expect(stat(join(root, "escape.txt"))).rejects.toThrow();
    await writeFile(join(target, "a", "b.txt"), "changed");
    await materializeAssets(assets, target);
    expect(await readFile(join(target, "a", "b.txt"), "utf8")).toBe("changed");
    await mkdir(join(root, "keep"), { recursive: true });
  });
});
