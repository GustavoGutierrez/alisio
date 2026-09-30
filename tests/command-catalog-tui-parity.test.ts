/**
 * T-06: the TUI's command set and the output of commands it delegates to the core
 * CommandCatalog stay identical to the pre-migration TUI. The legacy list and formatters below
 * are the TUI code as it was before the catalog existed (explicit reference implementations, not
 * file snapshots).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider, ToolDefinition } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { COMMANDS, reservedCommandNames, resolveCommand } from "../packages/cli/src/tui/state.ts";
import { CommandCatalog, type CommandHost } from "../packages/core/src/commands/catalog.ts";
import type { Policy } from "../packages/core/src/core/contracts.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const LEGACY_COMMANDS = [
  { name: "help", description: "Show commands and keys" },
  { name: "connect", description: "Configure a provider and choose its active model" },
  { name: "model", description: "Switch provider and model", aliases: ["models"] },
  { name: "compact", description: "Summarize older history", argumentHint: "[focus]" },
  { name: "stats", description: "Session statistics" },
  { name: "clear", description: "Start a new session", aliases: ["new"] },
  { name: "sessions", description: "List recent sessions" },
  { name: "resume", description: "Resume a session by ID or prefix", argumentHint: "<id>" },
  { name: "tools", description: "List tools and permission state" },
  { name: "plugins", description: "Browse and manage project plugins" },
  { name: "skills", description: "Browse and manage effective skills" },
  { name: "mcps", description: "Browse and manage MCP servers" },
  { name: "settings", description: "Open the settings menu", aliases: ["prefs"] },
  { name: "copy", description: "Copy the last assistant response to the clipboard" },
  {
    name: "agents",
    description: "List and switch the active agent (applies from the next prompt)",
    argumentHint: "[<verb>]",
  },
  {
    name: "effort",
    description: "Set the reasoning effort level for the active model",
    argumentHint: "[level]",
  },
  {
    name: "ask",
    description: "Ask the agent to turn your question into a multiple-choice ask_user_question",
    argumentHint: "<question>",
  },
  // Added after the migration (not legacy): the `/btw` side question.
  {
    name: "btw",
    description: "Ask a side question about the session without adding to the conversation",
    argumentHint: "[question]",
  },
  { name: "exit", description: "Exit Alisio", aliases: ["quit"] },
];
const legacyResolve = (name: string) => {
  const lower = name.toLowerCase();
  return LEGACY_COMMANDS.find((c) => c.name === lower || c.aliases?.includes(lower))?.name;
};
const legacyReserved = () => [
  ...LEGACY_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]),
  "command",
];

/** The pre-migration `toolsReport` of packages/cli/src/tui/app.ts. */
function legacyToolsReport(app: {
  runner: { policy: Readonly<Policy>; approvals: boolean };
  registry: { list(): ToolDefinition[] };
}) {
  const policy = app.runner.policy;
  const rows = app.registry
    .list()
    .map((t) => {
      const effect = t.effect ?? "external";
      const state =
        effect === "read" || effect === "internal" || policy[effect]
          ? "enabled"
          : app.runner.approvals && (effect === "write" || effect === "process")
            ? "ask"
            : "disabled";
      return `| \`${t.name}\` | ${effect} | ${state} |`;
    })
    .join("\n");
  return `**Tools**\n\n| Tool | Effect | State |\n| --- | --- | --- |\n${rows}\n\n\`ask\` prompts before running (allow once / session / deny). Use --allow-write / --allow-process to pre-allow; --read-only disables them. Paths outside the workspace ask per directory; pre-allow with --add-dir or the \`additionalDirectories\` config key. \`internal\` tools (built-in plugins) only write Alisio's own state.`;
}
/** The pre-migration `/sessions` branch: `[kind, text]` with kind `notice` or `info`. */
function legacySessions(app: CommandHost, session: string): [string, string] {
  const workspaceSessions = () =>
    app.store.list().filter((s) => s.workspace === app.workspace && s.provider === app.provider.id);
  const firstPrompt = (id: string) => {
    const first = app.store.messages(id).find((m) => m.role === "user" && !m.summary);
    return first?.role === "user" ? first.text.replace(/\s+/g, " ").slice(0, 60) : "";
  };
  const list = workspaceSessions().slice(0, 20);
  if (!list.length) return ["notice", "No sessions in this workspace"];
  return [
    "info",
    [
      "**Recent sessions** (use `/resume <id-prefix>`)",
      "",
      ...list.map(
        (s) =>
          `- \`${s.id}\` ${s.id === session ? "**(current)** " : ""}${s.model} · ${app.store.messages(s.id).length} msgs · ${firstPrompt(s.id) || "_empty_"}`,
      ),
    ].join("\n"),
  ];
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(options: { approve: boolean; policy: Policy }) {
  const root = await mkdtemp(join(tmpdir(), "alisio-parity-"));
  roots.push(root);
  const store = new SQLiteStore(join(root, "sessions.sqlite"));
  const registry = new ToolRegistry();
  for (const effect of ["read", "write", "process", "external", "internal"] as const)
    registry.register({
      name: `t_${effect}`,
      description: effect,
      inputSchema: { type: "object", properties: {} },
      effect,
      async execute() {
        return { content: [] };
      },
    });
  registry.register({
    name: "t_default",
    description: "no effect declared",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { content: [] };
    },
  });
  const provider: ModelProvider = {
    id: "test",
    model: "m",
    async *stream() {
      yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
    },
  };
  const runner = new AgentRunner({
    provider,
    registry,
    store,
    context: new ProjectContext(root),
    workspace: root,
    policy: options.policy,
    ...(options.approve ? { approve: async () => "deny" as const } : {}),
  });
  const host: CommandHost = { workspace: root, store, runner, registry, provider: { id: "test" } };
  return { root, store, host };
}

