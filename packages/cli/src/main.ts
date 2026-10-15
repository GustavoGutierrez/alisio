#!/usr/bin/env node
import { Command } from "commander";
import { loadVersion } from "./version.ts";

const VERSION = loadVersion(import.meta.url);
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
/** Commander collector of a repeatable option. */
const collect = (value: string, previous: string[]): string[] => [...previous, value];
const program = new Command();
program
  .name("alisio")
  .description("Velocidad y eficiencia para construir — extensible coding harness")
  .version(VERSION)
  .option("--cwd <path>", "Working directory")
  .option("--config <path>", "Explicit trusted configuration file")
  .option("--trust-project", "Load project config and executable plugins (full process privileges)")
  .option("--plugin <path...>", "Load explicitly trusted local plugins")
  .option("--model <id>", "Provider model ID")
  .option("--base-url <url>", "OpenAI-compatible API base URL, including /v1 if needed")
  .option("--api-mode <mode>", "chat or responses")
  .option("--allow-write", "Allow file writes")
  .option("--allow-process", "Allow arbitrary subprocesses; not sandboxed")
  .option(
    "--allow-analysis",
    "Allow Python analysis (python_run) without asking; not sandboxed, never allows shell",
  )
  .option("--python <path>", "Python 3.10+ interpreter for python_run (default: discovered)")
  .option("--allow-external", "Allow network tools: webfetch, websearch and provider-native search")
  .option("--allow-mcp", "Allow configured MCP servers and remote tool calls")
  .option("--allow-agents", "Allow messaging neighboring agents through Herdr")
  .option(
    "--add-dir <paths...>",
    "Additional directories tools may read/write outside the workspace (repeatable)",
  )
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
    addDirs: o.addDir,
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
  const proofFlags = opts as unknown as import("./proof.ts").ProofFlags;
  // Invalid criteria fail before a session or a provider exists.
  const proofCriteria =
    proofFlags.criterion?.length || proofFlags.verify?.length || proofFlags.proofFile
      ? await (await import("./proof.ts")).collectProofCriteria(proofFlags)
      : [];
  const { createApplication, formatBytes, KIND_LABELS } = await import("@alisio/core");
  const app = await createApplication({
    ...(await cliDefaults()),
    ...opts,
    onEvent: (event) => {
      if (opts.json) process.stdout.write(`${JSON.stringify(event)}\n`);
      else if (event.type === "text_delta")
        process.stdout.write(String((event.data as { delta: string }).delta));
      else if (event.type === "request_retry") {
        const retry = event.data as import("@alisio/sdk").RunEventDataMap["request_retry"];
        process.stderr.write(
          `\nThe model did not respond; retrying (${retry.attempt}/${retry.of})…\n`,
        );
      } else if (event.type === "truncation_recovery") {
        const recovery = event.data as import("@alisio/sdk").RunEventDataMap["truncation_recovery"];
        process.stderr.write(
          `\nThe response was cut off by the output limit; retrying in smaller steps (${recovery.attempt}/${recovery.of})…\n`,
        );
      } else if (event.type === "tool_started")
        process.stderr.write(`\n→ ${(event.data as { name: string }).name}\n`);
      else if (event.type === "artifact_published") process.stderr.write(artifactLine(event));
    },
  });
  /** `artifact: Dashboard site.zip (48 KB) → /abs/path` (nothing is opened automatically). */
  function artifactLine(event: import("@alisio/sdk").RunEvent): string {
    const data = event.data as import("@alisio/sdk").RunEventDataMap["artifact_published"];
    return `artifact: ${KIND_LABELS[data.artifact.kind] ?? "File"} ${data.artifact.fileName} (${formatBytes(data.artifact.bytes)}) → ${data.path}\n`;
  }
  for (const failure of app.mcpStartupFailures()) process.stderr.write(`[startup] ${failure}\n`);
  // The ACTIVE agent (built-in `build`/`plan` or a main-capable definition) drives the main
  // session here too: its system prompt is appended and a read-only agent narrows the run. The
  // TUI adds the picker and the model switch; effort is a TUI feature (validated against the
  // active model's catalog).
  const { agentCatalogFromState, agentRunOptions, resolveActiveAgent } = await import(
    "./tui/agents.ts"
  );
  let activeRunOptions: ReturnType<typeof agentRunOptions> = {};
  try {
    const reported = app.plugins.pluginState("subagents", "mainAgents");
    activeRunOptions = agentRunOptions(
      resolveActiveAgent(agentCatalogFromState(reported), app.config.agents.active),
      { plan: app.config.plan },
    );
  } catch {
    /* agent resolution is best-effort */
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Interrupted"));
  // Same handler for every termination signal: abort the run and close through `finally`, so
  // plugins get their (bounded) `dispose()` also on `kill` and a closed terminal.
  const stopSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of stopSignals) process.on(signal, interrupt);
  // `/name args` runs a prompt template (same syntax as the TUI); refuse before creating a session.
  // A registered plugin command (`/plugin.id:name args`) runs through the command catalog instead.
  const { CommandCatalog } = await import("@alisio/core");
  const catalog = new CommandCatalog(app);
  const pluginCall = prompt ? catalog.pluginInvocation(prompt) : undefined;
  let template: ReturnType<typeof app.expandPrompt>;
  try {
    template = prompt && !pluginCall ? app.expandPrompt(prompt) : undefined;
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
    if (pluginCall) {
      const result = await catalog.execute(pluginCall.name, pluginCall.args, {
        sessionId: session,
        signal: controller.signal,
      });
      process.stdout.write(
        opts.json
          ? `${JSON.stringify({ type: "command_result", command: pluginCall.name, sessionId: session, text: result.text ?? "" })}\n`
          : `${result.text ?? ""}\n`,
      );
      return;
    }
    if (prompt) {
      const match = /^\/skill:([a-z0-9-]+)\s*([\s\S]*)$/.exec(prompt);
      if (match?.[1])
        prompt = `${await app.skills.load(match[1])}\n\nUser request: ${match[2] ?? ""}`;
      const proof = await import("./proof.ts");
      const judged = proof.proofRequested(proofFlags, app.config.proof);
      for (const criterion of proofCriteria)
        app.proof.addCriterion({ sessionId: session, ...criterion });
      if (
        judged &&
        opts.readOnly &&
        proofCriteria.some(
          (c) =>
            c.verifier?.kind === "command" ||
            (c.verifier?.kind === "coverage" && app.config.proof.coverage.enabled),
        )
      )
        process.stderr.write(
          "proof: --read-only denies processes, so command and coverage criteria stay not_checked\n",
        );
      const coverageEnabled = app.config.proof.coverage.enabled;
      if (proofCriteria.some((c) => c.verifier?.kind === "coverage") && !coverageEnabled)
        process.stderr.write(
          "proof: coverage verification is off (proof.coverage.enabled is false), so coverage criteria stay not_checked and Proof never runs their command\n",
        );
      await app.runner.run(
        session,
        proof.withProofBrief(template?.text ?? prompt, proofCriteria, { coverageEnabled }),
        controller.signal,
        {
          ...activeRunOptions,
          ...(template ? { display: template.display } : {}),
        },
      );
      if (!opts.json) process.stdout.write(`\nSession: ${session}\n`);
      if (judged) {
        const code = await proof.finishProof(
          {
            proof: app.proof,
            write: (text) => process.stdout.write(text),
            writeErr: (text) => process.stderr.write(text),
            publisher: proof.sessionPublisher(app, session),
          },
          session,
          { json: !!opts.json, codes: app.config.proof.exitCodes },
        );
        if (code) process.exitCode = code;
      }
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
    if (!opts.quiet)
      console.log("Alisio · /exit /new /btw question /skill:name /plugin.id:name args");
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
        if (line === "/btw" || line.startsWith("/btw ")) {
          // Side question: printed here only, never added to the conversation.
          try {
            const result = await catalog.execute("btw", line.slice(4), {
              sessionId: session,
              signal: controller.signal,
            });
            console.log(result.text ?? "");
          } catch (e) {
            console.error(e instanceof Error ? e.message : String(e));
          }
          process.stdout.write("\nalisio › ");
          continue;
        }
        if (line.startsWith("/command ")) {
          const [name, ...args] = line.slice(9).split(" ");
          const handler = app.plugins.commands.get(name ?? "");
          if (!handler) throw new Error("Unknown plugin command");
          console.log(await handler(args.join(" "), { sessionId: session }));
          continue;
        }
        const pluginLine = catalog.pluginInvocation(line);
        if (pluginLine) {
          try {
            const result = await catalog.execute(pluginLine.name, pluginLine.args, {
              sessionId: session,
              signal: controller.signal,
            });
            console.log(result.text ?? "");
          } catch (e) {
            console.error(e instanceof Error ? e.message : String(e));
          }
          process.stdout.write("\nalisio › ");
          continue;
        }
        const match = /^\/skill:([a-z0-9-]+)\s*([\s\S]*)$/.exec(line);
        const input = match?.[1] ? `${await app.skills.load(match[1])}\n\n${match[2] ?? ""}` : line;
        try {
          const template = app.expandPrompt(input);
          await app.runner.run(session, template?.text ?? input, controller.signal, {
            ...activeRunOptions,
            ...(template ? { display: template.display } : {}),
          });
        } catch (e) {
          console.error(String(e));
        }
        process.stdout.write("\nalisio › ");
      }
    } finally {
      rl.close();
    }
  } finally {
    for (const signal of stopSignals) process.off(signal, interrupt);
    // Background tasks end with Alisio: `run` waits for none of them, it stops them and says so.
    const live = app.tasks.liveCount();
    await app.close();
    if (live)
      process.stderr.write(
        `${live} background task${live === 1 ? " was" : "s were"} still running and ${live === 1 ? "was" : "were"} stopped: background tasks end when Alisio exits.\n`,
      );
  }
}
program
  .command("run")
  .description(
    'Run one prompt headless; "/name args" runs a prompt template (e.g. "/init") or a plugin command ("/plugin.id:name")',
  )
  .argument("<prompt>")
  .option(
    "--proof",
    "Judge the run against its acceptance criteria: print the Proof ledger (the final JSONL event with --json) and exit 0, 10 (a required criterion failed) or 11 (a required one is not verified); the codes are proof.exitCodes",
  )
  .option(
    "--criterion <text>",
    "An acceptance criterion (repeatable); pair it with --verify <command>",
    collect,
    [] as string[],
  )
  .option(
    "--verify <command>",
    "The command that verifies the n-th --criterion; Alisio records the evidence when the agent runs exactly it",
    collect,
    [] as string[],
  )
  .option(
    "--proof-file <path>",
    'JSON file with {"criteria":[{"text","verify"|"verifier","required","scope"}]} (or a plain array)',
  )
  .action((prompt, _options, cmd) => run(cmd, prompt));
