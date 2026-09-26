import { homedir } from "node:os";
import type { ModelInfo, RunEvent } from "@alisio/sdk";
import {
  CombinedAutocompleteProvider,
  type Component,
  Container,
  Editor,
  Key,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  type SelectItem,
  SelectList,
  TuiAltScreen,
  truncateToWidth,
  VStack,
} from "@earendil-works/pi-tui";
import type { AppOptions } from "../../../../src/application.ts";
import type { ApprovalDecision, ApprovalRequest } from "../../../../src/core/contracts.ts";
import { bunSpawn, copyText } from "./clipboard.ts";
import {
  AssistantBlock,
  clock,
  componentFor,
  Footer,
  Header,
  type HeaderInfo,
  ToolBlock,
} from "./components.ts";
import {
  addItem,
  COMMANDS,
  formatContext,
  formatDuration,
  formatTokens,
  hostOf,
  initialViewState,
  itemsFromHistory,
  lastAssistantText,
  parseCommand,
  reduceEvent,
  resolveCommand,
  shortenPath,
  shortId,
  summarizeToolArgs,
  type TranscriptItem,
  type ViewState,
} from "./state.ts";
import { editorTheme, selectListTheme, style } from "./theme.ts";

const VERSION = "0.1.0-alpha.1";

/** Inline selection list with type-to-filter, rendered above the editor. */
class Picker implements Component {
  private list: SelectList;
  private filter = "";
  constructor(
    private title: string,
    items: SelectItem[],
    onSelect: (item: SelectItem) => void,
    onCancel: () => void,
    private filterable = false,
  ) {
    this.list = new SelectList(items, Math.min(10, Math.max(1, items.length)), selectListTheme);
    this.list.onSelect = onSelect;
    this.list.onCancel = onCancel;
  }
  invalidate(): void {
    this.list.invalidate();
  }
  handleInput(data: string): void {
    if (this.filterable && matchesKey(data, Key.backspace)) {
      this.filter = this.filter.slice(0, -1);
      this.list.setFilter(this.filter);
    } else if (this.filterable && data.length === 1 && data >= " " && data <= "~") {
      this.filter += data;
      this.list.setFilter(this.filter);
    } else this.list.handleInput(data);
  }
  render(width: number): string[] {
    const hint = this.filterable
      ? `  ${this.filter ? `filter: ${this.filter}` : "type to filter"} · ↑↓ · Enter · Esc`
      : "  ↑↓ · Enter · Esc";
    return [
      truncateToWidth(style.bold(style.yellow(this.title)), width),
      ...this.list.render(width),
      truncateToWidth(style.dim(hint), width),
    ];
  }
}

export interface TuiOptions extends AppOptions {
  session?: string;
}

