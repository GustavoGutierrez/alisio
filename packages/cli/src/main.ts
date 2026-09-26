#!/usr/bin/env node
import { Command } from "commander";

const VERSION = "0.1.0-alpha.1";
function parseAgents(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      '--agents expects a JSON object: {"name":{"description":"...","prompt":"..."}}',
    );
  return value as Record<string, unknown>;
}
/** Built-in plugins and prompt templates, and the slash names templates may not take. */
async function cliDefaults() {
  const [{ BUILTIN_PLUGINS }, { BUILTIN_PROMPTS }, { reservedCommandNames }] = await Promise.all([
    import("./builtin.ts"),
    import("./prompts/index.ts"),
    import("./tui/state.ts"),
  ]);
  return {
    builtins: BUILTIN_PLUGINS,
    builtinPrompts: BUILTIN_PROMPTS,
    reservedPromptNames: reservedCommandNames(),
  };
}
const program = new Command();
program
  .name("alisio")
  .description("Velocidad y eficiencia para construir — extensible coding harness")
  .version("0.1.0-alpha.1")
  .option("--cwd <path>", "Working directory")
  .option("--config <path>", "Explicit trusted configuration file")
  .option("--trust-project", "Load project config and executable plugins (full process privileges)")
  .option("--plugin <path...>", "Load explicitly trusted local plugins")
  .option("--model <id>", "Provider model ID")
  .option("--base-url <url>", "OpenAI-compatible API base URL, including /v1 if needed")
  .option("--api-mode <mode>", "chat or responses")
  .option("--allow-write", "Allow file writes")
  .option("--allow-process", "Allow arbitrary subprocesses; not sandboxed")
  .option("--allow-external", "Allow network tools: webfetch, websearch and provider-native search")
  .option("--allow-mcp", "Allow configured MCP servers and remote tool calls")
  .option("--allow-agents", "Allow messaging neighboring agents through Herdr")
  .option("--no-herdr", "Disable automatic Herdr lifecycle reports")
  .option(
    "--read-only",
    "Disable writes, arbitrary processes, network tools, executable plugins and MCP",
  )
  .option("--db <path>", "Session database")
  .option("--json", "Emit versioned JSONL events")
  .option("--no-tui", "Use the plain readline interactive mode instead of the TUI")
  .option("--disable-plugin <ids...>", "Disable built-in plugins (for example: memory)")
  .option("--no-banner", "Do not show the startup screen")
  .option(
    "--agents <json>",
    'Extra subagent definitions as JSON: {"name":{"description":"...","prompt":"..."}}',
  )
  .option("--quiet", "Suppress non-essential output (startup screen, hints)");
const options = (cmd: Command) => {
  const o = cmd.optsWithGlobals();
  return {
    ...o,
    baseURL: o.baseUrl,
    noHerdr: o.herdr === false,
    disablePlugins: o.disablePlugin,
    ...(o.agents
      ? { pluginOptions: { subagents: { agents: parseAgents(String(o.agents)) } } }
      : {}),
  } as import("@alisio/core").AppOptions & { json?: boolean; quiet?: boolean; banner?: boolean };
};
/**
 * A one-time, plain (pre-alt-screen) yes/no prompt. It must run before the TUI (and before
 * `createApplication`, which is what actually reads `.alisio/config.json`) exists, since the
 * decision made here controls whether that read happens at all — the TUI's own interactive
 * question queue is built from an already-created Application, too late for this.
 */
async function promptTrust(workspace: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  process.stderr.write(
    `\nThis directory has Alisio project configuration: ${workspace}\n` +
      "Trusting it lets Alisio load that configuration for this and future runs — including a " +
      "possibly different provider endpoint or API key — plus its plugins, agents, skills and " +
      "prompt templates. Declining uses Alisio's own defaults instead; nothing here is read.\n",
  );
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question("Trust this project's Alisio configuration? [y/N] "))
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
/**
 * Resolves the effective `trustProject` for an interactive TUI run: an explicit
 * `--trust-project`/`--config` is untouched (that is already one-run, explicit trust, never
 * persisted here as though it were an interactive grant). Otherwise, a workspace with project
 * resources to trust gets a one-time prompt (re-asked only when `.alisio/config.json` changes),
 * persisted in the trust store; a workspace with nothing to trust is never prompted at all.
 */
async function withProjectTrust<
  T extends { trustProject?: boolean; config?: string; cwd?: string },
