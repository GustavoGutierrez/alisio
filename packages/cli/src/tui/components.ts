import type { PanelNode } from "@alisio/sdk";
import {
  type Component,
  Container,
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  contextLevel,
  contextPercent,
  editSummary,
  fitSegments,
  formatContext,
  formatDuration,
  formatTokens,
  type TranscriptItem,
  type ViewState,
} from "./state.ts";
import { levelColor, markdownTheme, style } from "./theme.ts";

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Shared animation clock advanced by the app while work is running. */
export const clock = { frame: 0, now: Date.now() };

const fit = (lines: string[], width: number) => lines.map((l) => truncateToWidth(l, width));
const wrap = (text: string, width: number) =>
  text.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]));

export type PermissionState = "on" | "ask" | "off";
export interface HeaderInfo {
  version: string;
  host: string;
  apiMode: string;
  cwd: string;
  session: string;
  write: PermissionState;
  process: PermissionState;
  mcp: boolean;
  readOnly: boolean;
}
type Painted = { text: string; priority: number; paint: (text: string) => string };
const permission = (label: string, state: PermissionState, priority: number): Painted => ({
  text: `${label}:${state}`,
  priority,
  paint: state === "on" ? style.green : state === "ask" ? style.yellow : style.gray,
});
/** Joins painted segments after dropping low-priority ones that do not fit the width. */
const line = (segments: Painted[], width: number, separator = " · ") =>
  fitSegments(segments, width, separator)
    .map((s) => s.paint(s.text))
    .join(style.gray(separator));

export class Header implements Component {
  constructor(
    private info: () => HeaderInfo,
    private view: () => ViewState,
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    const i = this.info(),
      v = this.view();
    const line1 = line(
      [
        { text: "◆ alisio", priority: 8, paint: (t) => style.bold(style.brightCyan(t)) },
        { text: `v${i.version}`, priority: 1, paint: style.gray },
        { text: v.model, priority: 10, paint: style.bold },
        { text: i.host, priority: 5, paint: style.gray },
        { text: i.apiMode, priority: 2, paint: style.gray },
      ],
      width,
    );
    const perms: Painted[] = i.readOnly
      ? [{ text: "read-only", priority: 10, paint: style.red }]
      : [
          permission("write", i.write, 10),
          permission("process", i.process, 10),
          {
            text: i.mcp ? "mcp:on" : "mcp:off",
            priority: 7,
            paint: i.mcp ? style.green : style.gray,
          },
        ];
    const line2 = line(
      [
        { text: i.cwd, priority: 6, paint: style.cyan },
        { text: `session ${i.session}`, priority: 4, paint: style.gray },
        ...perms,
      ],
      width,
    );
    return fit([line1, line2, style.gray("─".repeat(Math.max(0, width)))], width);
  }
}

