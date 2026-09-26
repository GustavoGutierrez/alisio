import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cliInstall,
  type InstallRunner,
  installedNpmPlugins,
  installPlugin,
  npmInstallTarget,
  parsePluginSpec,
  registerPluginInstallTool,
  resolvePluginSpec,
  sanitizeNpmError,
  ToolRegistry,
} from "../packages/core/src/index.ts";

afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alisio-plugin-install-"));
  const home = join(root, "config");
  const workspace = join(root, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  vi.stubEnv("ALISIO_CONFIG_HOME", home);
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
  return { root, home, workspace };
}

/** Splits an npm install target ("pkg", "pkg@1.2.3", "@scope/pkg@1.2.3") into a package path. */
function targetName(target: string): string {
  const at = target.lastIndexOf("@");
  return at > 0 ? target.slice(0, at) : target;
}

interface NpmCall {
  command: string;
  args: string[];
  cwd: string;
}

/**
 * Fake npm that records calls, writes a minimal package under `<prefix>/node_modules/<name>` and
 * optionally fails with the given stderr. No network, no real registry.
 */
function fakeNpm(
  calls: NpmCall[],
  options: { failStdout?: string; failStderr?: string; version?: string } = {},
): InstallRunner {
  return async (command, args, { cwd }) => {
    calls.push({ command, args, cwd });
    if (options.failStderr !== undefined)
      return {
        stdout: options.failStdout ?? "",
        stderr: options.failStderr,
        exitCode: 1,
        truncated: false,
      };
    const prefixIndex = args.indexOf("--prefix");
    const prefix = args[prefixIndex + 1];
    const target = args[args.length - 1];
    if (prefix === undefined || target === undefined)
      throw new Error(`fake npm: unexpected args ${JSON.stringify(args)}`);
    const name = targetName(target);
    const dir = join(prefix, "node_modules", name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      `${JSON.stringify({ name, version: options.version ?? "1.2.3", keywords: ["alisio-plugin"] }, null, 2)}\n`,
    );
    return { stdout: "added 1 package", stderr: "", exitCode: 0, truncated: false };
  };
}

async function readGlobalConfig(home: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(home, "config.json"), "utf8")) as Record<string, unknown>;
}

describe("parsePluginSpec", () => {
  it.each([
    ["plugin-openrouter", { name: "plugin-openrouter" }],
    ["npm:plugin-openrouter", { name: "plugin-openrouter" }],
    ["npm:plugin-openrouter@1.2.3", { name: "plugin-openrouter", version: "1.2.3" }],
    ["npm:plugin-openrouter@1.2.3-beta.1", { name: "plugin-openrouter", version: "1.2.3-beta.1" }],
    ["npm:plugin-openrouter@latest", { name: "plugin-openrouter", version: "latest" }],
    ["npm:@scope/plugin-x", { name: "@scope/plugin-x" }],
    ["npm:@scope/plugin-x@1.2.3", { name: "@scope/plugin-x", version: "1.2.3" }],
    ["npm:plugin-llama-cpp", { name: "plugin-llama-cpp" }],
    ["pkg.one_two-3", { name: "pkg.one_two-3" }],
  ])("accepts %s", (spec, expected) => {
    expect(parsePluginSpec(spec)).toEqual(expected);
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["npm:", "no package name"],
    ["..", "package name"],
    ["../evil", "package name"],
    ["npm:../evil", "package name"],
    ["npm:foo/../bar", "package name"],
    ["/abs/path/p", "package name"],
    ["npm:/abs/path/p", "package name"],
    ["C:\\windows\\p", "package name"],
    ["npm:pkg; rm -rf /", "package name"],
    ["npm:pkg|cat /etc/passwd", "package name"],
    ["npm:$(evil)", "package name"],
    ["pkg &&evil", "package name"],
    ["git:foo/bar", "prefix"],
    ["registry:https://registry.npmjs.org/pkg", "registry"],
    ["file:./pkg", "prefix"],
    ["http://example.com/pkg", "prefix"],
    ["npm:pkg@", "version"],
    ["npm:pkg@1.2.3/4", "version"],
    ["npm:@scope/", "package name"],
    ["npm:@/pkg", "package name"],
    ["npm:.hidden", "package name"],
    ["npm:..", "package name"],
  ])("rejects %s (%s)", (spec, _kind) => {
    expect(() => parsePluginSpec(spec)).toThrow();
  });

  it("explains the supported forms and registry rejection", () => {
    try {
      parsePluginSpec("registry:https://registry.npmjs.org/plugin-openrouter");
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toMatch(
        /registry:.*not supported|package name directly|npm:<package>/i,
      );
    }
    try {
      parsePluginSpec("git:github.com/foo/bar");
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toMatch(/Unsupported plugin spec prefix "git:"/);
    }
  });
});