program
  .command("resume")
  .argument("<session>")
  .argument("[prompt]")
  .action((id, prompt, _opts, cmd) => run(cmd, prompt, id));
program.action((_opts, cmd) => run(cmd));
program
  .command("serve")
  .description("Start the local web UI server (HTTP + SSE)")
  .option("--port <port>", "Port to listen on (0 picks a free one)", "4317")
  .option("--host <address>", "Address to bind; non-loopback requires --allow-remote", "127.0.0.1")
  .option("--allow-remote", "Allow a non-loopback --host (no TLS; prefer an SSH tunnel)")
  .option("--no-open", "Do not open the browser")
  .option("--max-workspaces <n>", "Maximum workspaces open at once", "4")
  .option("--max-runs <n>", "Maximum concurrent runs across all sessions", "4")
  .action(async (flags, cmd) => {
    const { serve } = await import("./serve.ts");
    await serve(flags, { ...(await cliDefaults()), ...options(cmd) }, VERSION);
  });
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
  const {
    DEFAULT_MAX_OUTPUT_TOKENS,
    findWorkspace,
    loadConfigWithProvenance,
    MAX_AUTO_OUTPUT_TOKENS,
    overridesSavedProviderProfile,
    ProviderSettingsStore,
    RIPGREP_INSTALL_HINT,
    which,
  } = await import("@alisio/core");
  const o = options(cmd);
  const workspace = await findWorkspace(o.cwd ?? process.cwd());
  const { config, provenance } = await loadConfigWithProvenance(workspace, {
    file: o.config,
    trustProject: o.trustProject,
    model: o.model,
    baseURL: o.baseURL,
    apiMode: o.apiMode,
  });
  const saved = await new ProviderSettingsStore().active();
  const useSaved =
    !!saved &&
    !overridesSavedProviderProfile(
      provenance,
      !!o.baseURL || !!o.apiMode || !!process.env.OPENAI_BASE_URL || !!process.env.ALISIO_API_MODE,
    );
  const model =
    o.model?.trim() ||
    process.env.ALISIO_MODEL?.trim() ||
    (useSaved ? saved.profile.model : config.provider.model);
  const status = {
    version: VERSION,
    runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`,
    platform: process.platform,
    workspace,
    git: (await which("git")) ?? null,
    ripgrep: (await which("rg")) ?? null,
    // The per-request output budget is resolved when a run starts, from the model's catalog;
    // doctor does not contact the provider, so it reports what the configuration decides.
    outputTokens:
      config.limits.maxOutputTokens !== undefined
        ? { limit: config.limits.maxOutputTokens, source: "set by you (limits.maxOutputTokens)" }
        : {
            limit: null,
            source: `the model catalog's declared limit (capped at ${MAX_AUTO_OUTPUT_TOKENS}), else ${DEFAULT_MAX_OUTPUT_TOKENS}`,
          },
    provider: {
      id: useSaved ? saved.profile.provider : "openai-compatible",
      baseURL: useSaved ? saved.profile.values.baseURL : config.provider.baseURL,
      apiMode: useSaved ? saved.profile.values.apiMode : config.provider.apiMode,
      model: !model
        ? "not configured"
        : model === "YOUR_MODEL_ID"
          ? "not configured (placeholder from `alisio setup` — edit .alisio/config.json)"
          : model,
      auth: useSaved ? saved.profile.values.auth : config.provider.auth,
      keyConfigured: useSaved
        ? !!saved.credentials.apiKey ||
          saved.profile.values.auth === "none" ||
          !!process.env[
            typeof saved.profile.values.apiKeyEnv === "string" && saved.profile.values.apiKeyEnv
              ? saved.profile.values.apiKeyEnv
              : saved.profile.provider === "deepseek"
                ? "DEEPSEEK_API_KEY"
                : "OPENAI_API_KEY"
          ]
        : config.provider.auth === "none" || !!process.env[config.provider.apiKeyEnv],
    },
  };
  const { analysisState } = await import("./analysis.ts");
  const analysisInfo = await analysisState(o);
  const { hints: _hints, ...pythonInfo } = analysisInfo.status.python as Record<string, unknown>;
  console.log(
    JSON.stringify(
      {
        ...status,
        python: { mode: analysisInfo.status.mode, ...pythonInfo },
        analysis: {
          mode: analysisInfo.status.mode,
          ...(analysisInfo.status.isolation ? { isolation: analysisInfo.status.isolation } : {}),
          ...(analysisInfo.status.backends ? { backends: analysisInfo.status.backends } : {}),
          oci: analysisInfo.status.oci,
          limits: analysisInfo.status.limits,
          retention: analysisInfo.status.retention,
          ...(analysisInfo.ignored.length ? { ignored: analysisInfo.ignored } : {}),
        },
      },
      null,
      2,
    ),
  );
  if (analysisInfo.guidance) process.stderr.write(`\n${analysisInfo.guidance}\n`);
  for (const key of provenance.ignored ?? [])
    process.stderr.write(
      `\nIgnored ${key} from the project configuration: only your user configuration decides it.\n`,
    );
  if (!status.ripgrep)
    process.stderr.write(
      `\nWarning: ripgrep (rg) is not installed; search_text and list_files will not work. ${RIPGREP_INSTALL_HINT}\n`,
    );
  if (!model || model === "YOUR_MODEL_ID")
    console.error(
      "\nNo model configured yet: set provider.model in your config, --model, or ALISIO_MODEL " +
        "before starting a real conversation (it will otherwise fail on the first turn).",
    );
});
const analysis = program
  .command("analysis")
  .description("Python analysis runtime (python_run): status, optional extras and containers");
