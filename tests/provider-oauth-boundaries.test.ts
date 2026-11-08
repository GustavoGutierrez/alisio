import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = new URL("../", import.meta.url).pathname;
/** Host packages and the desktop app: where no provider-specific OAuth knowledge may live (O4, D4). */
const HOST_SOURCES = ["sdk", "core", "server", "web", "cli"].map((name) => `packages/${name}/src`);
const SOURCES = [...HOST_SOURCES, "apps/desktop/src"];

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(join(repo, root), { recursive: true }).catch(() => []);
  return entries
    .filter((file) => /\.(?:[cm]?[jt]s|tsx)$/.test(file))
    .map((file) => join(root, file));
}

const FORBIDDEN: Array<[string, RegExp]> = [
  ["an OAuth client id", /\bapp_[A-Za-z0-9]{16,}\b/],
  ["the OpenAI authorization host", /auth\.openai\.com/],
  ["the dynamic client marker", /dynamic_agent_client/],
  ["the private ChatGPT backend", /chatgpt\.com\/backend-api/],
  ["the openai provider SDK", /from\s+["']openai(?:\/[^"']*)?["']|require\(["']openai["']\)/],
];

describe("no provider-specific OAuth knowledge in the host (OA-AC-36)", () => {
  it("has no client id, OpenAI endpoint, marker or provider SDK in packages/{sdk,core,server,web,cli} or apps/desktop", async () => {
    const violations: string[] = [];
    for (const root of SOURCES)
      for (const file of await sourceFiles(root)) {
        const text = await readFile(join(repo, file), "utf8");
        for (const [what, pattern] of FORBIDDEN)
          if (pattern.test(text)) violations.push(`${file}: ${what}`);
      }
    expect(violations).toEqual([]);
  });

  it("keeps @alisio/sdk free of runtime imports", async () => {
    // Every SDK source file: only type imports or relative imports of the SDK's own modules
    // (e.g. `export * from "./skills.ts"`); never a package or Node builtin at runtime.
    const dir = join(repo, "packages/sdk/src");
    const files = (await readdir(dir)).filter((name) => name.endsWith(".ts"));
    expect(files).toContain("index.ts");
    for (const name of files) {
      const text = await readFile(join(dir, name), "utf8");
      const runtimeImports = text
        .split("\n")
        .filter((line) => /^\s*(?:import|export)\b.*\bfrom\s+["']/.test(line))
        .filter((line) => !/^\s*(?:import|export)\s+type\b/.test(line))
        .filter((line) => !/\bfrom\s+["']\.\/[\w-]+\.ts["']/.test(line));
      expect(runtimeImports, name).toEqual([]);
      expect(text, name).not.toMatch(/\brequire\(/);
    }
  });
});