>(opts: T): Promise<T> {
  if (opts.trustProject || opts.config) return opts;
  const { findWorkspace, resolveTrust, setTrust } = await import("@alisio/core");
  const workspace = await findWorkspace(opts.cwd ?? process.cwd());
  const resolution = await resolveTrust(workspace);
  if (!resolution.hasProjectResources) return opts;
  if (!resolution.needsPrompt) return { ...opts, trustProject: resolution.trusted };
  const trusted = await promptTrust(workspace);
  await setTrust(workspace, trusted, resolution.configHash);
  return { ...opts, trustProject: trusted };
}
async function run(cmd: Command, prompt?: string, sessionId?: string) {
  const opts = options(cmd);
  if (
    !prompt &&
    !opts.json &&
    (opts as { tui?: boolean }).tui !== false &&
    process.stdin.isTTY &&
    process.stdout.isTTY
  ) {
    const { runTui } = await import("./tui/app.ts");
    const trusted = await withProjectTrust(opts);
    return runTui({ ...trusted, ...(sessionId ? { session: sessionId } : {}) });
  }
  const { createApplication } = await import("@alisio/core");
  const app = await createApplication({
    ...(await cliDefaults()),
    ...opts,
    onEvent: (event) => {
      if (opts.json) process.stdout.write(`${JSON.stringify(event)}\n`);
      else if (event.type === "text_delta")
        process.stdout.write(String((event.data as { delta: string }).delta));
      else if (event.type === "tool_started")
        process.stderr.write(`\n→ ${(event.data as { name: string }).name}\n`);
    },
  });
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Interrupted"));
  process.on("SIGINT", interrupt);
  // `/name args` runs a prompt template (same syntax as the TUI); refuse before creating a session.
  let template: ReturnType<typeof app.expandPrompt>;
  try {
    template = prompt ? app.expandPrompt(prompt) : undefined;
  } catch (error) {
    await app.close();
    throw error;
  }
  let session =
    sessionId ?? app.store.create(app.workspace, app.provider.id, app.provider.model).id;
  try {
    // Sessions record their model; an explicit --model switches it for the next turns.
    if (sessionId && opts.model && app.store.get(session).model !== opts.model)
      app.runner.setModel(session, opts.model);
    await app.herdr.report("idle", session);
    if (prompt) {
      const match = /^\/skill:([a-z0-9-]+)\s*([\s\S]*)$/.exec(prompt);
      if (match?.[1])
        prompt = `${await app.skills.load(match[1])}\n\nUser request: ${match[2] ?? ""}`;
      await app.runner.run(
        session,
        template?.text ?? prompt,
        controller.signal,
        template ? { display: template.display } : {},
      );
      if (!opts.json) process.stdout.write(`\nSession: ${session}\n`);
      return;
    }
    if (opts.json || !process.stdin.isTTY)
      throw new Error("Provide a prompt with run, or use an interactive terminal");
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("SIGINT", interrupt);
    controller.signal.addEventListener("abort", () => rl.close(), { once: true });
    const { bannerPolicy, startupInput, terminalCapabilities } = await import("./banner.ts");
    if (
      bannerPolicy({
        mode: "readline",
        ...opts,
        stdoutTTY: !!process.stdout.isTTY,
        stderrTTY: !!process.stderr.isTTY,
        env: process.env,
      })
    ) {
      const { renderStartup } = await import("@alisio/core");
      const terminal = terminalCapabilities({
        env: process.env,
        columns: process.stderr.columns ?? 80,
        tty: true,
      });
      const banner = renderStartup(
        app.plugins,
        startupInput(app, { version: VERSION, readOnly: !!opts.readOnly, terminal }),
      );
      process.stderr.write(`${banner.lines.join("\n")}\n`);
      for (const d of banner.diagnostics) process.stderr.write(`[startup] ${JSON.stringify(d)}\n`);
    }
    if (!opts.quiet) console.log("Alisio · /exit /new /skill:name /command plugin.id:name args");
    process.stdout.write("\nalisio › ");
    try {
      for await (const rawLine of rl) {
        if (controller.signal.aborted) break;
        const line = rawLine.trim();
        if (!line) continue;
        if (line === "/exit") break;
        if (line === "/new") {
          session = app.store.create(app.workspace, app.provider.id, app.provider.model).id;
          await app.herdr.report("idle", session);
          process.stdout.write("\nalisio › ");
          continue;
        }
        if (line.startsWith("/command ")) {
          const [name, ...args] = line.slice(9).split(" ");
          const handler = app.plugins.commands.get(name ?? "");
          if (!handler) throw new Error("Unknown plugin command");
          console.log(await handler(args.join(" ")));
          continue;
        }
        const match = /^\/skill:([a-z0-9-]+)\s*([\s\S]*)$/.exec(line);
        const input = match?.[1] ? `${await app.skills.load(match[1])}\n\n${match[2] ?? ""}` : line;
        try {
          const template = app.expandPrompt(input);
          await app.runner.run(
            session,
            template?.text ?? input,
            controller.signal,
            template ? { display: template.display } : {},
          );
        } catch (e) {
          console.error(String(e));
        }
        process.stdout.write("\nalisio › ");
      }
    } finally {
      rl.close();
    }
  } finally {
    process.off("SIGINT", interrupt);
    await app.close();
  }
}
program
  .command("run")
  .description('Run one prompt headless; "/name args" runs a prompt template (e.g. "/init")')
  .argument("<prompt>")
  .action((prompt, _options, cmd) => run(cmd, prompt));