export class Footer implements Component {
  constructor(
    private view: () => ViewState,
    private window: () => number | undefined,
    private hint: () => string | undefined,
    private statuses: () => string[] = () => [],
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    const v = this.view(),
      total = this.window(),
      used = v.context?.used ?? 0,
      estimated = v.context?.estimated ?? true;
    const pct = contextPercent(used, total);
    const level = contextLevel(pct ?? 0);
    const cells = 10,
      filled = pct === undefined ? 0 : Math.min(cells, Math.round((pct / 100) * cells));
    const bar =
      pct === undefined
        ? style.gray("░".repeat(cells))
        : levelColor(level)("█".repeat(filled)) + style.gray("░".repeat(cells - filled));
    const state = v.compacting
      ? `${SPINNER[clock.frame % SPINNER.length]} compacting`
      : v.streaming
        ? `${SPINNER[clock.frame % SPINNER.length]} streaming ${formatDuration(clock.now - (v.runStartedAt ?? clock.now))}`
        : "● idle";
    const s = v.stats;
    type Seg = { text: string; priority: number; paint: (t: string) => string };
    const segments: Seg[] = [
      {
        text: `ctx ${formatContext(used, total, estimated)}`,
        priority: 10,
        paint: pct === undefined ? style.gray : levelColor(level),
      },
      { text: state, priority: 9, paint: v.streaming || v.compacting ? style.cyan : style.green },
      {
        text: `↑${formatTokens(s.input)} ↓${formatTokens(s.output)}${s.cached ? ` ⚡${formatTokens(s.cached)}` : ""}`,
        priority: 6,
        paint: style.gray,
      },
      { text: `turns ${s.turns}`, priority: 3, paint: style.gray },
      ...this.statuses().map((text) => ({ text, priority: 4, paint: style.magenta })),
      ...(s.lastRunMs !== undefined && !v.streaming
        ? [{ text: `last ${formatDuration(s.lastRunMs)}`, priority: 2, paint: style.gray }]
        : []),
    ];
    const barWidth = cells + 1;
    const kept = fitSegments(segments, Math.max(1, width - barWidth), " · ");
    const line1 = `${bar} ${kept.map((k) => k.paint(k.text)).join(style.gray(" · "))}`;
    const hint =
      this.hint() ??
      (v.streaming || v.compacting
        ? "Esc interrupt · Ctrl+C clear/exit"
        : "Enter send · Shift+Enter newline · /help commands · Ctrl+D exit");
    return fit([line1, style.dim(hint)], width);
  }
}

export class UserBlock implements Component {
  constructor(private text: string) {}
  invalidate(): void {}
  render(width: number): string[] {
    const body = wrap(this.text, Math.max(1, width - 2));
    return [
      "",
      ...fit(
        body.map((line, i) => {
          const content = `${i === 0 ? style.bold(style.magenta("❯ ")) : "  "}${line}`;
          const pad = Math.max(0, width - visibleWidth(content));
          return style.userBg(`${content}${" ".repeat(pad)}`);
        }),
        width,
      ),
    ];
  }
}

export class AssistantBlock implements Component {
  private markdown = new Markdown("", 0, 0, markdownTheme);
  private item: Extract<TranscriptItem, { kind: "assistant" }>;
  constructor(item: Extract<TranscriptItem, { kind: "assistant" }>) {
    this.item = item;
    this.markdown.setText(item.text);
  }
  update(item: Extract<TranscriptItem, { kind: "assistant" }>): void {
    if (item.text !== this.item.text) this.markdown.setText(item.text);
    this.item = item;
  }
  invalidate(): void {
    this.markdown.invalidate();
  }
  render(width: number): string[] {
    const lines: string[] = [""];
    const reasoning = this.item.reasoning.trim();
    if (reasoning) {
      if (this.item.done || this.item.text) {
        const words = reasoning.split(/\s+/).length;
        lines.push(style.dim(style.italic(`✻ reasoning (${words} words)`)));
      } else {
        lines.push(style.dim(style.italic("✻ thinking…")));
        lines.push(
          ...wrap(reasoning, width - 2)
            .slice(-4)
            .map((l) => style.dim(`  ${l}`)),
        );
      }
    }
    if (this.item.text) lines.push(...this.markdown.render(width));
    return fit(lines, width);
  }
}