analysis
  .command("status")
  .description("Show the runtime: Python, extras, container engine, limits and retention")
  .action(async (_opts, cmd) => {
    const { printAnalysisStatus } = await import("./analysis.ts");
    await printAnalysisStatus(options(cmd));
  });
analysis
  .command("setup")
  .description(
    "Optional: install hash-locked Python extras (--extras), pull the container image (--oci) or " +
      "download the WebAssembly runtime (--wasm). python_run never needs this for the standard library.",
  )
  .option("--extras <set>", "analysis (pandas, numpy, matplotlib…) or science (adds scipy…)")
  .option("--oci", "Pull the container image once and verify its digest (Docker or Podman)")
  .option("--image <name>", "With --oci: the image to pull (default: analysis.oci.image)")
  .option("--wasm", "Download the pinned Pyodide runtime for the wasm backend (needs network)")
  .option(
    "--profile <name>",
    "With --wasm: analysis (default) or science (adds scipy, scikit-learn…)",
  )
  .option("--yes", "With --wasm: do not ask for confirmation (required when not interactive)")
  .action(
    async (
      flags: {
        extras?: string;
        oci?: boolean;
        image?: string;
        wasm?: boolean;
        profile?: string;
        yes?: boolean;
      },
      cmd,
    ) => {
      const { setupExtras, setupOci, setupWasm } = await import("./analysis.ts");
      if (flags.wasm)
        return setupWasm(options(cmd), {
          ...(flags.profile ? { profile: flags.profile } : {}),
          yes: !!flags.yes,
        });
      if (flags.oci) return setupOci(options(cmd), flags.image);
      return setupExtras(options(cmd), flags.extras);
    },
  );
