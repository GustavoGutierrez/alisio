import { homedir } from "node:os";
import type { AppOptions, ApprovalDecision, ApprovalRequest } from "@alisio/core";
import type { ModelInfo, PanelNode, RunEvent } from "@alisio/sdk";
import {
  CombinedAutocompleteProvider,
  type Component,
  Container,
  Editor,
  getImageDimensions,
  getNativeClipboard,
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
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  type PendingAttachment,
  pasteImageFromClipboard,
  removeLastAttachment,
  toApiAttachment,
} from "./attachments.ts";
import { copyText, nodeSpawn } from "./clipboard.ts";
import {
  AttachmentsBar,
  BannerBlock,
  clock,
  componentFor,
  Footer,
  Header,
  type HeaderInfo,
  Switch,
  TranscriptSync,
  TreePanel,
} from "./components.ts";
import { initialPanelState, reducePanel, visibleRows } from "./panel.ts";
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
  reservedCommandNames,
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
  quiet?: boolean;
  /** `false` with --no-banner. */
  banner?: boolean;
}

export async function runTui(options: TuiOptions): Promise<void> {
  const { createApplication } = await import("@alisio/core");
  const { BUILTIN_PLUGINS } = await import("../builtin.ts");
  const { BUILTIN_PROMPTS } = await import("../prompts/index.ts");
  let dispatch: (event: RunEvent) => void = () => {};
  let approve: (request: ApprovalRequest) => Promise<ApprovalDecision> = async () => "deny";
  const app = await createApplication({
    builtins: BUILTIN_PLUGINS,
    builtinPrompts: BUILTIN_PROMPTS,
    reservedPromptNames: reservedCommandNames(),
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
  let pendingAttachments: PendingAttachment[] = [];

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
      spawn: nodeSpawn,
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
  const main = new TranscriptSync();
  const transcript = main.container;
  // Read-only views of child sessions (subagents), fed by their events.
  const childViews = new Map<string, ViewState>();
  const childView = new TranscriptSync();
  let panelState = initialPanelState();
  const startupDiagnostics: import("@alisio/core").StartupDiagnostic[] = [];
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
  const panelEntry = () => [...app.plugins.panels.values()][0];
  const panelNodes = (): PanelNode[] => {
    try {
      return panelEntry()?.provider.nodes({ sessionId: session }) ?? [];
    } catch {
      return [];
    }
  };
  const viewedState = () =>
    panelState.focus === "view" && panelState.viewing
      ? childViews.get(panelState.viewing)
      : undefined;
  const viewHint = () => {
    const nodes = panelNodes();
    const node = nodes.find((n) => n.id === panelState.viewing);
    if (!node) return "Esc back";
    const path: string[] = [];
    for (
      let cur: PanelNode | undefined = node;
      cur;
      cur = nodes.find((n) => n.id === cur?.parentId)
    )
      path.unshift(cur.label);
    const siblings = nodes.filter((n) => n.parentId === node.parentId);
    const child = viewedState();
    const window = app.contextWindow(child?.model ?? view.model);
    const pct =
      child?.context && window ? ` · ctx ${Math.round((child.context.used / window) * 100)}%` : "";
    const tokens = child
      ? ` · ↑${formatTokens(child.stats.input)} ↓${formatTokens(child.stats.output)}`
      : "";
    return `viewing ${path.join(" › ")} · ${siblings.indexOf(node) + 1}/${siblings.length}${pct}${tokens} · ↑ parent ↓ child ←→ siblings · Esc back · Ctrl+K cancel`;
  };
  const panelHint = () =>
    panelState.focus === "panel"
      ? "agents: ↑↓ move · → expand/enter · ← collapse/parent · Enter open · Ctrl+K cancel · Esc/Tab editor"
      : panelState.focus === "view"
        ? viewHint()
        : undefined;
  const footer = new Footer(
    () => viewedState() ?? view,
    () => app.contextWindow((viewedState() ?? view).model),
    () => panelHint() ?? hint,
    () => [...app.plugins.status.values()].map((s) => s.text),
  );
  const treePanel = new TreePanel(() => {
    const entry = panelEntry();
    if (!entry) return undefined;
    const nodes = panelNodes();
    return {
      title: entry.provider.title,
      rows: visibleRows(nodes, panelState.collapsed).map((r) => ({
        ...r,
        collapsed: panelState.collapsed.has(r.node.id),
      })),
      total: nodes,
      focused: panelState.focus !== "editor",
      ...(panelState.selected ? { selected: panelState.selected } : {}),
      ...(panelState.confirm ? { confirm: panelState.confirm } : {}),
    };
  });
  app.plugins.onStatusChange = () => tui.requestRender();
  const pickerSlot = new Container();
  const attachmentsBar = new AttachmentsBar(() => pendingAttachments);
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });
  const bottom = new Container();
  bottom.addChild(pickerSlot);
  bottom.addChild(attachmentsBar);
  bottom.addChild(editor);
  bottom.addChild(treePanel);
  bottom.addChild(footer);
  tui.setLayoutRoot(
    new VStack([
      { component: header, basis: "auto" },
      {
        component: new ScrollView(
          new Switch(() => (viewedState() ? childView.container : transcript)),
          {
            follow: "end",
            primary: true,
            overscroll: "chain",
          },
        ),
        basis: 0,
        grow: 1,
        minSize: 1,
      },
      { component: bottom, basis: "auto", shrink: 1, minSize: 3 },
    ]),
  );

  const sync = () => {
    main.sync(view.items);
    tui.requestRender();
  };
  const reset = (next: ViewState) => {
    view = next;
    main.reset();
    sync();
  };
  const openChild = (sessionId: string) => {
    if (!childViews.has(sessionId)) {
      let base = initialViewState(view.model);
      try {
        base = { ...base, items: itemsFromHistory(app.store.messages(sessionId)) };
      } catch {
        /* unknown session */
      }
      childViews.set(sessionId, base);
    }
    childView.reset();
    childView.sync(childViews.get(sessionId)?.items ?? []);
    tui.requestRender();
  };
  const applyPanel = (result: ReturnType<typeof reducePanel>) => {
    panelState = result.state;
    const effect = result.effect;
    if (effect?.type === "open") openChild(effect.sessionId);
    if (effect?.type === "cancel")
      void panelEntry()?.provider.action?.("cancel", effect.id, { sessionId: session });
    if (effect?.type === "cancel") flashHint("Cancelling agent and its descendants…");
    tui.requestRender();
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
    if (event.sessionId !== session) {
      // Child session (e.g. a subagent): keep a view model for its read-only view.
      const child = childViews.get(event.sessionId) ?? initialViewState(view.model);
      childViews.set(event.sessionId, reduceEvent(child, event));
      if (panelState.viewing === event.sessionId)
        childView.sync(childViews.get(event.sessionId)?.items ?? []);
      tui.requestRender();
      return;
    }
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
          `${request.label ? `[${request.label}] ` : ""}Allow ${request.call.name} (${request.effect}): ${summarizeToolArgs(request.call.name, request.call.arguments)}?`,
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
  const runPrompt = (display: string, prompt: string, persistDisplay?: string) => {
    // Any pending clipboard-pasted images ride along with the very next turn, then are cleared.
    const attachments = pendingAttachments.map(toApiAttachment);
    pendingAttachments = [];
    attachmentsBar.invalidate();
    push({ kind: "user", text: display });
    return task((signal) =>
      app.runner.run(session, prompt, signal, {
        ...(persistDisplay ? { display: persistDisplay } : {}),
        ...(attachments.length ? { attachments } : {}),
      }),
    );
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
      "**Extensions**",
      "",
      `- mascot: ${app.plugins.extensions.resolve("mascot")?.provider.id ?? "alisio.default"} · startup screen: ${app.plugins.extensions.resolve("startup-screen")?.provider.id ?? "alisio.default"}`,
      ...[...app.plugins.extensions.conflicts(), ...startupDiagnostics].map(
        (d) =>
          `- ${"winner" in d ? `extension_conflict ${d.point}: ${d.winner} over ${d.losers.join(", ")}` : `${d.type} ${d.source} ${d.hook}: ${d.error}`}`,
      ),
      `- prompt templates: ${app.prompts.templates.size}`,
      ...app.prompts.diagnostics.map((d) => `- ${d.type} ${JSON.stringify(d).slice(0, 160)}`),
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
      ...(app.prompts.templates.size
        ? [
            "",
            "**Prompt templates** (rendered and sent as your message)",
            "",
            ...[...app.prompts.templates.values()].map(
              (t) =>
                `- \`/${t.name}${t.argumentHint ? ` ${t.argumentHint}` : ""}\` — ${t.description} (${t.source}${t.requires.length ? `, needs ${t.requires.join("+")}` : ""})`,
            ),
            "",
          ]
        : []),
      "- `/skill:name request` — load a skill and send the request",
      "- `/init` (above) writes AGENTS.md; the shell command `alisio init` only scaffolds `.alisio/config.json`",
      "- `/command plugin.id:name args` — run a plugin command",
      "",
      "**Keys**: Enter send · Shift+Enter / Alt+Enter / Ctrl+J newline · Tab complete · ↑↓ history · Esc interrupt · Ctrl+C clear input (twice to exit) · Ctrl+D exit on empty input · PgUp/PgDn or mouse wheel scroll · Ctrl+X agent panel · Ctrl+B background running agents",
      `**Paste**: multi-line text pastes as one block automatically · Ctrl+V attach a clipboard image (PNG/JPEG/GIF/WebP, up to ${(MAX_IMAGE_BYTES / (1024 * 1024)).toFixed(0)} MB, up to ${MAX_ATTACHMENTS_PER_MESSAGE} per message) · Ctrl+R remove the last attached image`,
    ].join("\n");

  const mutating = new Set(["model", "compact", "clear", "resume"]);
  const handleSubmit = async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    editor.addToHistory(raw);
    const parsed = parseCommand(text);
    const name = parsed ? resolveCommand(parsed.name) : undefined;
    const isTemplate = !!parsed && !name && app.prompts.templates.has(parsed.name);
    if (
      busy &&
      (!parsed || (name && mutating.has(name)) || parsed.name.startsWith("skill:") || isTemplate)
    ) {
      editor.setText(raw);
      flashHint("A turn is running: press Esc to interrupt, or wait for it to finish");
      return;
    }
    try {
      if (!parsed) return await runPrompt(raw, raw);
      if (isTemplate) {
        const expanded = app.expandPrompt(text);
        if (expanded) return await runPrompt(expanded.display, expanded.text, expanded.display);
      }
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
            return info(
              await (app.plugins.commands.get(parsed.name)?.(parsed.args, { sessionId: session }) ??
                ""),
            );
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
        ...[...app.prompts.templates.values()].map((t) => ({
          name: t.name,
          description: `${t.description} (template)`,
          ...(t.argumentHint ? { argumentHint: t.argumentHint } : {}),
        })),
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

  // Interactive services for plugins: choices (e.g. worktree isolation) and session views.
  app.plugins.setInteractiveUI({
    select: (request) =>
      new Promise<string | undefined>((resolve) => {
        showPicker(
          new Picker(
            request.title,
            request.options.map((o) => ({
              value: o.value,
              label: o.label,
              ...(o.description ? { description: o.description } : {}),
            })),
            (item) => {
              closePicker();
              resolve(item.value);
            },
            () => {
              closePicker();
              resolve(undefined);
            },
          ),
        );
      }),
    open: (sessionId) => {
      const node = panelNodes().find((n) => n.sessionId === sessionId);
      panelState = {
        ...panelState,
        focus: "view",
        viewing: node?.id ?? sessionId,
        selected: node?.id ?? sessionId,
      };
      openChild(sessionId);
      return true;
    },
  });
  const panelKey = (data: string): string | undefined => {
    if (matchesKey(data, Key.up)) return "up";
    if (matchesKey(data, Key.down)) return "down";
    if (matchesKey(data, Key.left)) return "left";
    if (matchesKey(data, Key.right)) return "right";
    if (matchesKey(data, Key.enter)) return "enter";
    if (matchesKey(data, Key.escape)) return "escape";
    if (matchesKey(data, Key.tab)) return "tab";
    if (matchesKey(data, Key.ctrl("k"))) return "cancel";
    if (data === "y" || data === "Y") return "yes";
    if (data === "n" || data === "N") return "no";
    return undefined;
  };
  // Ctrl+V: attach a clipboard image (Ctrl+R removes the most recently attached one). Text
  // paste needs no wiring here: pi-tui's Editor already handles bracketed paste atomically.
  const attachmentLimits = {
    maxBytes: MAX_IMAGE_BYTES,
    maxCount: MAX_ATTACHMENTS_PER_MESSAGE,
    dimensions: getImageDimensions,
  };
  const pasteImage = async () => {
    const result = await pasteImageFromClipboard(
      getNativeClipboard(),
      pendingAttachments,
      attachmentLimits,
    );
    pendingAttachments = result.list;
    if (result.message) flashHint(result.message);
    attachmentsBar.invalidate();
    tui.requestRender();
  };
  const removeAttachment = () => {
    const { list, removed } = removeLastAttachment(pendingAttachments);
    pendingAttachments = list;
    if (removed) flashHint(`Removed attachment: ${removed.mimeType}`);
    attachmentsBar.invalidate();
    tui.requestRender();
  };
  let lastCtrlC = 0;
  tui.addInputListener((data) => {
    if (!picker && panelState.focus === "editor") {
      if (matchesKey(data, Key.ctrl("v"))) {
        void pasteImage();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("r")) && pendingAttachments.length) {
        removeAttachment();
        return { consume: true };
      }
    }
    if (!picker) {
      if (matchesKey(data, Key.ctrl("x"))) {
        const r = reducePanel(panelState, { type: "ctrlX", now: Date.now() }, panelNodes());
        if (!r.handled) flashHint("No agents to navigate yet");
        else applyPanel(r);
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("b")) && busy) {
        void panelEntry()?.provider.action?.("background", undefined, { sessionId: session });
        flashHint("Moved running foreground agents to the background");
        return { consume: true };
      }
      if (panelState.focus !== "editor" || panelState.confirm) {
        const key = panelKey(data);
        if (key || panelState.focus === "view") {
          const r = reducePanel(
            panelState,
            { type: "key", key: key ?? "other", now: Date.now() },
            panelNodes(),
          );
          applyPanel(r);
          if (r.handled || panelState.focus === "view") return { consume: true };
          return undefined;
        }
        // Typing returns focus to the editor.
        panelState = { ...panelState, focus: "editor" };
        tui.requestRender();
        return undefined;
      }
      if (matchesKey(data, Key.down) && !editor.getText() && !editor.isShowingAutocomplete()) {
        const r = reducePanel(
          panelState,
          { type: "key", key: "down", now: Date.now(), editorEmpty: true },
          panelNodes(),
        );
        if (r.handled) {
          applyPanel(r);
          return { consume: true };
        }
      }
    }
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
    if (
      busy ||
      view.items.some((i) => i.kind === "tool" && i.status === "running") ||
      panelNodes().some((n) => n.status === "running")
    ) {
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
    const { bannerPolicy, startupInput, terminalCapabilities } = await import("../banner.ts");
    if (
      bannerPolicy({
        mode: "tui",
        ...options,
        stdoutTTY: !!process.stdout.isTTY,
        stderrTTY: !!process.stderr.isTTY,
        env: process.env,
      })
    ) {
      const { renderStartup } = await import("@alisio/core");
      const banner = new BannerBlock((width) => {
        const result = renderStartup(
          app.plugins,
          startupInput(app, {
            version: VERSION,
            model: view.model,
            readOnly: !!options.readOnly,
            terminal: terminalCapabilities({ env: process.env, columns: width, tty: true }),
          }),
        );
        // Report provider problems once; later renders (resize) reuse the same resolution.
        if (!startupDiagnostics.length && result.diagnostics.length) {
          startupDiagnostics.push(...result.diagnostics);
          queueMicrotask(() => {
            for (const d of result.diagnostics)
              notice(
                d.type === "extension_conflict"
                  ? `Extension conflict on ${d.point}: ${d.winner} chosen over ${d.losers.join(", ")}`
                  : `Plugin ${d.source} ${d.hook} failed: ${d.error} (default used)`,
              );
          });
        }
        return result.lines;
      });
      // First block of the conversation; it scrolls away naturally.
      transcript.addChild(banner);
    }
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
