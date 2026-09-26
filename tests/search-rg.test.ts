import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { Skills } from "../packages/core/src/resources/skills.ts";
import { isMissingCommand, RIPGREP_INSTALL_HINT } from "../packages/core/src/runtime/process.ts";
import { registerStandard } from "../packages/core/src/tools/standard.ts";

afterEach(() => vi.unstubAllEnvs());

const rgAvailable = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;

describe("ripgrep dependency handling", () => {
  it("classifies spawn ENOENT as a missing command", () => {
    expect(isMissingCommand({ code: "ENOENT" })).toBe(true);
    expect(isMissingCommand(new Error("spawn rg ENOENT"))).toBe(false);
    expect(isMissingCommand(undefined)).toBe(false);
    expect(isMissingCommand("boom")).toBe(false);
  });

  it("explains how to install ripgrep per platform", () => {
    expect(RIPGREP_INSTALL_HINT).toMatch(/apt install ripgrep/);
    expect(RIPGREP_INSTALL_HINT).toMatch(/brew install ripgrep/);
    expect(RIPGREP_INSTALL_HINT).toMatch(/winget|scoop/);
  });

  it("surfaces the install hint instead of a raw ENOENT when rg is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-rg-missing-"));
    await writeFile(join(root, "a.txt"), "needle");
    // PATH without rg: runProcess spawns `rg` and rejects with ENOENT.
    vi.stubEnv("PATH", join(tmpdir(), "alisio-rg-empty-path"));
    const reg = new ToolRegistry();
    registerStandard(reg, root, new Skills(), new ProjectContext(root));
    const ctx = { signal: AbortSignal.timeout(5_000), workspace: root, emit: () => {} };
    await expect(reg.get("search_text").execute({ pattern: "needle" }, ctx)).rejects.toThrow(
      RIPGREP_INSTALL_HINT,
    );
    await expect(reg.get("list_files").execute({ path: "." }, ctx)).rejects.toThrow(
      RIPGREP_INSTALL_HINT,
    );
  });

  it.skipIf(!rgAvailable)("keeps search working when rg exists on PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-rg-present-"));
    await writeFile(join(root, "a.txt"), "needle");
    const reg = new ToolRegistry();
    registerStandard(reg, root, new Skills(), new ProjectContext(root));
    const ctx = { signal: AbortSignal.timeout(5_000), workspace: root, emit: () => {} };
    const result = await reg.get("search_text").execute({ pattern: "needle" }, ctx);
    expect(JSON.stringify(result)).toContain("needle");
  });
});