analysis
  .command("sweep")
  .description("Run the retention sweep now (it also runs by itself at most once a day)")
  .option("--force", "Ignore the once-a-day mark")
  .action(async (flags: { force?: boolean }, cmd) => {
    const { sweep } = await import("./analysis.ts");
    await sweep(options(cmd), !!flags.force);
  });
const forge = program
  .command("forge")
  .description(
    "Forja: isolated code execution (js_run). Shows the engine and why it is or is not ready",
  );
forge
  .command("status")
  .description(
    "Show the engines: JavaScript (version, WASM hash, isolation, host, limits) and the Python backends",
  )
  .option("--probe", "Also start a real isolate and run a trivial script through the protocol")
  .action(async (flags: { probe?: boolean }, cmd) => {
    const { printForgeStatus } = await import("./forge.ts");
    await printForgeStatus(options(cmd), !!flags.probe);
  });
const evalCommand = program
  .command("eval")
  .description(
    "Reliability lab: run a task suite k times, report pass rates with Wilson intervals, compare reports or config variants, record cassettes and replay them without a model",
  );
/** `alisio eval` entry points: lazy, and exit codes are returned, not thrown (0 ok, 1 error, 2 replay diverged, 3 incompatible). */
async function runEval(
  cmd: Command,
  action: (
    api: typeof import("./eval.ts"),
    env: import("./eval.ts").EvalEnv,
    flags: import("./eval.ts").EvalFlags,
  ) => Promise<number>,
): Promise<void> {
  const api = await import("./eval.ts");
  const env = await api.realEvalEnv(
    async () => options(cmd),
    async () => cliDefaults(),
  );
  process.exitCode = await action(api, env, cmd.optsWithGlobals());
}
const evalRunOptions = (command: Command) =>
  command
    .option("--tasks <ids>", "Comma-separated task ids (default: every task of the suite)")
    .option("--k <n>", "Repetitions per task (default 5; below 5 the report warns of low power)")
    .option("--seed <n>", "Seed of the run order; each run gets seed + repetition")
    .option(
      "--mode <mode>",
      "live (default) or replay (serve the recorded cassettes: no provider, no network; measures the harness, not the model)",
    )
    .option(
      "--cassette-dir <dir>",
      "Cassette directory (default: <suite>/cassettes; used by --mode replay and by record)",
    )
    .option("--keep", "Keep each run's temporary directory (it prints the paths)")
    .option("--out <dir>", "Write the report files here (default: <state>/eval/<runId>/)")
    .option("--suite-dir <dir>", "A suite, or a directory of suites; third-party code: needs --yes")
    .option("--allow-suite-full", "Let a suite run tasks that ask for the full permission mode")
    .option(
      "--yes",
      "Confirm running a --suite-dir suite without asking (required if not interactive)",
    )
    .option(
      "--input-rate <usd>",
      "USD per million input tokens, to estimate cost (needs --output-rate)",
    )
    .option("--output-rate <usd>", "USD per million output tokens (needs --input-rate)");