describe("CommandCatalog TUI parity (T-06)", () => {
  it("keeps the TUI command list, aliases, descriptions and hints identical", () => {
    expect(COMMANDS).toStrictEqual(LEGACY_COMMANDS);
    const tui = new CommandCatalog()
      .list("tui")
      .filter((c) => c.source === "builtin")
      .map((c) => ({
        name: c.name,
        description: c.description,
        ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
        ...(c.aliases ? { aliases: c.aliases } : {}),
      }));
    expect(tui).toStrictEqual(LEGACY_COMMANDS);
  });

  it("resolves every name, alias and unknown input exactly as before", () => {
    const inputs = [
      ...LEGACY_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]),
      "QUIT",
      "New",
      "command",
      "skill:x",
      "init",
      "nope",
      "",
    ];
    for (const input of inputs) expect(resolveCommand(input), input).toBe(legacyResolve(input));
    expect(reservedCommandNames()).toStrictEqual(legacyReserved());
  });

  it("produces the same /tools output for every policy and approval combination", async () => {
    for (const approve of [false, true])
      for (const policy of [
        { write: false, process: false, external: false },
        { write: true, process: false, external: true },
        { write: true, process: true, external: false },
      ]) {
        const fx = await fixture({ approve, policy });
        try {
          const session = fx.store.create(fx.root, "test", "m").id;
          const result = await new CommandCatalog(fx.host).execute("tools", "", {
            sessionId: session,
          });
          expect(result.text).toBe(legacyToolsReport(fx.host));
          expect(result.tone ?? "info").toBe("info");
        } finally {
          fx.store.close();
        }
      }
  });

  it("produces the same /sessions output, including the empty notice", async () => {
    const fx = await fixture({
      approve: false,
      policy: { write: false, process: false, external: false },
    });
    try {
      const catalog = new CommandCatalog(fx.host);
      const run = async (session: string): Promise<[string, string]> => {
        const result = await catalog.execute("sessions", "", { sessionId: session });
        return [result.tone ?? "info", result.text ?? ""];
      };
      expect(await run("none")).toEqual(legacySessions(fx.host, "none"));
      // Older sessions beyond the 20 most recent are cut off.
      for (let i = 0; i < 22; i++) fx.store.create(fx.root, "test", `bulk-${i}`);
      const a = fx.store.create(fx.root, "test", "m").id;
      fx.store.append(a, { role: "user", text: "context", summary: true });
      fx.store.append(a, { role: "user", text: `first   prompt\n${"x".repeat(80)}` });
      const b = fx.store.create(fx.root, "test", "m2").id;
      fx.store.create(fx.root, "other-provider", "m");
      fx.store.create(join(fx.root, "elsewhere"), "test", "m");
      for (const current of [a, b])
        expect(await run(current)).toEqual(legacySessions(fx.host, current));
    } finally {
      fx.store.close();
    }
  });
});
