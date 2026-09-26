import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ProjectContext } from "../packages/core/src/resources/context.ts";

const base = await mkdtemp(join(tmpdir(), "alisio-context-"));
afterAll(() => rm(base, { recursive: true, force: true }));
let root = "";
let n = 0;
beforeEach(async () => {
  root = join(base, `w${n++}`);
  await mkdir(join(root, "sub", "deep"), { recursive: true });
  await mkdir(join(root, "pkg", "src"), { recursive: true });
});
const put = (path: string, text: string) => writeFile(join(root, path), text);

describe("AGENTS.md discovery", () => {
  it("walks root to cwd, one file per directory, override first, closest last", async () => {
    await put("AGENTS.md", "ROOT-PLAIN");
    await put("AGENTS.override.md", "ROOT-OVERRIDE");
    await put("sub/AGENTS.md", "SUB-PLAIN");
    await put("sub/deep/AGENT.md", "DEEP-LEGACY");
    const text = await new ProjectContext(root, { cwd: join(root, "sub", "deep") }).instructions();
    expect(text).not.toContain("ROOT-PLAIN");
    const order = ["ROOT-OVERRIDE", "SUB-PLAIN", "DEEP-LEGACY"].map((m) => text.indexOf(m));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toMatch(/closest .*wins/i);
    expect(text).toMatch(/explicit user prompts override/i);
  });

  it("ignores Agente.md and uses CLAUDE.md only as an opt-in fallback", async () => {
    await put("Agente.md", "SPANISH-NAME");
    await put("sub/CLAUDE.md", "CLAUDE-ONLY");
    await put("pkg/CLAUDE.md", "CLAUDE-SHADOWED");
    await put("pkg/AGENTS.md", "AGENTS-WINS");
    const cwd = join(root, "sub");
    const off = await new ProjectContext(root, { cwd }).instructions();
    expect(off).not.toContain("SPANISH-NAME");
    expect(off).not.toContain("CLAUDE-ONLY");
    const on = await new ProjectContext(root, { cwd, claudeMdFallback: true }).instructions();
    expect(on).toContain("CLAUDE-ONLY");
    const pkg = await new ProjectContext(root, {
      cwd: join(root, "pkg"),
      claudeMdFallback: true,
    }).instructions();
    expect(pkg).toContain("AGENTS-WINS");
    expect(pkg).not.toContain("CLAUDE-SHADOWED");
  });

  it("loads the global file, where AGENTS.override.md replaces AGENTS.md", async () => {
    const globalDir = join(root, "global");
    await mkdir(globalDir);
    await writeFile(join(globalDir, "AGENTS.md"), "GLOBAL-PLAIN");
    const plain = await new ProjectContext(root, { globalDir }).instructions();
    expect(plain).toContain("GLOBAL-PLAIN");
    await writeFile(join(globalDir, "AGENTS.override.md"), "GLOBAL-OVERRIDE");
    const text = await new ProjectContext(root, { globalDir }).instructions();
    expect(text).toContain("GLOBAL-OVERRIDE");
    expect(text).not.toContain("GLOBAL-PLAIN");
  });

  it("attaches nested files lazily, once per session per file", async () => {
    await put("AGENTS.md", "ROOT");
    await put("pkg/AGENTS.md", "PKG-RULES");
    const context = new ProjectContext(root);
    expect(await context.instructions("s1")).not.toContain("PKG-RULES");
    const first = await context.beforePaths(["pkg/src/a.ts"], "s1");
    expect(first).toContain("PKG-RULES");
    expect(first).toContain(join(root, "pkg", "AGENTS.md"));
    expect(await context.beforePaths(["pkg/src/b.ts"], "s1")).toBeUndefined();
    expect(await context.instructions("s1")).toContain("PKG-RULES");
    expect(await context.instructions("s2")).not.toContain("PKG-RULES");
    expect(await context.beforePaths(["pkg/src/a.ts"], "s2")).toContain("PKG-RULES");
    // A changed file is attached again.
    await put("pkg/AGENTS.md", "PKG-RULES-V2");
    expect(await context.beforePaths(["pkg/src/a.ts"], "s1")).toContain("PKG-RULES-V2");
  });

  it("caps instruction files at 32 KiB, keeping the closest and noting the truncation", async () => {
    await put("AGENTS.md", `ROOT-START${"a".repeat(30_000)}ROOT-END`);
    await put("sub/AGENTS.md", `SUB-START${"b".repeat(10_000)}SUB-END`);
    const text = await new ProjectContext(root, { cwd: join(root, "sub") }).instructions();
    expect(text).toContain("SUB-START");
    expect(text).toContain("SUB-END");
    expect(text).toMatch(/\[truncated/i);
    expect(text).not.toContain("ROOT-START");
    const fileChars = (text.match(/[ab]{100,}/g) ?? []).join("").length;
    expect(fileChars).toBeLessThanOrEqual(32 * 1024);
  });

  it("explains which file applies in each directory", async () => {
    await put("AGENTS.override.md", "O");
    await put("sub/AGENTS.md", "S");
    const explained = await new ProjectContext(root).explain("sub/deep/x.ts");
    expect(explained.map((e) => [e.path.slice(root.length), e.kind])).toEqual([
      ["/AGENTS.override.md", "override"],
      ["/sub/AGENTS.md", "agents"],
    ]);
  });
});