export class ToolBlock implements Component {
  constructor(public item: Extract<TranscriptItem, { kind: "tool" }>) {}
  invalidate(): void {}
  render(width: number): string[] {
    const i = this.item;
    const icon =
      i.status === "running"
        ? style.cyan(SPINNER[clock.frame % SPINNER.length] ?? "…")
        : i.status === "approval"
          ? style.yellow("?")
          : i.status === "ok"
            ? style.green("✓")
            : style.red("✗");
    const right =
      i.status === "approval"
        ? style.yellow("awaiting approval")
        : i.durationMs !== undefined
          ? style.gray(formatDuration(i.durationMs))
          : "";
    const head = `${icon} ${style.bold(i.name)} ${style.gray(i.summary)}`;
    const gap = width - visibleWidth(head) - visibleWidth(right) - 1;
    const lines = [
      gap > 0 ? `${head}${" ".repeat(gap + 1)}${right}` : truncateToWidth(head, width),
    ];
    const diff = editSummary(i.name, i.args);
    if (diff) {
      lines.push(
        `  ${style.gray("⎿")} ${style.green(`+${diff.added}`)} ${style.red(`-${diff.removed}`)} ${style.gray(diff.path)}`,
      );
      const max = 12;
      for (const l of diff.lines.slice(0, max))
        lines.push(`    ${l.sign === "+" ? style.green(`+ ${l.text}`) : style.red(`- ${l.text}`)}`);
      if (diff.lines.length > max)
        lines.push(style.gray(`    … ${diff.lines.length - max} more lines`));
    }
    if (i.preview && (i.status === "error" || !diff)) {
      const preview = i.preview.split("\n").filter((l) => l.trim());
      const shown = preview.slice(0, i.status === "error" ? 6 : 3);
      const paint = i.status === "error" ? style.red : style.gray;
      shown.forEach((l, n) => {
        lines.push(`  ${style.gray(n === 0 ? "⎿" : " ")} ${paint(l.replace(/\t/g, "  "))}`);
      });
      if (preview.length > shown.length)
        lines.push(style.gray(`    … ${preview.length - shown.length} more lines`));
    }
    return fit(lines, width);
  }
}

export class LineBlock implements Component {
  constructor(
    private text: string,
    private kind: "notice" | "error",
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    const prefix = this.kind === "error" ? style.red("✗ ") : style.gray("• ");
    const paint = this.kind === "error" ? style.red : (t: string) => style.dim(style.italic(t));
    return fit(
      wrap(this.text, Math.max(1, width - 2)).map(
        (l, i) => `${i === 0 ? prefix : "  "}${paint(l)}`,
      ),
      width,
    );
  }
}

export class InfoBlock implements Component {
  private markdown: Markdown;
  constructor(text: string) {
    this.markdown = new Markdown(text, 1, 0, markdownTheme);
  }
  invalidate(): void {
    this.markdown.invalidate();
  }
  render(width: number): string[] {
    const inner = this.markdown.render(Math.max(1, width - 2));
    return fit(["", ...inner.map((l) => `${style.gray("│")} ${l}`)], width);
  }
}

export function componentFor(item: TranscriptItem): Component {
  switch (item.kind) {
    case "user":
      return new UserBlock(item.text);
    case "assistant":
      return new AssistantBlock(item);
    case "tool":
      return new ToolBlock(item);
    case "info":
      return new InfoBlock(item.text);
    default:
      return new LineBlock(item.text, item.kind);
  }
}

/** Startup screen rendered by core for the current width (cached until the width changes). */
export class BannerBlock implements Component {
  private cache?: { width: number; lines: string[] };
  constructor(private renderLines: (width: number) => string[]) {}
  invalidate(): void {
    this.cache = undefined;
  }
  render(width: number): string[] {
    if (this.cache?.width !== width)
      this.cache = { width, lines: [...this.renderLines(width), ""] };
    return fit(this.cache.lines, width);
  }
}

/** Keeps a container of transcript components in step with view-model items. */
export class TranscriptSync {
  readonly container = new Container();
  private rendered: Array<{ item: TranscriptItem; component: Component }> = [];
  sync(items: TranscriptItem[]): void {
    if (items.length < this.rendered.length) this.reset();
    items.forEach((item, index) => {
      const entry = this.rendered[index];
      if (!entry) {
        const component = componentFor(item);
        this.container.addChild(component);
        this.rendered.push({ item, component });
      } else if (entry.item !== item) {
        if (entry.component instanceof AssistantBlock && item.kind === "assistant")
          entry.component.update(item);
        else if (entry.component instanceof ToolBlock && item.kind === "tool")
          entry.component.item = item;
        entry.item = item;
      }
    });
  }
  reset(): void {
    this.container.clear();
    this.rendered = [];
  }
}
/** Renders one of several components (main conversation or a read-only child view). */
export class Switch implements Component {
  constructor(private pick: () => Component) {}
  invalidate(): void {
    this.pick().invalidate();
  }
  render(width: number): string[] {
    return this.pick().render(width);
  }
}

