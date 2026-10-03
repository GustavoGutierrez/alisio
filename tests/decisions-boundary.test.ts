import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Case-insensitive engine names as whole words: a bare substring match would flag "rep-laya-ble".
 */
const ENGINE_NAME = /(?<![a-z])(laya|jev)(?![a-z])/i;
const root = join(import.meta.dirname, "..");

async function sources(dir: string): Promise<Array<{ file: string; text: string }>> {
  const out: Array<{ file: string; text: string }> = [];
  for (const name of await readdir(join(root, dir), { recursive: true })) {
    const file = String(name);
    if (!/\.(ts|tsx)$/.test(file)) continue;
    out.push({ file: join(dir, file), text: await readFile(join(root, dir, file), "utf8") });
  }
  return out;
}

describe("decision boundary", () => {
  it("core and SDK sources never name a concrete decision engine", async () => {
    const files = [...(await sources("packages/core/src")), ...(await sources("packages/sdk/src"))];
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter(({ text }) => ENGINE_NAME.test(text)).map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it("the runner and the permission system never import the decisions module", async () => {
    const files = [
      ...(await sources("packages/core/src/permissions")),
      ...(await sources("packages/core/src/core")).filter((f) => f.file.endsWith("runner.ts")),
    ];
    expect(files.length).toBeGreaterThan(1);
    const offenders = files
      .filter(({ text }) => /from\s+["'][^"']*decisions\/[^"']*["']/.test(text))
      .map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it("the SDK imports nothing from the core or from decision implementations", async () => {
    for (const { file, text } of await sources("packages/sdk/src"))
      expect(text, file).not.toMatch(/from\s+["']@alisio\/core|from\s+["']\.\.?\/.*decisions/);
  });
});