evalCommand
  .command("list")
  .description("List the available suites (bundled ones plus --suite-dir)")
  .option("--suite-dir <dir>", "A suite, or a directory of suites")
  .action((_flags, cmd) => runEval(cmd, (api, env, flags) => api.evalList(env, flags)));
evalRunOptions(
  evalCommand
    .command("run")
    .description(
      "Run a suite k times (live, or --mode replay from cassettes) and write report.json, report.md and runs.jsonl; --json prints the run records as JSONL and the report last. Exit 0 when it completed (whatever passed), 1 on a usage or infrastructure error, 2 when a replay diverged from its cassette",
    )
    .argument("<suite>"),
).action((suite: string, _flags, cmd) =>
  runEval(cmd, (api, env, flags) => api.evalRun(env, flags, suite)),
);
evalCommand
  .command("record")
  .description(
    "Run each task of a suite ONCE live and write <suite>/cassettes/<taskId>.cassette.jsonl for `eval run --mode replay`. Refuses (exit 1) a cassette that holds a secret or is over 256 KB (2 MB per directory)",
  )
  .argument("<suite>")
  .option("--tasks <ids>", "Comma-separated task ids (default: every task of the suite)")
  .option("--seed <n>", "Seed of the run order")
  .option("--keep", "Keep each run's temporary directory (it prints the paths)")
  .option("--cassette-dir <dir>", "Write the cassettes here (default: <suite>/cassettes)")
  .option("--suite-dir <dir>", "A suite, or a directory of suites; third-party code: needs --yes")
  .option("--allow-suite-full", "Let a suite run tasks that ask for the full permission mode")
  .option(
    "--yes",
    "Confirm running a --suite-dir suite without asking (required if not interactive)",
  )
  .action((suite: string, _flags, cmd) =>
    runEval(cmd, (api, env, flags) => api.evalRecord(env, flags, suite)),
  );