program
  .command("resume")
  .argument("<session>")
  .argument("[prompt]")
  .action((id, prompt, _opts, cmd) => run(cmd, prompt, id));
program.action((_opts, cmd) => run(cmd));
program
  .command("setup")
  .description("Write an example configuration without secrets (for AGENTS.md use /init)")
  .action(async (_opts, cmd) => {
    const { resolve, join } = await import("node:path");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { exists } = await import("@alisio/core");
    const path = join(resolve(options(cmd).cwd ?? process.cwd()), ".alisio", "config.json");
    if (await exists(path)) throw new Error(`Configuration exists: ${path}`);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({ schemaVersion: 1, provider: { baseURL: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", model: "YOUR_MODEL_ID", apiMode: "chat", auth: "bearer", tokenParameter: "max_tokens", streamUsage: false }, plugins: [], skills: [], mcp: { servers: {} } }, null, 2)}\n`,
    );
    console.log(
      `Created ${path}. Set your model, endpoint and environment key. Use --config ${path}.`,
    );
    console.log(
      'To generate AGENTS.md for this project, run /init inside alisio (or: alisio run "/init" --allow-write).',
    );
  });
program.command("doctor").action(async (_opts, cmd) => {
  const { findWorkspace, loadConfig, which } = await import("@alisio/core");
  const o = options(cmd);
  const workspace = await findWorkspace(o.cwd ?? process.cwd());
  const config = await loadConfig(workspace, {
    file: o.config,
    trustProject: o.trustProject,
    model: o.model,
    baseURL: o.baseURL,
    apiMode: o.apiMode,
  });
  const status = {
    version: "0.1.0-alpha.1",
    runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`,
    platform: process.platform,
    workspace,
    git: (await which("git")) ?? null,
    ripgrep: (await which("rg")) ?? null,
    provider: {
      baseURL: config.provider.baseURL,
      apiMode: config.provider.apiMode,
      model: !config.provider.model
        ? "not configured"
        : config.provider.model === "YOUR_MODEL_ID"
          ? "not configured (placeholder from `alisio setup` — edit .alisio/config.json)"
          : config.provider.model,
      auth: config.provider.auth,
      keyConfigured: config.provider.auth === "none" || !!process.env[config.provider.apiKeyEnv],
    },
  };
  console.log(JSON.stringify(status, null, 2));
  if (!config.provider.model || config.provider.model === "YOUR_MODEL_ID")
    console.error(
      "\nNo model configured yet: set provider.model in your config, --model, or ALISIO_MODEL " +
        "before starting a real conversation (it will otherwise fail on the first turn).",
    );
});
const trust = program.command("trust").description("Inspect or revoke per-directory project trust");
trust.command("list").action(async () => {
  const { listTrust } = await import("@alisio/core");
  console.log(JSON.stringify(await listTrust(), null, 2));
});
trust
  .command("revoke")
  .argument("<path>")
  .description("Revoke a workspace's stored trust decision (re-prompts next time)")
  .action(async (path) => {
    const { revokeTrust } = await import("@alisio/core");
    const { resolve } = await import("node:path");
    const { realpath } = await import("node:fs/promises");
    const workspace = await realpath(resolve(path)).catch(() => resolve(path));
    const removed = await revokeTrust(workspace);
    console.log(
      removed ? `Revoked trust for ${workspace}` : `No stored trust decision for ${workspace}`,
    );
  });
const sessions = program.command("sessions");
async function openStore(cmd: Command) {
  const { SQLiteStore } = await import("@alisio/core");
  const { stateHome } = await import("@alisio/core");
  const { join } = await import("node:path");
  return new SQLiteStore(options(cmd).db ?? join(stateHome(), "sessions.sqlite"));
}
sessions.command("list").action(async (_opts, cmd) => {
  const store = await openStore(cmd);
  try {
    console.log(JSON.stringify(store.list(), null, 2));
  } finally {
    store.close();
  }
});
sessions
  .command("recover")
  .argument("<session>")
  .requiredOption("--acknowledge", "Acknowledge uncertain effects after inspecting the workspace")
  .action(async (id, _opts, cmd) => {
    const store = await openStore(cmd);
    try {
      store.acquire(id);
      try {
        store.reconcile(id, true);
      } finally {
        store.release(id);
      }
      console.log("Session recovered. Uncertain operations were not replayed.");
    } finally {
      store.close();
    }
  });
program
  .command("context")
  .command("explain")
  .argument("<path>")
  .action(async (path, _opts, cmd) => {
    const { ProjectContext } = await import("@alisio/core");
    const { findWorkspace } = await import("@alisio/core");
    const { resolve } = await import("node:path");
    const cwd = resolve(options(cmd).cwd ?? process.cwd());
    const root = await findWorkspace(cwd);
    console.log(
      JSON.stringify(await new ProjectContext(root).explain(resolve(cwd, path)), null, 2),
    );
  });
const skills = program.command("skills");
for (const name of ["list", "validate"]) {
  skills
    .command(name)
    .argument("[path]")
    .action(async (path, _opts, cmd) => {
      const { Skills, configHome, findWorkspace, loadConfig, skillRoots } = await import(
        "@alisio/core"
      );
      const { resolve } = await import("node:path");
      const { homedir } = await import("node:os");
      const o = options(cmd),
        cwd = resolve(o.cwd ?? process.cwd()),
        root = await findWorkspace(cwd);
      const config = await loadConfig(root, { file: o.config, trustProject: o.trustProject });
      const roots = skillRoots({
        workspace: root,
        cwd,
        home: homedir(),
        configHome: configHome(),
        trusted: !!o.trustProject || !!o.config,
        configSkills: config.skills,
      });
      const catalog = new Skills();
      await catalog.discover(path ? [resolve(cwd, path)] : roots);
      console.log(
        JSON.stringify(
          { skills: [...catalog.items.values()], diagnostics: catalog.diagnostics },
          null,
          2,
        ),
      );
      if (name === "validate" && catalog.diagnostics.length) process.exitCode = 1;
    });
}
const plugins = program.command("plugins");
plugins.command("list").action(async (_opts, cmd) => {
  const { discoverPlugins } = await import("@alisio/core");
  const { configHome } = await import("@alisio/core");
  const { join, resolve } = await import("node:path");
  console.log(
    JSON.stringify(
      {
        global: await discoverPlugins(join(configHome(), "plugins")),
        project: await discoverPlugins(
          join(resolve(options(cmd).cwd ?? process.cwd()), ".alisio", "plugins"),
        ),
        explicit: options(cmd).plugin ?? [],
      },
      null,
      2,
    ),
  );
});
plugins.command("doctor").action(async (_opts, cmd) => {
  const { createApplication } = await import("@alisio/core");
  const app = await createApplication({
    ...(await cliDefaults()),
    ...options(cmd),
    provider: {
      id: "inspection",
      model: "none",
      stream() {
        throw new Error("Inspection provider cannot run prompts");
      },
    },
  });
  try {
    console.log(
      JSON.stringify(
        {
          tools: app.registry
            .list()
            .filter((t) => t.name.startsWith("p_"))
            .map((t) => t.name),
          extensions: {
            mascot: app.plugins.extensions.resolve("mascot")?.provider.id ?? "alisio.default",
            startupScreen:
              app.plugins.extensions.resolve("startup-screen")?.provider.id ?? "alisio.default",
            conflicts: app.plugins.extensions.conflicts(),
          },
          commands: [...app.plugins.commandInfo.entries()]
            .filter(([, info]) => !info.builtin)
            .map(([name]) => name),
          builtin: [...app.plugins.builtins],
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
});
const mcp = program.command("mcp");
mcp.command("list").action(async (_opts, cmd) => {
  const { loadConfig } = await import("@alisio/core");
  const o = options(cmd);
  const config = await loadConfig(o.cwd ?? process.cwd(), {
    file: o.config,
    trustProject: o.trustProject,
  });
  console.log(JSON.stringify(Object.keys(config.mcp.servers), null, 2));
});
mcp
  .command("doctor")
  .argument("<server>")
  .action(async (server, _opts, cmd) => {
    const o = options(cmd);
    if (!o.allowMcp) throw new Error("Use --allow-mcp to start or connect to a configured server");
    const { createApplication } = await import("@alisio/core");
    const app = await createApplication({
      ...(await cliDefaults()),
      ...o,
      provider: {
        id: "inspection",
        model: "none",
        stream() {
          throw new Error("Inspection only");
        },
      },
    });
    try {
      console.log(
        JSON.stringify(await app.mcp.connect(server, AbortSignal.timeout(15000)), null, 2),
      );
    } finally {
      await app.close();
    }
  });
try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