describe("installPlugin (shared routine)", () => {
  it("installs into <configHome>/plugins via npm --prefix and persists the npm name in the global config, preserving unrelated fields", async () => {
    const { home, workspace } = await fixture();
    await writeFile(
      join(home, "config.json"),
      `${JSON.stringify({ schemaVersion: 1, provider: { model: "m" }, skills: ["./keep"] }, null, 2)}\n`,
    );
    const calls: NpmCall[] = [];
    const result = await installPlugin({
      spec: "npm:plugin-openrouter",
      configHome: home,
      runner: fakeNpm(calls),
    });
    expect(calls).toEqual([
      {
        command: "npm",
        args: ["install", "--prefix", join(home, "plugins"), "plugin-openrouter"],
        cwd: join(home, "plugins"),
      },
    ]);
    // Package landed in the global plugins directory.
    const manifest = JSON.parse(
      await readFile(
        join(home, "plugins", "node_modules", "plugin-openrouter", "package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(manifest.version).toBe("1.2.3");
    expect(result).toMatchObject({
      packageName: "plugin-openrouter",
      installedVersion: "1.2.3",
      configEntry: "plugin-openrouter",
      configFile: join(home, "config.json"),
      pluginsDir: join(home, "plugins"),
      alreadyInstalled: false,
      updated: false,
    });
    expect(result.path).toBe(join(home, "plugins", "node_modules", "plugin-openrouter"));
    // Config keeps the npm NAME (not a path) and preserves unrelated fields.
    const raw = await readGlobalConfig(home);
    expect(raw.plugins).toEqual(["plugin-openrouter"]);
    expect((raw.provider as Record<string, unknown>).model).toBe("m");
    expect(raw.skills).toEqual(["./keep"]);
    expect(raw.schemaVersion).toBe(1);
    // The installed package resolves as a plugin entry from any project.
    const resolved = await resolvePluginSpec("plugin-openrouter", { from: workspace });
    expect(resolved).toContain(join(home, "plugins", "node_modules", "plugin-openrouter"));
  });

  it("supports scoped packages with a pinned version", async () => {
    const { home } = await fixture();
    const calls: NpmCall[] = [];
    const result = await installPlugin({
      spec: "npm:@scope/plugin-x@0.5.0",
      configHome: home,
      runner: fakeNpm(calls),
    });
    expect(calls[0]?.args.at(-1)).toBe("@scope/plugin-x@0.5.0");
    expect(result.packageName).toBe("@scope/plugin-x");
    const manifest = JSON.parse(
      await readFile(
        join(home, "plugins", "node_modules", "@scope", "plugin-x", "package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(manifest.version).toBe("1.2.3");
    expect((await readGlobalConfig(home)).plugins).toEqual(["@scope/plugin-x"]);
  });

  it("is idempotent: an already-installed package never reruns npm and is not duplicated in the config", async () => {
    const { home } = await fixture();
    const calls: NpmCall[] = [];
    const runner = fakeNpm(calls);
    const first = await installPlugin({ spec: "plugin-openrouter", configHome: home, runner });
    const second = await installPlugin({ spec: "npm:plugin-openrouter", configHome: home, runner });
    expect(calls).toHaveLength(1);
    expect(second.alreadyInstalled).toBe(true);
    expect(second.updated).toBe(false);
    expect(second.installedVersion).toBe(first.installedVersion);
    expect((await readGlobalConfig(home)).plugins).toEqual(["plugin-openrouter"]);
  });

  it("--update refreshes an installed package to @latest and keeps the name", async () => {
    const { home } = await fixture();
    const calls: NpmCall[] = [];
    const runner = fakeNpm(calls, { version: "2.0.0" });
    await installPlugin({ spec: "plugin-openrouter", configHome: home, runner });
    const updated = await installPlugin({
      spec: "plugin-openrouter",
      configHome: home,
      update: true,
      runner,
    });
    expect(calls.map((c) => c.args.at(-1))).toEqual([
      "plugin-openrouter",
      "plugin-openrouter@latest",
    ]);
    expect(updated.updated).toBe(true);
    expect(updated.alreadyInstalled).toBe(true);
    expect(updated.installedVersion).toBe("2.0.0");
    expect((await readGlobalConfig(home)).plugins).toEqual(["plugin-openrouter"]);
  });

  it("refuses under --read-only before any npm call or config write", async () => {
    const { home } = await fixture();
    const calls: NpmCall[] = [];
    await expect(
      installPlugin({
        spec: "plugin-openrouter",
        configHome: home,
        readOnly: true,
        runner: fakeNpm(calls),
      }),
    ).rejects.toThrow(/--read-only/);
    expect(calls).toHaveLength(0);
    await expect(readFile(join(home, "config.json"), "utf8")).rejects.toThrow();
  });

  it("sanitizes npm failure output, names the package and gives the exact retry command", async () => {
    const { home } = await fixture();
    const calls: NpmCall[] = [];
    const secret = "sky-secret-value-123";
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sigil";
    const runner = fakeNpm(calls, {
      failStderr: `npm ERR! code E401\nnpm ERR! need: _authToken ${secret}\nnpm ERR! jwt ${jwt}\nnpm ERR! some other detail\n`,
    });
    let error = "";
    try {
      await installPlugin({ spec: "plugin-openrouter", configHome: home, runner });
      expect.unreachable();
    } catch (e) {
      error = String(e);
    }
    expect(error).toContain("plugin-openrouter");
    expect(error).toContain("npm install --prefix");
    expect(error).toContain("alisio install npm:plugin-openrouter");
    expect(error).not.toContain(secret);
    expect(error).not.toContain(jwt);
  });

  it("sanitizeNpmError caps output and keeps unrelated text", () => {
    expect(sanitizeNpmError("ok line\n")).toBe("ok line\n");
    const long = "x".repeat(5000);
    const cleaned = sanitizeNpmError(long);
    expect(cleaned.length).toBeLessThan(long.length);
    expect(cleaned).toContain("truncated");
  });
});

describe("cliInstall", () => {
  it("headless (or --json) without --yes refuses with an actionable error and never runs npm", async () => {
    const { home } = await fixture();
    const calls: NpmCall[] = [];
    await expect(
      cliInstall({
        spec: "npm:plugin-openrouter",
        configHome: home,
        interactive: false,
        runner: fakeNpm(calls),
        confirm: async () => true,
      }),
    ).rejects.toThrow(/lifecycle scripts/);
    await expect(
      cliInstall({
        spec: "npm:plugin-openrouter",
        configHome: home,
        json: true,
        interactive: false,
        runner: fakeNpm(calls),
        confirm: async () => true,
      }),
    ).rejects.toThrow(/--yes/);
    expect(calls).toHaveLength(0);
  });

  it("installs with an explicit --yes in headless mode", async () => {
    const { home } = await fixture();
    const calls: NpmCall[] = [];
    const result = await cliInstall({
      spec: "npm:plugin-openrouter",
      configHome: home,
      yes: true,
      runner: fakeNpm(calls),
    });
    expect(calls).toHaveLength(1);
    expect(result.packageName).toBe("plugin-openrouter");
    expect((await readGlobalConfig(home)).plugins).toEqual(["plugin-openrouter"]);
  });

  it("interactive mode warns and asks before installing, and a decline aborts without side effects", async () => {
    const { home } = await fixture();
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      const calls: NpmCall[] = [];
      // Declined: cancelled, nothing installed.
      await expect(
        cliInstall({
          spec: "plugin-openrouter",
          configHome: home,
          interactive: true,
          confirm: async () => false,
          runner: fakeNpm(calls),
        }),
      ).rejects.toThrow(/cancelled|Cancel/);
      expect(calls).toHaveLength(0);
      // Accepted: warning shown once, npm ran.
      const accepted = await cliInstall({
        spec: "plugin-openrouter",
        configHome: home,
        interactive: true,
        confirm: async () => true,
        runner: fakeNpm(calls),
      });
      expect(calls).toHaveLength(1);
      expect(accepted.installedVersion).toBe("1.2.3");
      expect(stderr.join("\n")).toMatch(/lifecycle scripts/);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses under --read-only even with --yes", async () => {
    const { home } = await fixture();
    const calls: NpmCall[] = [];
    await expect(
      cliInstall({
        spec: "plugin-openrouter",
        configHome: home,
        yes: true,
        readOnly: true,
        runner: fakeNpm(calls),
      }),
    ).rejects.toThrow(/--read-only/);
    expect(calls).toHaveLength(0);
  });

  it("returns the trust remark about project trust and plugins list", async () => {
    const { home } = await fixture();
    const result = await cliInstall({
      spec: "plugin-openrouter",
      configHome: home,
      yes: true,
      runner: fakeNpm([]),
    });
    expect(result.trustRemark).toMatch(/--trust-project/);
    expect(result.trustRemark).toMatch(/plugins list/);
    expect(result.trustRemark).toMatch(/trust prompt/);
  });
});

describe("plugin_install tool", () => {
  it("registers with the process effect and executes through the same routine as the CLI (one fake npm)", async () => {
    const { home } = await fixture();
    const calls: NpmCall[] = [];
    const runner = fakeNpm(calls);
    const registry = new ToolRegistry();
    registerPluginInstallTool(registry, { configHome: home, runner });

    const tool = registry.get("plugin_install");
    expect(tool.effect).toBe("process");
    expect(tool.name).toBe("plugin_install");

    const toolResult = await tool.execute(
      { spec: "npm:plugin-openrouter" },
      { workspace: home, signal: AbortSignal.timeout(10_000), emit() {} },
    );
    const content = toolResult.content[0];
    if (!content) throw new Error("empty tool result");
    const parsed = JSON.parse(content.text) as Record<string, unknown>;
    expect(parsed.packageName).toBe("plugin-openrouter");
    expect(parsed.installedVersion).toBe("1.2.3");
    expect(parsed.path).toContain(join(home, "plugins", "node_modules", "plugin-openrouter"));
    expect(String(parsed.configEntry)).toBe("plugin-openrouter");
    expect(String(parsed.trustRemark)).toMatch(/--trust-project/);

    // The CLI path uses the identical routine with the same fake npm (a second, fresh package).
    await cliInstall({ spec: "npm:plugin-llama-cpp", configHome: home, yes: true, runner });
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.args.at(-1))).toEqual(["plugin-openrouter", "plugin-llama-cpp"]);
    expect(calls.every((c) => c.command === "npm" && c.args[0] === "install")).toBe(true);
    expect((await readGlobalConfig(home)).plugins).toEqual([
      "plugin-openrouter",
      "plugin-llama-cpp",
    ]);
  });

  it("is not registered under --read-only and colliding names are rejected", async () => {
    const registry = new ToolRegistry();
    registerPluginInstallTool(registry, { readOnly: true });
    expect(registry.list().some((t) => t.name === "plugin_install")).toBe(false);

    const active = new ToolRegistry();
    registerPluginInstallTool(active);
    expect(() => registerPluginInstallTool(active)).toThrow(/Duplicate tool/);
  });

  it("returns an error result for an invalid spec", async () => {
    const { home } = await fixture();
    const registry = new ToolRegistry();
    registerPluginInstallTool(registry, { configHome: home, runner: fakeNpm([]) });
    const tool = registry.get("plugin_install");
    await expect(
      tool.execute(
        { spec: "npm:../evil" },
        { workspace: home, signal: AbortSignal.timeout(10_000), emit() {} },
      ),
    ).rejects.toThrow(/package name/);
  });

  it("a real application registers the tool only when not read-only", async () => {
    const { home, workspace } = await fixture();
    const { createApplication } = await import("../packages/core/src/index.ts");
    const readOnly = await createApplication({ cwd: workspace, readOnly: true, noHerdr: true });
    try {
      expect(readOnly.registry.list().some((t) => t.name === "plugin_install")).toBe(false);
    } finally {
      await readOnly.close();
    }
    const active = await createApplication({ cwd: workspace, noHerdr: true });
    try {
      expect(active.registry.list().some((t) => t.name === "plugin_install")).toBe(true);
      expect(active.registry.get("plugin_install").effect).toBe("process");
    } finally {
      await active.close();
    }
  });
});

describe("installedNpmPlugins", () => {
  it("lists only packages declaring the alisio-plugin keyword, including scoped ones", async () => {
    const { home } = await fixture();
    const root = join(home, "plugins");
    await mkdir(join(root, "node_modules", "plugin-a"), { recursive: true });
    await mkdir(join(root, "node_modules", "@acme", "plugin-b"), { recursive: true });
    await mkdir(join(root, "node_modules", "plain-dep"), { recursive: true });
    for (const [name, keywords] of [
      ["plugin-a", ["alisio-plugin"]],
      ["@acme/plugin-b", ["alisio-plugin"]],
      ["plain-dep", []],
    ] as const) {
      await writeFile(
        join(
          root,
          "node_modules",
          ...(name.startsWith("@") ? name.split("/") : [name]),
          "package.json",
        ),
        `${JSON.stringify({ name, keywords })}\n`,
      );
    }
    const listed = await installedNpmPlugins(root);
    expect(listed).toEqual([
      join(root, "node_modules", "@acme", "plugin-b"),
      join(root, "node_modules", "plugin-a"),
    ]);
    // Skipped artifact directories are ignored.
    expect(listed.some((p) => p.includes("plain-dep"))).toBe(false);
  });
});

describe("npmInstallTarget", () => {
  it("builds npm install targets", () => {
    expect(npmInstallTarget("p")).toBe("p");
    expect(npmInstallTarget("p", "1.2.3")).toBe("p@1.2.3");
    expect(npmInstallTarget("@acme/p", "1.2.3")).toBe("@acme/p@1.2.3");
    expect(npmInstallTarget("p", undefined, true)).toBe("p@latest");
  });
});