evalCommand
  .command("compare")
  .description(
    "Compare two reports of the same suite and version; exit 3 when the suites are incompatible",
  )
  .argument("<reportA>", "Baseline report.json (or the directory that holds it)")
  .argument("<reportB>", "Candidate report.json (or the directory that holds it)")
  .option("--md", "Print Markdown (the default; --json prints JSON instead)")
  .action((a: string, b: string, _flags, cmd) =>
    runEval(cmd, (api, env, flags) => api.evalCompare(env, flags, a, b)),
  );
evalRunOptions(
  evalCommand
    .command("variants")
    .description(
      'Run two or more config variants over the same tasks and seeds and compare them with the first. compare.json: {"suite":"id","variants":[{"id":"baseline","overrides":{}},{"id":"early","overrides":{"compaction.threshold":0.6}}]}',
    )
    .argument("<suite>")
    .requiredOption("--variants <file>", "The compare.json file"),
).action((suite: string, _flags, cmd) =>
  runEval(cmd, (api, env, flags) => api.evalVariants(env, flags, suite)),
);
evalCommand
  .command("export")
  .description(
    "Write ONE shareable JSON bundle ({schemaVersion, report, runs, markdown}) of a stored run (<state>/eval/<runId>/) with absolute paths replaced by placeholders and endpoint hosts removed from provider ids. Refuses (exit 1) when a secret is found, naming the field; refuses to overwrite FILE without --force. Local only: nothing is uploaded. Scrubbing is pattern-based, not a guarantee",
  )
  .argument("<runId>", "Directory name of the run under <state>/eval/")
  .requiredOption("--out <file>", "The bundle to write")
  .option("--force", "Overwrite FILE if it exists")
  .action((runId: string, _flags, cmd) =>
    runEval(cmd, (api, env, flags) => api.evalExport(env, flags, runId)),
  );
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
      const catalog = new Skills({ overrides: path ? {} : config.skillOverrides });
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
  const { discoverPlugins, installedNpmPlugins } = await import("@alisio/core");
  const { configHome } = await import("@alisio/core");
  const { join, resolve } = await import("node:path");
  const global = join(configHome(), "plugins");
  console.log(
    JSON.stringify(
      {
        global: [...(await discoverPlugins(global)), ...(await installedNpmPlugins(global))],
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
program
  .command("install")
  .description(
    "Install an npm plugin package into the global plugins directory (~/.config/alisio/plugins)",
  )
  .argument(
    "[spec]",
    'npm package spec, e.g. "npm:plugin-openrouter" or "plugin-openrouter@1.2.3"; omit it with --update to refresh ALL installed plugins',
  )
  .option("-y, --yes", "Skip the pre-install confirmation (npm may run lifecycle scripts)")
  .option("--trust-plugin", "Explicit trust for this global install (same as --yes)")
  .option(
    "--update",
    "Refresh an installed plugin to the latest version, keeping its name; without a spec, refresh ALL installed plugins in one npm call (fixes peer @alisio/sdk conflicts)",
  )
  .action(async (spec: string | undefined, _options: unknown, cmd: Command) => {
    const { cliInstall, cliUpdateAll, configHome } = await import("@alisio/core");
    const o = options(cmd) as import("@alisio/core").AppOptions & {
      json?: boolean;
      yes?: boolean;
      trustPlugin?: boolean;
      update?: boolean;
    };
    const common = {
      configHome: configHome(),
      yes: !!o.yes || !!o.trustPlugin,
      readOnly: !!o.readOnly,
      json: !!o.json,
      interactive: !!process.stdin.isTTY && !!process.stdout.isTTY && !o.json,
    };
    if (spec?.trim()) {
      await cliInstall({ spec, update: !!o.update, ...common });
      return;
    }
    if (!o.update)
      throw new Error(
        "Missing plugin spec: use `alisio install npm:<package>[@<version>]`, or `alisio install --update` to refresh every installed plugin.",
      );
    await cliUpdateAll(common);
  });
try {
  // The compiled binary starts its own Forja process isolates with this hidden command (spec D-21).
  // It is dispatched before any configuration or database is loaded and is not part of the CLI.
  if (process.argv.slice(2)[0] === "__forge-isolate") {
    const { runProcessIsolate } = await import("@alisio/core/forge-isolate");
    await runProcessIsolate();
  } else await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
