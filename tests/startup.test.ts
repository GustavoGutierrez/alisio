import type {
  MascotProvider,
  Plugin,
  StartupContext,
  StartupScreenProvider,
  TerminalCapabilities,
} from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { bannerPolicy, terminalCapabilities } from "../packages/cli/src/banner.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { ExtensionRegistry } from "../packages/core/src/extensions/registry.ts";
import { PluginHost } from "../packages/core/src/plugins/host.ts";
import { ProviderRegistry } from "../packages/core/src/providers/registry.ts";
import {
  DefaultAlisioMascot,
  DefaultStartupScreen,
  pluginsSection,
  renderStartup,
  startupTips,
} from "../packages/core/src/startup/index.ts";
import { stripAnsi, visibleWidth } from "../packages/core/src/startup/text.ts";

const ANSI = /\x1b\[/;
const terminal = (over: Partial<TerminalCapabilities> = {}): TerminalCapabilities => ({
  color: false,
  unicode: true,
  columns: 100,
  interactive: true,
  ...over,
});
const base = {
  version: "0.1.0-alpha.1",
  cwd: "/home/dev/projects/alisio",
  home: "/home/dev",
  model: "test-model",
  provider: "example.test",
  facts: [
    { label: "permissions", value: "write:ask process:ask" },
    { label: "memory", value: "on" },
  ],
  tipSeed: 0,
};
const state = () => ({ getState: () => undefined, setState: () => {} });
const hostWith = async (...plugins: Plugin[]) => {
  const host = new PluginHost(new ToolRegistry(), state(), {}, new ProviderRegistry());
  for (const p of plugins) await host.activate(p, ".");
  return host;
};
const plugin = (id: string, setup: Plugin["setup"], extra: Partial<Plugin> = {}): Plugin => ({
  id,
  version: "1.0.0",
  apiVersion: 1,
  setup,
  ...extra,
});
const mascot = (id: string, text: string): MascotProvider => ({ id, render: () => [text] });
const allWithin = (lines: string[], columns: number) =>
  lines.every((l) => visibleWidth(l) <= columns);

describe("extension registry", () => {
  it("resolves the highest priority, then plugin id, then registration order", () => {
    const registry = new ExtensionRegistry();
    registry.register("mascot", mascot("low", "low"), { plugin: "zeta", priority: 1 });
    registry.register("mascot", mascot("b1", "b1"), { plugin: "beta", priority: 5 });
    registry.register("mascot", mascot("b2", "b2"), { plugin: "beta", priority: 5 });
    registry.register("mascot", mascot("a", "a"), { plugin: "alpha", priority: 5 });
    const resolved = registry.resolve("mascot");
    expect(resolved?.provider.id).toBe("a");
    expect(resolved?.plugin).toBe("alpha");
    expect(registry.conflicts()).toEqual([
      { point: "mascot", winner: "alpha/a", losers: ["beta/b1", "beta/b2"] },
    ]);
  });

  it("uses fallbacks only when nothing else is registered and unregisters on dispose", () => {
    const registry = new ExtensionRegistry();
    registry.register("mascot", mascot("default", "d"), { plugin: "core", fallback: true });
    const off = registry.register("mascot", mascot("x", "x"), { plugin: "p", priority: -50 });
    expect(registry.resolve("mascot")?.provider.id).toBe("x");
    off();
    expect(registry.resolve("mascot")?.provider.id).toBe("default");
    expect(registry.conflicts()).toEqual([]);
  });
});

describe("default startup screen", () => {
  for (const columns of [36, 60, 100, 160])
    it(`renders all sections within ${columns} columns`, async () => {
      const result = renderStartup(await hostWith(), { ...base, terminal: terminal({ columns }) });
      const text = result.lines.join("\n");
      expect(result.screen).toBe("alisio.default");
      expect(result.mascot).toBe("alisio.default");
      expect(allWithin(result.lines, columns)).toBe(true);
      for (const piece of ["Alisio", "0.1.0-alpha.1", "test-model", "example.test", "Tip"])
        expect(text).toContain(piece);
      expect(text).toContain("alisio");
      expect(result.diagnostics).toEqual([]);
    });

  it("places the mascot beside the info when wide and stacks it when narrow", async () => {
    const host = await hostWith();
    const wide = renderStartup(host, { ...base, terminal: terminal({ columns: 120 }) }).lines;
    const narrow = renderStartup(host, { ...base, terminal: terminal({ columns: 36 }) }).lines;
    expect(wide.some((l) => l.includes("Alisio") && /[≋~]/.test(l.split("Alisio")[0] ?? ""))).toBe(
      true,
    );
    expect(narrow.length).toBeGreaterThan(wide.length - 2);
  });

  it("is ASCII-only without unicode and has no ANSI without color", async () => {
    const lines = renderStartup(await hostWith(), {
      ...base,
      terminal: terminal({ unicode: false, color: false, columns: 80 }),
    }).lines;
    expect(lines.join("\n")).toMatch(/^[\x20-\x7e\n]*$/);
    const colored = renderStartup(await hostWith(), {
      ...base,
      terminal: terminal({ color: true }),
    }).lines;
    expect(colored.join("\n")).toMatch(ANSI);
    expect(renderStartup(await hostWith(), base as never).lines.join("")).not.toMatch(ANSI);
  });

  it("offers a 4-7 line mascot up to 24 columns, ASCII and compact variants", () => {
    const ctx = { version: "1", terminal: terminal() };
    const full = [DefaultAlisioMascot.render(ctx)].flat();
    expect(full.length).toBeGreaterThanOrEqual(4);
    expect(full.length).toBeLessThanOrEqual(7);
    expect(allWithin(full, 24)).toBe(true);
    const ascii = [
      DefaultAlisioMascot.render({ ...ctx, terminal: terminal({ unicode: false }) }),
    ].flat();
    expect(ascii.join("\n")).toMatch(/^[\x20-\x7e\n]*$/);
    expect(
      [DefaultAlisioMascot.render({ ...ctx, terminal: terminal({ columns: 30 }) })].flat(),
    ).toHaveLength(1);
  });

  it("rotates tips deterministically from a seed", () => {
    expect(startupTips(3)).toEqual(startupTips(3));
    expect(startupTips(0)).not.toEqual(startupTips(1));
    expect(startupTips(0).join(" ")).toMatch(/\/help/);
  });
});

describe("startup plugin summary", () => {
  const context = (plugins: StartupContext["plugins"]): StartupContext => ({
    ...base,
    terminal: terminal(),
    plugins,
    mascot: DefaultAlisioMascot,
    tips: [],
  });

  it("groups model providers without expanding their names", () => {
    const line = pluginsSection(
      context([
        ...["provider-a", "openai-compatible", "provider-b", "provider-c"].map((id) => ({
          id,
          version: "1",
          builtin: true,
          categories: ["model-provider" as const],
        })),
        { id: "memory", version: "1", builtin: true, categories: ["memory" as const] },
        { id: "subagents", version: "1", builtin: true, categories: ["subagents" as const] },
      ]),
    )[0];
    expect(line).toBe("  with 4 model providers, memory (builtin), subagents (builtin)  ");
    expect(line).not.toMatch(/provider-a|openai-compatible|provider-b|provider-c/);
  });

  it("uses singular grammar for one registered model-provider plugin", () => {
    expect(
      pluginsSection(
        context([
          {
            id: "future-provider",
            version: "1",
            builtin: true,
            categories: ["model-provider"],
          },
        ]),
      ),
    ).toEqual(["  with 1 model provider  "]);
  });

  it("derives the model-provider category from plugin registrations", async () => {
    const host = await hostWith(
      plugin("future-provider", (api) => {
        api.providers.register({
          id: "future-provider",
          name: "Future Provider",
          fields: [],
          create: () => ({ id: "future", model: "m", async *stream() {} }),
        });
      }),
      plugin("utility", () => {}),
    );
    expect(host.metadata()).toEqual([
      {
        id: "future-provider",
        version: "1.0.0",
        builtin: false,
        categories: ["model-provider"],
      },
      { id: "utility", version: "1.0.0", builtin: false },
    ]);
  });

  it("groups the real CLI builtins into model providers plus named non-providers", async () => {
    // The actual production path: every default builtin activates through the plugin host and
    // the startup screen is rendered from its metadata (not a hand-built list).
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "alisio-startup-builtins-"));
    try {
      const { BUILTIN_PLUGINS } = await import("../packages/cli/src/builtin.ts");
      const host = new PluginHost(new ToolRegistry(), state(), {}, new ProviderRegistry());
      const context = {
        workspace: root,
        cwd: root,
        stateHome: root,
        configHome: root,
        home: root,
        trusted: false,
        configDir: root,
      };
      for (const builtin of BUILTIN_PLUGINS)
        await host.activate(builtin.create({}, context), root, { builtin: true });
      const rendered = renderStartup(host, {
        ...base,
        terminal: terminal({ columns: 120 }),
      }).lines.join("\n");
      expect(rendered).toContain("with 1 model provider, memory (builtin), subagents (builtin)");
      expect(rendered).not.toMatch(/openai-compatible \(/);
      // The real built-ins now carry their declared categories in host metadata.
      const metadata = host.metadata();
      expect(metadata.find((p) => p.id === "memory")?.categories).toEqual(["memory"]);
      expect(metadata.find((p) => p.id === "subagents")?.categories).toEqual(["subagents"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("plugins extending the startup screen", () => {
  it("uses a plugin mascot inside the default screen", async () => {
    const host = await hostWith(
      plugin("kite", (api) => {
        api.extensions.register("mascot", { id: "kite", render: () => ["<>KITE<>", " /  "] });
      }),
    );
    const result = renderStartup(host, { ...base, terminal: terminal() });
    expect(result.mascot).toBe("kite");
    expect(result.screen).toBe("alisio.default");
    expect(result.lines.join("\n")).toContain("<>KITE<>");
  });

  it("uses a plugin startup screen that can reuse the resolved mascot", async () => {
    const screen: StartupScreenProvider = {
      id: "minimal",
      render: (ctx: StartupContext) => [
        `custom ${ctx.version} ${ctx.plugins.length}`,
        ...[ctx.mascot.render({ terminal: ctx.terminal, version: ctx.version })].flat(),
      ],
    };
    const host = await hostWith(
      plugin("screen", (api) => {
        api.extensions.register("startup-screen", screen);
      }),
    );
    const result = renderStartup(host, { ...base, terminal: terminal() });
    expect(result.screen).toBe("minimal");
    expect(result.lines[0]).toBe("custom 0.1.0-alpha.1 1");
    expect(result.lines.length).toBeGreaterThan(2);
  });

  it("supports the declarative extensions field and priorities", async () => {
    const host = await hostWith(
      plugin("low", () => {}, { extensions: { mascot: mascot("low", "LOW") } }),
      plugin("high", (api) => {
        api.extensions.register("mascot", mascot("high", "HIGH"), { priority: 10 });
      }),
    );
    expect(renderStartup(host, { ...base, terminal: terminal() }).mascot).toBe("high");
  });

  it("breaks equal priorities by plugin id and reports the conflict", async () => {
    const host = await hostWith(
      plugin("zulu", (api) => void api.extensions.register("mascot", mascot("z", "Z"))),
      plugin("alpha", (api) => void api.extensions.register("mascot", mascot("a", "A"))),
    );
    const result = renderStartup(host, { ...base, terminal: terminal() });
    expect(result.mascot).toBe("a");
    expect(result.diagnostics).toContainEqual({
      type: "extension_conflict",
      point: "mascot",
      winner: "alpha/a",
      losers: ["zulu/z"],
    });
  });

  it("falls back safely when providers throw or return garbage", async () => {
    const host = await hostWith(
      plugin("bad", (api) => {
        api.extensions.register("mascot", {
          id: "thrower",
          render: () => {
            throw new Error("boom");
          },
        });
        api.extensions.register("startup-screen", {
          id: "garbage",
          render: () => 42 as unknown as string[],
        });
      }),
    );
    const result = renderStartup(host, { ...base, terminal: terminal({ columns: 80 }) });
    expect(result.mascot).toBe("alisio.default");
    expect(result.screen).toBe("alisio.default");
    expect(result.lines.join("\n")).toContain("Alisio");
    expect(result.diagnostics.map((d) => `${d.type}:${"source" in d ? d.source : ""}`)).toEqual([
      "plugin_hook_failed:bad",
      "plugin_hook_failed:bad",
    ]);
  });

  it("sanitizes control sequences and clamps widths from plugin output", async () => {
    const host = await hostWith(
      plugin("wide", (api) => {
        api.extensions.register("startup-screen", {
          id: "wide",
          render: () => [`\x1b]0;title\x07\x1b[2J${"x".repeat(500)}\r\x1b[31mred\x1b[0m`],
        });
      }),
    );
    const plain = renderStartup(host, { ...base, terminal: terminal({ columns: 40 }) }).lines;
    expect(allWithin(plain, 40)).toBe(true);
    expect(plain.join("")).not.toMatch(/\x1b/);
    const colored = renderStartup(host, {
      ...base,
      terminal: terminal({ columns: 600, color: true }),
    }).lines.join("");
    expect(colored).toContain("\x1b[31m");
    expect(colored).not.toMatch(/\x1b\]|\x1b\[2J|\r/);
    expect(stripAnsi(colored)).toContain("red");
  });

  it("returns to the defaults after disposing the plugin", async () => {
    const host = await hostWith(
      plugin("kite", (api) => void api.extensions.register("mascot", mascot("kite", "KITE"))),
    );
    expect(renderStartup(host, { ...base, terminal: terminal() }).mascot).toBe("kite");
    await host.close();
    expect(renderStartup(host, { ...base, terminal: terminal() }).mascot).toBe("alisio.default");
  });
});

describe("banner policy and terminal capabilities", () => {
  const tty = { stdoutTTY: true, stderrTTY: true, env: {} };
  it("shows the banner only for interactive sessions", () => {
    expect(bannerPolicy({ ...tty, mode: "tui" })).toBe(true);
    expect(bannerPolicy({ ...tty, mode: "readline" })).toBe(true);
    for (const off of [
      { ...tty, mode: "run" as const },
      { ...tty, mode: "tui" as const, json: true },
      { ...tty, mode: "tui" as const, quiet: true },
      { ...tty, mode: "tui" as const, banner: false },
      { ...tty, mode: "tui" as const, env: { CI: "true" } },
      { ...tty, mode: "tui" as const, stdoutTTY: false },
      { ...tty, mode: "readline" as const, stderrTTY: false },
    ])
      expect(bannerPolicy(off)).toBe(false);
  });
  it("derives capabilities from TERM, NO_COLOR and the locale", () => {
    expect(
      terminalCapabilities({ env: { TERM: "xterm-256color" }, columns: 90, tty: true }),
    ).toEqual({
      color: true,
      unicode: true,
      columns: 90,
      interactive: true,
    });
    expect(terminalCapabilities({ env: { TERM: "dumb" }, columns: 90, tty: true })).toMatchObject({
      color: false,
      unicode: false,
    });
    expect(terminalCapabilities({ env: { NO_COLOR: "1" }, columns: 90, tty: true }).color).toBe(
      false,
    );
    expect(terminalCapabilities({ env: { LANG: "C" }, columns: 90, tty: true }).unicode).toBe(
      false,
    );
    // C.UTF-8 (the CI default) is a UTF-8 locale; plain C/POSIX is not.
    expect(terminalCapabilities({ env: { LANG: "C.UTF-8" }, columns: 90, tty: true }).unicode).toBe(
      true,
    );
    expect(terminalCapabilities({ env: { LC_ALL: "POSIX" }, columns: 90, tty: true }).unicode).toBe(
      false,
    );
    // Some pseudo-terminals report 0 columns: fall back to 80 instead of collapsing output.
    expect(terminalCapabilities({ env: {}, columns: 0, tty: true }).columns).toBe(80);
  });
});