export async function runTui(options: TuiOptions): Promise<void> {
  const { createApplication } = await import("../../../../src/application.ts");
  let dispatch: (event: RunEvent) => void = () => {};
  let approve: (request: ApprovalRequest) => Promise<ApprovalDecision> = async () => "deny";
  const app = await createApplication({
    ...options,
    onEvent: (event) => dispatch(event),
    approve: (request) => approve(request),
  });
  let session =
    options.session ?? app.store.create(app.workspace, app.provider.id, app.provider.model).id;
  if (options.session && options.model && app.store.get(session).model !== options.model)
    app.runner.setModel(session, options.model);
  let view: ViewState = initialViewState(app.store.get(session).model);
  if (options.session) view = { ...view, items: itemsFromHistory(app.store.messages(session)) };

  let modelList: Promise<ModelInfo[]> | undefined;
  /** Cached GET /models; a failure clears the cache so a later call can retry. */
  const models = (): Promise<ModelInfo[]> =>
    (modelList ??= app.loadModels(AbortSignal.timeout(10_000)).catch((e) => {
      modelList = undefined;
      throw e;
    }));
  const terminal = new ProcessTerminal();
  const copy = async (text: string) =>
    copyText(text, {
      platform: process.platform,
      env: process.env,
      spawn: bunSpawn,
      writeOsc52: (sequence) => terminal.write(sequence),
    });
  const copyMessage = (result: { ok: boolean; method: string }) =>
    result.ok
      ? `Copied (${result.method})`
      : result.method === "osc52"
        ? "Sent via OSC 52 (unverified: no clipboard tool found; needs terminal support)"
        : "Copy failed: no clipboard tool available";
  const tui = new TuiAltScreen(terminal, false, undefined, {
    mouse: true,
    copyOnSelect: true,
    copySelection: async (text) => {
      const result = await copy(text);
      return result.ok ? true : copyMessage(result);
    },
  });
  const transcript = new Container();
  const rendered: Array<{ item: TranscriptItem; component: Component }> = [];
  let hint: string | undefined;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  const flashHint = (text: string, ms = 2500) => {
    hint = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      hint = undefined;
      tui.requestRender();
    }, ms);
    tui.requestRender();
  };
  const headerInfo = (): HeaderInfo => {
    const policy = app.runner.policy,
      ask = app.runner.approvals;
    return {
      version: VERSION,
      host: hostOf(app.config.provider.baseURL),
      apiMode: app.config.provider.apiMode,
      cwd: shortenPath(app.workspace, homedir()),
      session: shortId(session),
      write: policy.write ? "on" : ask ? "ask" : "off",
      process: policy.process ? "on" : ask ? "ask" : "off",
      mcp: !!options.allowMcp && !options.readOnly,
      readOnly: !!options.readOnly,
    };
  };
  const header = new Header(headerInfo, () => view);
  const footer = new Footer(
    () => view,
    () => app.contextWindow(view.model),
    () => hint,
    () => [...app.plugins.status.values()].map((s) => s.text),
  );
  app.plugins.onStatusChange = () => tui.requestRender();
  const pickerSlot = new Container();
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });
  const bottom = new Container();
  bottom.addChild(pickerSlot);
  bottom.addChild(editor);
  bottom.addChild(footer);
  tui.setLayoutRoot(
    new VStack([
      { component: header, basis: "auto" },
      {
        component: new ScrollView(transcript, {
          follow: "end",
          primary: true,
          overscroll: "chain",
        }),
        basis: 0,
        grow: 1,
        minSize: 1,
      },
      { component: bottom, basis: "auto", shrink: 1, minSize: 3 },
    ]),
  );

  const sync = () => {
    if (view.items.length < rendered.length) {
      transcript.clear();
      rendered.length = 0;
    }
    view.items.forEach((item, index) => {
      const entry = rendered[index];
      if (!entry) {
        const component = componentFor(item);
        transcript.addChild(component);
        rendered.push({ item, component });
      } else if (entry.item !== item) {
        if (entry.component instanceof AssistantBlock && item.kind === "assistant")
          entry.component.update(item);
        else if (entry.component instanceof ToolBlock && item.kind === "tool")
          entry.component.item = item;
        entry.item = item;
      }
    });
    tui.requestRender();
  };
  const reset = (next: ViewState) => {
    view = next;
    transcript.clear();
    rendered.length = 0;
    sync();
  };
  const push = (item: TranscriptItem) => {
    view = addItem(view, item);
    sync();
  };
  const notice = (text: string) => push({ kind: "notice", text });
  const error = (e: unknown) =>
    push({ kind: "error", text: e instanceof Error ? e.message : String(e) });
  const info = (text: string) => push({ kind: "info", text });
  let terminalEvent = false;
  dispatch = (event) => {
    if (event.sessionId !== session) return;
    if (["run_completed", "run_failed", "run_cancelled", "compaction_failed"].includes(event.type))
      terminalEvent = true;
    view = reduceEvent(view, event);
    sync();
  };
  const refreshEstimate = () => {
    const current = session;
    app.runner
      .estimateContext(current)
      .then((used) => {
        if (current !== session) return;
        view = { ...view, context: { used, estimated: true } };
        tui.requestRender();
      })
      .catch(() => {});
  };

  let busy = false,
    controller: AbortController | undefined,
    pending: Promise<unknown> | undefined,
    picker: Picker | undefined;
  const showPicker = (next: Picker) => {
    picker = next;
    pickerSlot.clear();
    pickerSlot.addChild(next);
    tui.setFocus(next);
    tui.requestRender();
  };
  const closePicker = () => {
    picker = undefined;
    pickerSlot.clear();
    tui.setFocus(editor);
    tui.requestRender();
  };
  approve = (request) =>
    new Promise<ApprovalDecision>((resolve) => {
      let settled = false;
      const finish = (decision: ApprovalDecision) => {
        if (settled) return;
        settled = true;
        request.signal.removeEventListener("abort", onAbort);
        closePicker();
        resolve(decision);
      };
      const onAbort = () => finish("deny");
      request.signal.addEventListener("abort", onAbort, { once: true });
      showPicker(
        new Picker(
          `Allow ${request.call.name} (${request.effect}): ${summarizeToolArgs(request.call.name, request.call.arguments)}?`,
          [
            { value: "once", label: "Allow once" },
            { value: "session", label: `Always allow ${request.effect} in this session` },
            { value: "deny", label: "Deny" },
          ],
          (item) => finish(item.value as ApprovalDecision),
          () => finish("deny"),
        ),
      );
    });

  const task = async (work: (signal: AbortSignal) => Promise<unknown>) => {
    busy = true;
    terminalEvent = false;
    controller = new AbortController();
    const signal = controller.signal;
    const promise = work(signal);
    pending = promise;
    try {
      await promise;
    } catch (e) {
      if (!terminalEvent) error(e);
    } finally {
      busy = false;
      controller = undefined;
      pending = undefined;
      view = { ...view, streaming: false, compacting: false };
      if (!view.context || view.context.estimated) refreshEstimate();
      tui.requestRender();
    }
  };
  const runPrompt = (display: string, prompt: string) => {
    push({ kind: "user", text: display });
    return task((signal) => app.runner.run(session, prompt, signal));
  };

  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  let stopping = false;
  /** Session-end plugin hooks (e.g. memory summary), bounded by the host timeout. */
  const endSession = async (reason: "clear" | "exit") => {
    if (!view.stats.runs || !app.plugins.hasSessionEndHooks) return;
    flashHint(
      "Running session-end plugin hooks (bounded by pluginHooks.sessionEndTimeoutMs)…",
      60_000,
    );
    tui.renderNow?.();
    try {
      const { failures } = await app.endSession(session, reason);
      for (const f of failures) notice(`Plugin ${f.source} ${f.hook} failed: ${f.error}`);
    } catch (e) {
      error(e);
    } finally {
      hint = undefined;
      tui.requestRender();
    }
  };
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    controller?.abort(new Error("Exiting"));
    await Promise.race([pending?.catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    await endSession("exit");
    resolveExit();
  };

  const setModel = (model: string) => {
    try {
      app.runner.setModel(session, model);
      if (view.model !== model) view = { ...view, model };
      refreshEstimate();
    } catch (e) {
      error(e);
    }
  };
  const chooseModel = async () => {
    let items: SelectItem[] = [];
    try {
      const list = await models();
      items = list.map((m) => ({
        value: m.id,
        label: m.id === view.model ? `${m.id} (current)` : m.id,
        ...(m.contextWindow ? { description: `${formatTokens(m.contextWindow)} context` } : {}),
      }));
    } catch (e) {
      notice(`Could not list models: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!items.length)
      items = [...new Set([view.model, app.config.provider.model])].filter(Boolean).map((id) => ({
        value: id,
        label: id === view.model ? `${id} (current)` : id,
      }));
    showPicker(
      new Picker(
        "Select model",
        items,
        (item) => {
          closePicker();
          if (item.value !== view.model) setModel(item.value);
        },
        closePicker,
        true,
      ),
    );
  };
  const workspaceSessions = () =>
    app.store.list().filter((s) => s.workspace === app.workspace && s.provider === app.provider.id);
  const firstPrompt = (id: string) => {
    const first = app.store.messages(id).find((m) => m.role === "user" && !m.summary);
    return first?.role === "user" ? first.text.replace(/\s+/g, " ").slice(0, 60) : "";
  };
  const resume = (target: string) => {
    const matches = workspaceSessions().filter((s) => s.id.startsWith(target));
    if (matches.length !== 1)
      return error(
        matches.length
          ? `Ambiguous session prefix: ${target}`
          : `No session in this workspace matches ${target}`,
      );
    const found = matches[0];
    if (!found) return;
    session = found.id;
    reset({
      ...initialViewState(found.model),
      items: itemsFromHistory(app.store.messages(found.id)),
    });
    notice(`Resumed session ${found.id}`);
    refreshEstimate();
  };
  const toolsReport = () => {
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
    return `**Tools**\n\n| Tool | Effect | State |\n| --- | --- | --- |\n${rows}\n\n\`ask\` prompts before running (allow once / session / deny). Use --allow-write / --allow-process to pre-allow; --read-only disables them. \`internal\` tools (built-in plugins) only write Alisio's own state.`;
  };
  const statsReport = () => {
    const s = view.stats;
    const window = app.contextWindow(view.model);
    const tools = Object.entries(s.tools)
      .map(([name, t]) => `| \`${name}\` | ${t.calls} | ${t.errors} |`)
      .join("\n");
    return [
      "**Session statistics**",
      "",
      `- Session: \`${session}\``,
      `- Model: \`${view.model}\`${s.models.length > 1 ? ` (used: ${s.models.join(", ")})` : ""}`,
      `- Tokens: in ${formatTokens(s.input)} · out ${formatTokens(s.output)} · cached ${formatTokens(s.cached)}`,
      `- Runs: ${s.runs} · turns: ${s.turns}${s.lastRunMs !== undefined ? ` · last run ${formatDuration(s.lastRunMs)}` : ""}`,
      `- Duration: ${formatDuration(Date.now() - s.startedAt)}`,
      `- Context: ${formatContext(view.context?.used ?? 0, window, view.context?.estimated ?? true)}`,
      "",
      tools ? `| Tool | Calls | Errors |\n| --- | --- | --- |\n${tools}` : "No tool calls yet.",
      "",
      ...(app.plugins.status.size
        ? [
            "**Plugins**",
            "",
            ...[...app.plugins.status.values()].map((x) => `- ${x.plugin}: ${x.detail ?? x.text}`),
            "",
          ]
        : []),
      "Token counts cover this TUI process only and depend on provider usage reports.",
    ].join("\n");
  };
  const helpReport = () =>
    [
      "**Commands**",
      "",
      ...COMMANDS.map(
        (c) =>
          `- \`/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}\` — ${c.description}${c.aliases ? ` (alias: ${c.aliases.map((a) => `/${a}`).join(", ")})` : ""}`,
      ),
      ...[...app.plugins.commandInfo.entries()]
        .filter(([name]) => !resolveCommand(name))
        .map(
          ([name, c]) =>
            `- \`/${name}${c.argumentHint ? ` ${c.argumentHint}` : ""}\` — ${c.description ?? "plugin command"} (plugin ${c.plugin})`,
        ),
      "- `/skill:name request` — load a skill and send the request",
      "- `/command plugin.id:name args` — run a plugin command",
      "",
      "**Keys**: Enter send · Shift+Enter / Alt+Enter / Ctrl+J newline · Tab complete · ↑↓ history · Esc interrupt · Ctrl+C clear input (twice to exit) · Ctrl+D exit on empty input · PgUp/PgDn or mouse wheel scroll",
    ].join("\n");

  const mutating = new Set(["model", "compact", "clear", "resume"]);
  const handleSubmit = async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    editor.addToHistory(raw);
    const parsed = parseCommand(text);
    const name = parsed ? resolveCommand(parsed.name) : undefined;
    if (busy && (!parsed || (name && mutating.has(name)) || parsed.name.startsWith("skill:"))) {
      editor.setText(raw);
      flashHint("A turn is running: press Esc to interrupt, or wait for it to finish");
      return;
    }
    try {
      if (!parsed) return await runPrompt(raw, raw);
      if (parsed.name.startsWith("skill:")) {
        const skill = await app.skills.load(parsed.name.slice(6));
        return await runPrompt(text, `${skill}\n\nUser request: ${parsed.args}`);
      }
      if (parsed.name === "command") {
        const [command, ...rest] = parsed.args.split(" ");
        const handler = app.plugins.commands.get(command ?? "");
        if (!handler) return error(`Unknown plugin command: ${command ?? ""}`);
        return info(await handler(rest.join(" ")));
      }
      switch (name) {
        case "help":
          return info(helpReport());
        case "exit":
          return void (await shutdown());
        case "stats":
          return info(statsReport());
        case "tools":
          return info(toolsReport());
        case "model":
          return parsed.args ? setModel(parsed.args) : await chooseModel();
        case "compact":
          return await task((signal) =>
            app.runner.compact(session, { focus: parsed.args || undefined, signal }),
          );
        case "copy": {
          const last = lastAssistantText(view.items);
          if (!last) return notice("No assistant response to copy yet");
          const result = await copy(last);
          const message = copyMessage(result);
          tui.flash(message);
          return result.ok ? undefined : notice(message);
        }
        case "clear": {
          await endSession("clear");
          session = app.store.create(app.workspace, app.provider.id, view.model).id;
          reset(initialViewState(view.model));
          notice(`New session ${session}`);
          void app.herdr.report("idle", session);
          return refreshEstimate();
        }
        case "sessions": {
          const list = workspaceSessions().slice(0, 20);
          if (!list.length) return notice("No sessions in this workspace");
          return info(
            [
              "**Recent sessions** (use `/resume <id-prefix>`)",
              "",
              ...list.map(
                (s) =>
                  `- \`${s.id}\` ${s.id === session ? "**(current)** " : ""}${s.model} · ${app.store.messages(s.id).length} msgs · ${firstPrompt(s.id) || "_empty_"}`,
              ),
            ].join("\n"),
          );
        }
        case "resume":
          if (parsed.args) return resume(parsed.args);
          return showPicker(
            new Picker(
              "Resume session",
              workspaceSessions()
                .slice(0, 50)
                .map((s) => ({
                  value: s.id,
                  label: `${shortId(s.id)}${s.id === session ? " (current)" : ""}`,
                  description: `${s.model} · ${firstPrompt(s.id) || "empty"}`,
                })),
              (item) => {
                closePicker();
                resume(item.value);
              },
              closePicker,
              true,
            ),
          );
        default:
          // Plugin commands are routed generically (built-ins unprefixed, others `id:name`).
          if (app.plugins.commands.has(parsed.name))
            return info(await (app.plugins.commands.get(parsed.name)?.(parsed.args) ?? ""));
          return error(`Unknown command /${parsed.name}. Type /help.`);
      }
    } catch (e) {
      error(e);
    }
  };
  editor.onSubmit = (text) => {
    void handleSubmit(text);
  };
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(
      [
        ...COMMANDS,
        ...[...app.plugins.commandInfo.entries()]
          .filter(([name]) => !resolveCommand(name))
          .map(([name, c]) => ({
            name,
            description: c.description ?? `plugin ${c.plugin}`,
            ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
          })),
      ].map((c) => ({
        name: c.name,
        description: c.description,
        ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
        ...(c.name === "model"
          ? {
              getArgumentCompletions: (prefix: string) =>
                models()
                  .then((list) =>
                    list
                      .filter((m) => m.id.startsWith(prefix))
                      .slice(0, 50)
                      .map((m) => ({ value: m.id, label: m.id })),
                  )
                  .catch(() => null),
            }
          : c.name === "resume"
            ? {
                getArgumentCompletions: (prefix: string) =>
                  workspaceSessions()
                    .filter((s) => s.id.startsWith(prefix))
                    .slice(0, 20)
                    .map((s) => ({ value: s.id, label: shortId(s.id), description: s.model })),
              }
            : {}),
      })),
      app.workspace,
    ),
  );

  let lastCtrlC = 0;
  tui.addInputListener((data) => {
    if (matchesKey(data, Key.escape)) {
      if (busy && !picker && !editor.isShowingAutocomplete()) {
        controller?.abort(new Error("Interrupted by user"));
        flashHint("Interrupting…");
        return { consume: true };
      }
      return undefined;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      if (tui.hasActiveSelection()) return undefined;
      if (picker) {
        picker.handleInput("\x1b");
        return { consume: true };
      }
      if (editor.getText()) {
        editor.setText("");
        tui.requestRender();
        return { consume: true };
      }
      if (busy) {
        controller?.abort(new Error("Interrupted by user"));
        return { consume: true };
      }
      const now = Date.now();
      if (now - lastCtrlC < 1500) void shutdown();
      else {
        lastCtrlC = now;
        flashHint("Press Ctrl+C again to exit", 1500);
      }
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("d")) && !editor.getText() && !picker) {
      void shutdown();
      return { consume: true };
    }
    return undefined;
  });

  const ticker = setInterval(() => {
    clock.now = Date.now();
    if (busy || view.items.some((i) => i.kind === "tool" && i.status === "running")) {
      clock.frame++;
      tui.requestRender();
    }
  }, 100);
  const onSignal = () => void shutdown();
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);

  try {
    await app.herdr.report("idle", session);
    tui.setFocus(editor);
    tui.start();
    sync();
    refreshEstimate();
    // Discover context windows in the background; failures only mean "unknown".
    models()
      .then(() => tui.requestRender())
      .catch(() => {});
    await exited;
  } finally {
    clearInterval(ticker);
    clearTimeout(hintTimer);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    tui.stop();
    await app.close();
    process.stdout.write(`\nSession: ${session}\n`);
  }
}