const NAMED: Record<string, (t: string) => string> = {
  red: style.red,
  green: style.green,
  yellow: style.yellow,
  blue: style.blue,
  magenta: style.magenta,
  cyan: style.cyan,
  gray: style.gray,
};
const STATUS_ICON: Record<string, [string, (t: string) => string]> = {
  queued: ["◷", style.gray],
  completed: ["✓", style.green],
  failed: ["✗", style.red],
  cancelled: ["⊘", style.yellow],
  interrupted: ["⚠", style.yellow],
};
export interface TreePanelView {
  title: string;
  rows: Array<{ node: PanelNode; depth: number; hasChildren: boolean; collapsed: boolean }>;
  total: PanelNode[];
  focused: boolean;
  selected?: string;
  confirm?: { id: string; count: number };
}
/** Collapsible tree panel under the editor (generic; fed by plugin panel providers). */
export class TreePanel implements Component {
  constructor(private view: () => TreePanelView | undefined) {}
  invalidate(): void {}
  render(width: number): string[] {
    const v = this.view();
    if (!v || !v.total.length) return [];
    const count = (s: string) => v.total.filter((n) => n.status === s).length;
    const running = count("running"),
      queued = count("queued"),
      done = v.total.filter((n) => !["running", "queued"].includes(n.status)).length;
    const expanded = v.focused || running + queued > 0;
    const head = `${expanded ? "▾" : "▸"} ${style.bold(v.title)} ${v.total.length} ${style.gray("·")} ${style.cyan(`▶ ${running} running`)} ${style.gray("·")} ${style.gray(`◷ ${queued} queued`)} ${style.gray("·")} ${style.green(`✓ ${done} finished`)}${v.focused ? "" : style.dim("  (Ctrl+X to navigate)")}`;
    const lines = [head];
    if (expanded) {
      const selectedIndex = Math.max(
        0,
        v.rows.findIndex((r) => r.node.id === v.selected),
      );
      const max = 8;
      const start = Math.max(0, Math.min(selectedIndex - Math.floor(max / 2), v.rows.length - max));
      for (const row of v.rows.slice(start, start + max)) {
        const n = row.node;
        const [icon, paint] =
          n.status === "running"
            ? [SPINNER[clock.frame % SPINNER.length] ?? "…", style.cyan]
            : (STATUS_ICON[n.status] ?? ["•", style.gray]);
        const elapsed = n.startedAt ? formatDuration((n.endedAt ?? clock.now) - n.startedAt) : "";
        const name = (NAMED[n.color ?? ""] ?? style.bold)(n.label);
        const branch = row.hasChildren ? (row.collapsed ? "▸ " : "▾ ") : "  ";
        let line = `${"  ".repeat(row.depth + 1)}${branch}${paint(icon)} ${name} ${style.gray([elapsed, n.tokens ? `${formatTokens(n.tokens)} tok` : ""].filter(Boolean).join(" · "))} ${style.dim(n.detail ?? "")}`;
        line = truncateToWidth(line, width);
        if (v.focused && n.id === v.selected) line = `\x1b[7m${line}\x1b[27m`;
        lines.push(line);
      }
      if (v.rows.length > max)
        lines.push(style.gray(`    … ${v.rows.length - max} more (↑↓ to scroll)`));
      if (v.confirm)
        lines.push(style.yellow(`  Cancel this agent and ${v.confirm.count} descendant(s)? y/n`));
    }
    return fit(lines, width);
  }
}
