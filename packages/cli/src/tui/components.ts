import type { PanelNode, TreeNode, UiBlock } from "@alisio/sdk";
import {
  type Component,
  Container,
  getCapabilities,
  getImageDimensions,
  Image,
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { terminalCapabilities } from "../banner.ts";
import {
  attachmentCaption,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type PendingAttachment,
} from "./attachments.ts";
import {
  type BtwAction,
  type BtwState,
  btwCurrent,
  btwHints,
  btwPosition,
  btwUsageLine,
  btwWindow,
  reduceBtw,
} from "./btw.ts";
import { branchDisplay } from "./git-branch.ts";
import {
  initialQuestionState,
  type QuestionAction,
  type QuestionPanelState,
  type QuestionSpec,
  reduceQuestions,
} from "./questions.ts";
import {
  type ContextBudget,
  contextLevel,
  contextPercent,
  editSummary,
  entryKeyOf,
  exitCodeOf,
  type FoldableKind,
  type FoldCandidate,
  fitIdentityParts,
  fitSegments,
  foldCandidateOf,
  formatContext,
  formatDuration,
  formatTokens,
  type GroupedTool,
  groupIdentity,
  groupToolEntries,
  humanizeToolName,
  type IdentityInput,
  type IdentityRole,
  isUiBlock,
  previewLinesFor,
  previewRows,
  previewTruncated,
  REASONING_EXPAND_MAX_LINES,
  reasoningDurationMs,
  TOOL_KIND_VERB,
  TOOL_KIND_WORD,
  type ToolItemView,
  type TranscriptEntry,
  type TranscriptItem,
  type ViewState,
} from "./state.ts";
import {
  highlightCode,
  imageTheme,
  levelColor,
  markdownDefaultTextStyle,
  markdownTheme,
  markdownTransform,
  sanitizeCode,
  style,
} from "./theme.ts";

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Shared animation clock advanced by the app while work is running. */
export const clock = { frame: 0, now: Date.now() };

const fit = (lines: string[], width: number) => lines.map((l) => truncateToWidth(l, width));
const wrap = (text: string, width: number) =>
  text.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]));
/** ANSI-aware right padding to a visible width. */
const padTo = (text: string, width: number) =>
  `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
const wrapCell = (text: string, width: number) =>
  text.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]));

/** Fold state the components receive: neither knows keys nor defaults (components stay dumb). */
export interface FoldInfo {
  expanded: boolean;
  kind: FoldableKind;
}
/**
 * Rendered body of a tool call's rich parts (inline image + native ui block), reusing the exact
 * singleton rendering so grouped detail rows and plain rows agree. Returns [] when there is none.
 */
function richBodyLines(
  view: { image?: ToolItemView["image"]; ui?: ToolItemView["ui"] },
  width: number,
  markdownCache?: { text: string; renderer: Markdown } | null,
): { lines: string[]; markdownCache: { text: string; renderer: Markdown } | undefined } {
  const lines: string[] = [];
  if (view.image) {
    const inline = getCapabilities().images !== null && process.env.NO_COLOR === undefined;
    if (inline) {
      const image = new Image(view.image.data, view.image.mimeType, imageTheme, {
        maxWidthCells: Math.max(10, Math.min(60, width - 4)),
      });
      lines.push(...image.render(Math.max(1, width - 2)));
    } else {
      const dims = getImageDimensions(view.image.data, view.image.mimeType);
      lines.push(
        style.dim(
          `[image: ${view.image.mimeType}${dims ? ` ${dims.widthPx}x${dims.heightPx}` : ""}]`,
        ),
      );
    }
  }
  if (view.ui) {
    const inner = Math.max(1, width - 2);
    if (view.ui.kind === "markdown") {
      // Cache the Markdown instance so streaming/resizes never re-parse every frame.
      if (markdownCache?.text !== view.ui.text)
        markdownCache = {
          text: view.ui.text,
          renderer: new Markdown(view.ui.text, 0, 0, markdownTheme, markdownDefaultTextStyle, {
            transform: markdownTransform,
          }),
        };
      lines.push(...markdownCache.renderer.render(inner));
    } else {
      lines.push(...renderUiBlock(view.ui, width, unicodeAt(width)));
    }
  }
  return { lines, markdownCache: markdownCache ?? undefined };
}
/** Terminal Unicode support, mirroring the copy hint detection in AssistantBlock. */
const unicodeAt = (width: number): boolean =>
  terminalCapabilities({ env: process.env, columns: width, tty: true }).unicode;

/** Capped preview rows of one member call inside an expanded group (`… N more lines` footer). */
function memberPreviewLines(member: ToolItemView, indent: string): string[] {
  const rows = previewRows(member.preview ?? "");
  if (!rows.length) return [];
  const cap = previewLinesFor(member.status);
  const shown = rows.slice(0, cap);
  const paint = member.status === "error" ? style.red : style.gray;
  const lines = shown.map(
    (line, n) =>
      `${indent}  ${style.gray(n === 0 ? "⎿" : " ")} ${paint(line.replace(/\t/g, "  "))}`,
  );
  if (rows.length > shown.length)
    lines.push(style.gray(`${indent}    … ${rows.length - shown.length} more lines`));
  return lines;
}
/** `Command exited with code 0.` (green) / `Command exited with code N.` (red) when known. */
export const exitCodeLine = (code: number | undefined, indent = "  "): string | undefined =>
  code === undefined
    ? undefined
    : `${indent}${code === 0 ? style.green("Command exited with code 0.") : style.red(`Command exited with code ${code}.`)}`;

/**
 * Aligned-column table rendering: cells wrap to their column width, the header is bold, a dim
 * separator row sits under it, and the whole block respects the given inner width. Long values
 * wrap instead of being cut; the final `truncateToWidth` pass only bites on very narrow
 * terminals.
 */
function renderTableBlock(block: Extract<UiBlock, { kind: "table" }>, width: number): string[] {
  const caption = block.caption ? [style.dim(block.caption)] : [];
  if (!block.columns.length) return [...caption, style.gray("(empty table)")];
  const inner = Math.max(1, width - 2);
  const n = block.columns.length;
  const natural = block.columns.map((header, i) =>
    Math.max(1, visibleWidth(header), ...block.rows.map((row) => visibleWidth(row[i] ?? ""))),
  );
  const separatorCost = (n - 1) * 3;
  const totalNatural = natural.reduce((a, b) => a + b, 0);
  let widths: number[];
  if (totalNatural + separatorCost <= inner) {
    widths = natural;
  } else {
    const budget = Math.max(n, inner - separatorCost);
    const scale = Math.min(1, budget / totalNatural);
    widths = natural.map((w) => Math.max(1, Math.floor(w * scale)));
    let left = budget - widths.reduce((a, b) => a + b, 0);
    // Hand the leftover to the widest columns that still want space (round-robin, deterministic).
    for (let round = 0; round < n && left > 0; round++) {
      const widest = natural.findIndex((w, i) => (widths[i] ?? 0) < w);
      if (widest < 0) break;
      widths[widest] = (widths[widest] ?? 0) + 1;
      left--;
    }
  }
  const cols = block.columns.map((header, i) => ({
    header: wrapCell(header, widths[i] ?? 1),
    body: block.rows.map((row) => wrapCell(row[i] ?? "", widths[i] ?? 1)),
  }));
  const headerHeight = Math.max(...cols.map((c) => c.header.length));
  const lines: string[] = [];
  for (let li = 0; li < headerHeight; li++)
    lines.push(
      cols.map((c, i) => style.bold(padTo(c.header[li] ?? "", widths[i] ?? 1))).join(" | "),
    );
  lines.push(style.gray(cols.map((c, i) => "─".repeat(widths[i] ?? 1)).join(" │ ")));
  for (const [ri] of block.rows.entries()) {
    const wrapped = cols.map((c, i) => c.body[ri] ?? [""]);
    const height = Math.max(...wrapped.map((w) => w.length));
    for (let li = 0; li < height; li++)
      lines.push(cols.map((c, i) => padTo(wrapped[i]?.[li] ?? "", widths[i] ?? 1)).join(" | "));
  }
  return [...caption, ...lines];
}

/** Two-column key-value rendering: bright-cyan keys padded left, values wrapped on the right. */
function renderKeyValueBlock(
  block: Extract<UiBlock, { kind: "key-value" }>,
  width: number,
): string[] {
  const caption = block.caption ? [style.dim(block.caption)] : [];
  if (!block.entries.length) return [...caption, style.gray("(empty)")];
  const inner = Math.max(1, width - 2);
  const keyWidth = Math.min(24, Math.max(...block.entries.map(([k]) => visibleWidth(k)), 1));
  const valueWidth = Math.max(1, inner - keyWidth - 2);
  const lines: string[] = [];
  for (const [key, value] of block.entries) {
    wrapCell(value, valueWidth).forEach((line, i) => {
      const keyPart = i === 0 ? style.brightCyan(padTo(key, keyWidth)) : " ".repeat(keyWidth);
      lines.push(`${keyPart}  ${line}`);
    });
  }
  return [...caption, ...lines];
}

/**
 * Tree rendering with branch glyphs: `├─`/`└─`/`│` when the terminal supports Unicode, ASCII
 * `|-`/`` `- ``/`|` otherwise.
 */
export function renderTreeLines(nodes: TreeNode[], unicode: boolean): string[] {
  const branch = unicode ? "├─ " : "|- ";
  const last = unicode ? "└─ " : "`- ";
  const vertical = unicode ? "│  " : "|  ";
  const gap = "   ";
  const lines: string[] = [];
  const walk = (items: TreeNode[], prefix: string) => {
    items.forEach((node, index) => {
      const isLast = index === items.length - 1;
      const meta = node.meta ? ` ${style.dim(`(${node.meta})`)}` : "";
      lines.push(`${prefix}${isLast ? last : branch}${node.label}${meta}`);
      if (node.children?.length) walk(node.children, `${prefix}${isLast ? gap : vertical}`);
    });
  };
  walk(nodes, "");
  return lines;
}

/** Mini code block: dim fenced header, highlighted body (the same highlighter as markdown), dim close. */
function renderCodeBlock(block: Extract<UiBlock, { kind: "code" }>, _width: number): string[] {
  const caption = block.caption ? [style.dim(block.caption)] : [];
  return [
    ...caption,
    style.dim(block.lang ? `\`\`\`${block.lang}` : "```"),
    ...highlightCode(block.code, block.lang),
    style.dim("```"),
  ];
}

/** Longest JSON/unknown-block text shown inline before a `… truncated` marker. */
const MAX_BLOCK_LINES = 200;
const MAX_BLOCK_CHARS = 20_000;

/** Caps free-form text by lines and characters, appending a dim marker when anything is cut. */
function capText(text: string): { text: string; truncated: boolean } {
  let out = text.length > MAX_BLOCK_CHARS ? text.slice(0, MAX_BLOCK_CHARS) : text;
  const lines = out.split("\n");
  if (lines.length > MAX_BLOCK_LINES) out = lines.slice(0, MAX_BLOCK_LINES).join("\n");
  return { text: out, truncated: out.length < text.length };
}

/** `JSON.stringify` that never throws and never returns `undefined`. */
function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function renderCappedCode(code: string, lang: string | undefined, caption?: string): string[] {
  const capped = capText(code);
  return [
    ...renderCodeBlock(
      {
        kind: "code",
        code: capped.text,
        ...(lang ? { lang } : {}),
        ...(caption ? { caption } : {}),
      },
      0,
    ),
    ...(capped.truncated ? [style.gray("… truncated")] : []),
  ];
}

function renderDiffBlock(block: Extract<UiBlock, { kind: "diff" }>): string[] {
  const caption = [block.caption, block.path].filter(Boolean).join(" · ") || undefined;
  if (block.patch !== undefined) return renderCappedCode(block.patch, "diff", caption);
  if (block.before === undefined && block.after === undefined)
    return [...(caption ? [style.dim(caption)] : []), style.gray("(empty diff)")];
  return [
    ...(caption ? [style.dim(caption)] : []),
    ...renderCappedCode(block.before ?? "", block.lang, "before"),
    ...renderCappedCode(block.after ?? "", block.lang, "after"),
  ];
}

function renderTerminalBlock(block: Extract<UiBlock, { kind: "terminal" }>): string[] {
  const head = block.command
    ? [style.dim(`$ ${block.command}${block.cwd ? `  (${block.cwd})` : ""}`)]
    : [];
  const status = [
    block.exitCode !== undefined ? `exit ${block.exitCode}` : "",
    block.durationMs !== undefined ? formatDuration(block.durationMs) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const paint = block.exitCode !== undefined && block.exitCode !== 0 ? style.red : style.gray;
  return [
    ...head,
    ...renderCappedCode(sanitizeCode(block.output), undefined),
    ...(block.truncated ? [style.gray("… output truncated")] : []),
    ...(status ? [paint(status)] : []),
  ];
}

function renderTestResultsBlock(
  block: Extract<UiBlock, { kind: "test-results" }>,
  width: number,
  unicode: boolean,
): string[] {
  const cases = block.suites.flatMap((suite) => suite.cases.map((c) => ({ suite, c })));
  const counts = new Map<string, number>();
  for (const { c } of cases) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
  const summary = [
    block.framework,
    ["passed", "failed", "skipped", "todo"]
      .filter((status) => counts.get(status))
      .map((status) => `${counts.get(status)} ${status}`)
      .join(", ") || "no tests",
    block.durationMs !== undefined ? formatDuration(block.durationMs) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const table = renderTableBlock(
    {
      kind: "table",
      columns: ["suite", "case", "status", "time"],
      rows: cases.map(({ suite, c }) => [
        suite.name,
        c.name,
        c.status,
        c.durationMs !== undefined ? formatDuration(c.durationMs) : "",
      ]),
      caption: summary,
    },
    width,
  );
  const errors = cases
    .filter(({ c }) => c.status === "failed" && c.error)
    .map(({ suite, c }) =>
      style.red(
        `${unicode ? "✗" : "x"} ${suite.name} ${unicode ? "›" : ">"} ${c.name}${suite.file ? ` (${suite.file}${c.line !== undefined ? `:${c.line}` : ""})` : ""}: ${c.error}`,
      ),
    );
  return [...table, ...errors];
}

const PROGRESS_GLYPHS = {
  unicode: { completed: "✓", running: "●", pending: "○", failed: "✗", cancelled: "⊘" },
  ascii: { completed: "[x]", running: "[>]", pending: "[ ]", failed: "[!]", cancelled: "[-]" },
} as const;

function renderProgressBlock(
  block: Extract<UiBlock, { kind: "progress" }>,
  unicode: boolean,
): string[] {
  const glyphs = PROGRESS_GLYPHS[unicode ? "unicode" : "ascii"];
  const paint = {
    completed: style.green,
    running: style.brightCyan,
    pending: style.gray,
    failed: style.red,
    cancelled: style.gray,
  } as const;
  return [
    ...(block.title ? [style.bold(block.title)] : []),
    ...(block.steps.length ? [] : [style.gray("(no steps)")]),
    ...block.steps.map(
      (step) =>
        `${paint[step.status](glyphs[step.status])} ${step.label}${step.detail ? ` ${style.dim(step.detail)}` : ""}`,
    ),
  ];
}

/** Text fallback for a kind this build does not know (or a malformed block): never throws. */
function renderUnknownBlock(block: unknown): string[] {
  const kind =
    block && typeof block === "object" && typeof (block as { kind?: unknown }).kind === "string"
      ? (block as { kind: string }).kind
      : "unknown";
  return [style.gray(`[ui block: ${kind}]`), ...renderCappedCode(jsonText(block), "json")];
}

/**
 * Renders a `{type:"ui"}` block to styled lines for the given inner width. Blocks come from
 * persisted transcripts too, so anything that does not validate (a kind added by a newer Alisio,
 * or a malformed plugin block) falls back to labeled JSON instead of throwing.
 */
export function renderUiBlock(block: UiBlock, width: number, unicode: boolean): string[] {
  if (!isUiBlock(block)) return renderUnknownBlock(block);
  switch (block.kind) {
    case "table":
      return renderTableBlock(block, width);
    case "key-value":
      return renderKeyValueBlock(block, width);
    case "tree":
      return renderTreeLines(block.nodes, unicode);
    case "code":
      return renderCodeBlock(block, width);
    case "markdown": {
      const md = new Markdown(block.text, 0, 0, markdownTheme, markdownDefaultTextStyle, {
        transform: markdownTransform,
      });
      return md.render(Math.max(1, width - 2));
    }
    case "diff":
      return renderDiffBlock(block);
    case "terminal":
      return renderTerminalBlock(block);
    case "mermaid":
      return renderCappedCode(block.source, "mermaid", block.title);
    case "math":
      return block.latex.split("\n");
    case "json":
      return renderCappedCode(jsonText(block.value), "json", block.caption);
    case "test-results":
      return renderTestResultsBlock(block, width, unicode);
    case "progress":
      return renderProgressBlock(block, unicode);
    default:
      return renderUnknownBlock(block);
  }
}

export type PermissionState = "on" | "ask" | "off";
export interface HeaderInfo {
  version: string;
  host: string;
  apiMode: string;
  provider?: string;
  /** Model display name (catalog `name`), falling back to the session model id. */
  modelName?: string;
  /** Effective reasoning effort of the active model, when it advertises supported levels. */
  effort?: string;
  cwd: string;
  session: string;
  /** Git branch (or short SHA on a detached HEAD) of the session workspace; undefined when unavailable. */
  branch?: string;
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
        { text: "◆ Alisio Code", priority: 8, paint: (t) => style.bold(style.brightCyan(t)) },
        { text: `v${i.version}`, priority: 1, paint: style.gray },
        {
          text: i.modelName || v.model || "not connected",
          priority: 10,
          paint: v.model ? (t) => style.bold(style.cyan(t)) : style.yellow,
        },
        // `model · provider · effort` with each piece in a distinct color.
        ...(i.provider ? [{ text: i.provider, priority: 6, paint: style.magenta }] : []),
        ...(i.effort ? [{ text: i.effort, priority: 5, paint: style.yellow }] : []),
        { text: i.host, priority: 4, paint: style.gray },
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
        // Priority 3 (below session's 4): the branch is ambient context, so on narrow terminals it
        // drops first — before the session ID and permissions. At equal priority fitSegments drops
        // the FIRST lowest-priority segment, which would mis-drop the session when branch sits
        // after it, so the branch keeps a strictly lower priority instead.
        ...(i.branch
          ? [
              {
                text: branchDisplay(
                  i.branch,
                  terminalCapabilities({ env: process.env, columns: width, tty: true }).unicode,
                ),
                priority: 3,
                paint: style.cyan,
              },
            ]
          : []),
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
    private budget: () => ContextBudget | undefined,
    private hint: () => string | undefined,
    private statuses: () => string[] = () => [],
    private identity?: () => IdentityInput | undefined,
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    const v = this.view(),
      budget = this.budget(),
      total = budget?.total,
      used = v.context?.used ?? 0,
      estimated = v.context?.estimated ?? true;
    const pct = contextPercent(used, total);
    const level = contextLevel(pct ?? 0, budget?.compactionAt ?? 85);
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
        text: `ctx ${formatContext(used, total, estimated, budget?.basis)}`,
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
    // Status row below the editor: `agent: <name> · <model> · <provider> · <effort>`, each piece
    // in a distinct color (model bold/cyan, provider magenta, effort yellow); the effort part is
    // omitted when the active model advertises no supported levels. Truncation drops the lowest
    // priority parts first (effort, then provider) before truncating what remains.
    const identity = this.identity?.();
    const identityLine = identity
      ? fitIdentityParts(identity, width)
          .map((part) =>
            ({
              agent: (t: string) => style.bold(style.magenta(t)),
              model: (t: string) => style.bold(style.cyan(t)),
              provider: style.magenta,
              effort: style.yellow,
            })[part.role](part.text),
          )
          .join(style.gray(" · "))
      : undefined;
    return fit(
      identityLine ? [identityLine, line1, style.dim(hint)] : [line1, style.dim(hint)],
      width,
    );
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

/**
 * Subtle, non-interactive copy affordance under a completed response: it only tells the user the
 * raw response can be copied (`/copy`, or `c` on an empty input); it never triggers itself.
 * Falls back to ASCII when the terminal cannot render Unicode (dumb terminal / C locale).
 */
const copyHint = (width: number): string => {
  const unicode = terminalCapabilities({ env: process.env, columns: width, tty: true }).unicode;
  return `  ${style.dim(unicode ? "⎘ copy · /copy" : "[copy] · /copy")}`;
};

export class AssistantBlock implements Component {
  private markdown = new Markdown("", 0, 0, markdownTheme, markdownDefaultTextStyle, {
    transform: markdownTransform,
  });
  /** Bumped by TranscriptSync when this row's content changes; render caches on it. */
  public version = 0;
  public fold?: FoldInfo;
  private item: Extract<TranscriptItem, { kind: "assistant" }>;
  private cache?: { width: number; version: number; fold: FoldInfo | undefined; lines: string[] };
  constructor(item: Extract<TranscriptItem, { kind: "assistant" }>) {
    this.item = item;
    this.markdown.setText(item.text);
  }
  update(item: Extract<TranscriptItem, { kind: "assistant" }>, fold?: FoldInfo | undefined): void {
    if (item.text !== this.item.text) this.markdown.setText(item.text);
    this.item = item;
    this.fold = fold;
  }
  invalidate(): void {
    this.markdown.invalidate();
    this.cache = undefined;
  }
  render(width: number): string[] {
    const reasoning = this.item.reasoning.trim();
    // The live thinking view animates with streaming deltas and must never be cached.
    const live = !!reasoning && !this.item.text && !this.item.done;
    if (
      !live &&
      this.cache?.width === width &&
      this.cache.version === this.version &&
      this.cache.fold?.expanded === this.fold?.expanded
    )
      return this.cache.lines;
    const lines: string[] = [""];
    if (reasoning) {
      if (live) {
        lines.push(style.dim(style.italic("✻ thinking…")));
        lines.push(
          ...wrap(reasoning, width - 2)
            .slice(-4)
            .map((l) => style.dim(`  ${l}`)),
        );
      } else {
        // Finished: a collapsible `+ Thought · 2.9s` header; expanded shows the bounded text.
        const expanded = this.fold?.expanded ?? false;
        const duration = reasoningDurationMs(this.item);
        lines.push(
          `${style.dim(expanded ? "−" : "+")} ${style.dim(style.italic("Thought"))}${
            duration !== undefined ? ` ${style.dim(`· ${formatDuration(duration)}`)}` : ""
          }`,
        );
        if (expanded) {
          const wrapped = wrap(reasoning, Math.max(1, width - 4));
          lines.push(
            ...wrapped.slice(0, REASONING_EXPAND_MAX_LINES).map((l) => `  ${style.dim(l)}`),
          );
          if (wrapped.length > REASONING_EXPAND_MAX_LINES)
            lines.push(
              style.gray(
                `  … reasoning truncated (${wrapped.length - REASONING_EXPAND_MAX_LINES} more lines)`,
              ),
            );
        }
      }
    }
    if (this.item.text) {
      lines.push(...this.markdown.render(width));
      // The affordance appears only once the answer is complete (never while streaming).
      if (this.item.done) lines.push(copyHint(width));
    }
    const out = fit(lines, width);
    if (!live) this.cache = { width, version: this.version, fold: this.fold, lines: out };
    return out;
  }
}

export class ToolBlock implements Component {
  public item: Extract<TranscriptItem, { kind: "tool" }>;
  /** Bumped by TranscriptSync when this row's content changes; render caches on it. */
  public version = 0;
  public fold?: FoldInfo;
  private markdown?: { text: string; renderer: Markdown };
  private cache?: { width: number; version: number; fold: FoldInfo | undefined; lines: string[] };
  constructor(item: Extract<TranscriptItem, { kind: "tool" }>) {
    this.item = item;
  }
  update(item: Extract<TranscriptItem, { kind: "tool" }>, fold?: FoldInfo | undefined): void {
    this.item = item;
    this.fold = fold;
  }
  invalidate(): void {
    this.cache = undefined;
  }
  render(width: number): string[] {
    const i = this.item;
    // Running/approval rows animate and must never be cached; terminal rows only change when
    // TranscriptSync bumps `version`, so clock frames between events reuse the cached lines.
    const live = i.status === "running" || i.status === "approval";
    if (
      !live &&
      this.cache?.width === width &&
      this.cache.version === this.version &&
      this.cache.fold?.expanded === this.fold?.expanded
    )
      return this.cache.lines;
    const icon =
      i.status === "running"
        ? style.cyan(SPINNER[clock.frame % SPINNER.length] ?? "…")
        : i.status === "approval"
          ? style.yellow("?")
          : i.status === "ok"
            ? style.green("✓")
            : style.red("✗");
    const marker = this.fold ? `${style.dim(this.fold.expanded ? "−" : "+")} ` : "";
    const right =
      i.status === "approval"
        ? style.yellow("awaiting approval")
        : i.durationMs !== undefined
          ? style.gray(formatDuration(i.durationMs))
          : "";
    const head = `${marker}${icon} ${style.bold(humanizeToolName(i.name))} ${style.gray(i.summary)}`;
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
    // Native rich rendering: an inline image (when the terminal supports images and color is
    // on) and/or a structured ui block replace the plain preview, exactly as the emitted text
    // projection reads. Every rich line is indented two spaces like the preview lines.
    const rich = richBodyLines(i, width, this.markdown);
    const richLines = rich.lines;
    if (rich.markdownCache) this.markdown = rich.markdownCache;
    if (richLines.length) {
      lines.push(...richLines.map((line) => `  ${line}`));
    } else if (i.preview && (i.status === "error" || !diff)) {
      const rows = previewRows(i.preview);
      const cap = previewLinesFor(i.status);
      const expanded = this.fold?.expanded ?? false;
      const shown = expanded ? rows : rows.slice(0, cap);
      const paint = i.status === "error" ? style.red : style.gray;
      shown.forEach((l, n) => {
        lines.push(`  ${style.gray(n === 0 ? "⎿" : " ")} ${paint(l.replace(/\t/g, "  "))}`);
      });
      if (!expanded && rows.length > shown.length)
        lines.push(style.gray(`    … ${rows.length - shown.length} more lines`));
    }
    const exitLine = exitCodeLine(i.exitCode);
    if (exitLine) lines.push(exitLine);
    const out = fit(lines, width);
    if (!live) this.cache = { width, version: this.version, fold: this.fold, lines: out };
    return out;
  }
}

/**
 * One collapsible row for a GROUPED batch of finished tool calls (e.g. `✓ Read File — 3 reads`).
 * Collapsed it shows the aggregate header; expanded, each call with its status, duration,
 * summary and capped preview/rich body. All members are terminal, so lines are cached per
 * version/width/fold just like the other terminal rows.
 */
export class ToolGroupBlock implements Component {
  public group: GroupedTool;
  /** Bumped by TranscriptSync when this row's content changes; render caches on it. */
  public version = 0;
  public fold?: FoldInfo;
  private cache?: { width: number; version: number; fold: FoldInfo | undefined; lines: string[] };
  constructor(group: GroupedTool) {
    this.group = group;
  }
  update(group: GroupedTool, fold?: FoldInfo | undefined): void {
    this.group = group;
    this.fold = fold;
  }
  invalidate(): void {
    this.cache = undefined;
  }
  render(width: number): string[] {
    if (
      this.cache?.width === width &&
      this.cache.version === this.version &&
      this.cache.fold?.expanded === this.fold?.expanded
    )
      return this.cache.lines;
    const g = this.group;
    const expanded = this.fold?.expanded ?? false;
    const icon = g.status === "error" ? style.red("✗") : style.green("✓");
    const head = `${style.dim(expanded ? "−" : "+")} ${icon} ${style.bold(g.label)} — ${g.members.length} ${g.word}${g.totalMs > 0 ? ` ${style.gray(`· ${formatDuration(g.totalMs)}`)}` : ""}`;
    const lines = [head];
    if (expanded) {
      for (const member of g.members) {
        const micon = member.status === "error" ? style.red("✗") : style.green("✓");
        const name =
          member.humanName === member.name
            ? style.bold(member.humanName)
            : `${style.bold(member.humanName)} ${style.dim(`(${member.name})`)}`;
        lines.push(
          `  ${micon} ${name}${
            member.durationMs !== undefined
              ? ` ${style.gray(`· ${formatDuration(member.durationMs)}`)}`
              : ""
          }${member.summary ? ` ${style.gray(member.summary)}` : ""}`,
        );
        const rich = richBodyLines(member, width);
        if (rich.lines.length) {
          lines.push(...rich.lines.map((line) => `    ${line}`));
        } else {
          lines.push(...memberPreviewLines(member, "  "));
        }
        const exitLine = exitCodeLine(member.exitCode, "    ");
        if (exitLine) lines.push(exitLine);
      }
    }
    const out = fit(lines, width);
    this.cache = { width, version: this.version, fold: this.fold, lines: out };
    return out;
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
    this.markdown = new Markdown(text, 1, 0, markdownTheme, markdownDefaultTextStyle, {
      transform: markdownTransform,
    });
  }
  invalidate(): void {
    this.markdown.invalidate();
  }
  render(width: number): string[] {
    const inner = this.markdown.render(Math.max(1, width - 2));
    return fit(["", ...inner.map((l) => `${style.gray("│")} ${l}`)], width);
  }
}

/**
 * Minimum usable inner width (cells) the transcript keeps no matter how narrow the terminal is or
 * how large the configured inset grows. The effective inset is clamped so this floor is honored,
 * which also keeps the inner width positive.
 */
export const MIN_CONTENT_WIDTH = 20;

/**
 * Inset actually applied on each side: the configured value capped so the inner column stays at
 * least `MIN_CONTENT_WIDTH` wide. On terminals narrower than that floor the inset degrades to 0
 * rather than overflowing (the inner width then simply equals the terminal width).
 */
export function effectiveContentInset(width: number, inset: number): number {
  const requested = Math.max(0, Math.floor(inset));
  const max = Math.max(0, Math.floor((Math.floor(width) - MIN_CONTENT_WIDTH) / 2));
  return Math.min(requested, max);
}

/** Inner width handed to transcript children after the effective inset is applied. Always >= 1. */
export function contentInnerWidth(width: number, inset: number): number {
  return Math.max(1, Math.floor(width) - effectiveContentInset(width, inset) * 2);
}

/**
 * Applies the transcript's horizontal inset in ONE place: it hands children a reduced width and
 * prefixes every produced line with the inset, so all transcript chrome (text, copy hint, tool
 * sub-lines, reasoning lines, group headers) shares the same visual column. The reduced width is a
 * deterministic function of the terminal width, so per-row caches keyed by width stay effective.
 */
export class ContentInset implements Component {
  constructor(
    private readonly inner: Component,
    private readonly inset: () => number,
  ) {}
  invalidate(): void {
    this.inner.invalidate();
  }
  render(width: number): string[] {
    const inset = effectiveContentInset(width, this.inset());
    const lines = this.inner.render(contentInnerWidth(width, inset));
    if (!inset) return lines;
    const pad = " ".repeat(inset);
    return lines.map((line) => `${pad}${line}`);
  }
}

export function componentFor(entry: TranscriptEntry): Component {
  if (entry.kind === "group") return new ToolGroupBlock(entry.group);
  switch (entry.kind) {
    case "user":
      return new UserBlock(entry.text);
    case "assistant":
      return new AssistantBlock(entry);
    case "tool":
      return new ToolBlock(entry);
    case "info":
      return new InfoBlock(entry.text);
    default:
      return new LineBlock(entry.text, entry.kind);
  }
}

/** Applies a fresh entry (and its fold state) to a component; kinds never collide under a key. */
function updateComponent(component: Component, entry: TranscriptEntry, fold?: FoldInfo): void {
  if (entry.kind === "assistant" && component instanceof AssistantBlock)
    return component.update(entry, fold);
  if (entry.kind === "tool" && component instanceof ToolBlock) return component.update(entry, fold);
  if (entry.kind === "group" && component instanceof ToolGroupBlock)
    return component.update(entry.group, fold);
}
/** Whether a reused component can adopt the (new) entry kind (foldable rows also carry `version`). */
function isCompatible(component: Component, entry: TranscriptEntry): boolean {
  return (
    (entry.kind === "assistant" && component instanceof AssistantBlock) ||
    (entry.kind === "tool" && component instanceof ToolBlock) ||
    (entry.kind === "group" && component instanceof ToolGroupBlock) ||
    ((entry.kind === "user" ||
      entry.kind === "notice" ||
      entry.kind === "info" ||
      entry.kind === "error") &&
      !(component instanceof AssistantBlock) &&
      !(component instanceof ToolBlock) &&
      !(component instanceof ToolGroupBlock))
  );
}

/**
 * Keeps a container of transcript components in step with view-model items. Rows are keyed
 * (stable per fold candidate: tool ids, group ids, append-only item indices) and reused across
 * syncs; batch groups replace their members' singleton components with one row once all of them
 * finish. Content versions bump only when a row's entry actually changed, so clock frames
 * between events reuse each component's cached lines instead of re-rendering. `setFoldResolver`
 * supplies the effective expanded state; the same resolution feeds `entryAt`, so keybindings
 * and mouse clicks agree with the renderer.
 */
export class TranscriptSync {
  readonly container = new Container();
  private rows = new Map<
    string,
    { entry: TranscriptEntry; at: number; component: Component; version: number }
  >();
  private order: string[] = [];
  private foldOf: (candidate: FoldCandidate) => boolean = (candidate) => candidate.defaultExpanded;
  setFoldResolver(resolver: (candidate: FoldCandidate) => boolean): void {
    this.foldOf = resolver;
  }
  sync(items: TranscriptItem[]): void {
    const entries = groupToolEntries(items);
    const kept = new Set<string>();
    for (const { entry, at } of entries) {
      const key = entryKeyOf(entry, at);
      kept.add(key);
      const candidate = foldCandidateOf(entry, at);
      const fold = candidate
        ? { expanded: this.foldOf(candidate), kind: candidate.kind }
        : undefined;
      const row = this.rows.get(key);
      if (row && isCompatible(row.component, entry)) {
        const same =
          row.entry === entry ||
          (entry.kind === "group" &&
            row.entry.kind === "group" &&
            groupIdentity(entry.group) === groupIdentity(row.entry.group));
        if (!same) {
          row.version++;
          row.entry = entry;
          row.at = at;
        }
        updateComponent(row.component, entry, fold);
        if (
          row.component instanceof AssistantBlock ||
          row.component instanceof ToolBlock ||
          row.component instanceof ToolGroupBlock
        )
          row.component.version = row.version;
      } else {
        // Key collision across kinds (defensive; keys are per-kind in practice): drop any stale
        // component so the container never renders a duplicated row, then add the fresh one.
        if (row) this.container.removeChild(row.component);
        const component = componentFor(entry);
        updateComponent(component, entry, fold);
        this.rows.set(key, { entry, at, component, version: 0 });
        this.container.addChild(component);
      }
    }
    for (const [key, row] of this.rows)
      if (!kept.has(key)) {
        this.container.removeChild(row.component);
        this.rows.delete(key);
      }
    this.order = entries.map(({ entry, at }) => entryKeyOf(entry, at));
    // Preserve external children (startup banner) at the front, then managed rows in item order.
    const managed = new Set(
      this.order.map((k) => this.rows.get(k)?.component).filter((c): c is Component => !!c),
    );
    this.container.children = [
      ...this.container.children.filter((c) => !managed.has(c)),
      ...this.order.map((k) => (this.rows.get(k) as { component: Component }).component),
    ];
  }
  /**
   * Fold candidate at a transcript content row, when the click landed on the row's header
   * (assistant entries start with a blank spacer line, so their first two rows count). Used by
   * click-to-toggle; keyboard toggling uses `foldCandidates` instead and needs no heights.
   */
  entryAt(contentY: number, width: number): FoldCandidate | undefined {
    let acc = 0;
    for (const key of this.order) {
      const row = this.rows.get(key);
      if (!row) continue;
      const height = row.component.render(width).length;
      if (contentY >= acc && contentY < acc + height) {
        const candidate = foldCandidateOf(row.entry, row.at);
        if (!candidate) return undefined;
        const headerRows = row.entry.kind === "assistant" ? 2 : 1;
        return contentY < acc + headerRows ? candidate : undefined;
      }
      acc += height;
    }
    return undefined;
  }
  reset(): void {
    this.rows.clear();
    this.order = [];
    this.container.clear();
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
  /** Display-only status: a session (root or subagent) is blocked on an `ask_user_question` or
   * approval prompt. Never persisted; overlaid by the display layer over "running" nodes. */
  waiting: ["◆", style.magenta],
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
      waiting = count("waiting"),
      done = v.total.filter((n) => !["running", "queued", "waiting"].includes(n.status)).length;
    const expanded = v.focused || running + queued + waiting > 0;
    const head = `${expanded ? "▾" : "▸"} ${style.bold(v.title)} ${v.total.length} ${style.gray("·")} ${style.cyan(`▶ ${running} running`)}${waiting ? ` ${style.gray("·")} ${style.magenta(`◆ ${waiting} waiting`)}` : ""} ${style.gray("·")} ${style.gray(`◷ ${queued} queued`)} ${style.gray("·")} ${style.green(`✓ ${done} finished`)}${v.focused ? "" : style.dim("  (Ctrl+X to navigate)")}`;
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

/**
 * Pending image attachments shown above the editor: an inline thumbnail (Kitty/iTerm2) when the
 * terminal supports it, otherwise a compact one-line fallback. Empty when there are none.
 */
export class AttachmentsBar implements Component {
  private thumbnails = new Map<string, Image>();
  constructor(private items: () => PendingAttachment[]) {}
  invalidate(): void {
    for (const image of this.thumbnails.values()) image.invalidate();
  }
  render(width: number): string[] {
    const items = this.items();
    if (!items.length) return [];
    const capable = !!getCapabilities().images;
    const seen = new Set<string>();
    const lines: string[] = [];
    items.forEach((a, i) => {
      seen.add(a.id);
      lines.push(style.gray(truncateToWidth(attachmentCaption(a, i), width)));
      if (capable) {
        let thumbnail = this.thumbnails.get(a.id);
        if (!thumbnail) {
          thumbnail = new Image(a.data, a.mimeType, imageTheme, {
            maxWidthCells: Math.min(24, width),
            maxHeightCells: 3,
          });
          this.thumbnails.set(a.id, thumbnail);
        }
        lines.push(...thumbnail.render(width));
      }
    });
    for (const id of [...this.thumbnails.keys()]) if (!seen.has(id)) this.thumbnails.delete(id);
    lines.push(
      style.dim(
        `Ctrl+V paste image · Ctrl+R remove last (${items.length}/${MAX_ATTACHMENTS_PER_MESSAGE})`,
      ),
    );
    return fit(lines, width);
  }
}

/**
 * Interactive multiple-choice question panel (`ask_user_question` / `/ask`). Shows one question at
 * a time (stepped), for legibility in narrow terminals — a single scrollable panel holding every
 * question's options at once would overflow or force heavy truncation below ~60 columns, whereas a
 * step keeps each question fully readable and reflows independently on resize.
 *
 * Keys: ↑↓ move (wraps), →/Space toggle a multi-select option, Enter confirms the current question
 * and advances (submits on the last one), ←/Backspace goes back to change an earlier answer (only
 * offered when there is one), Esc skips the CURRENT question only (marks it undefined) and still
 * advances — it never aborts the whole batch, so an earlier or later question is unaffected.
 */
export class QuestionPanel implements Component {
  private state: QuestionPanelState;
  constructor(
    questions: QuestionSpec[],
    private onSubmit: (answers: QuestionPanelState["answers"]) => void,
    private label?: string,
  ) {
    this.state = initialQuestionState(questions);
  }
  invalidate(): void {}
  private dispatch(action: QuestionAction): void {
    const { state, effect } = reduceQuestions(this.state, action);
    this.state = state;
    if (effect) this.onSubmit(effect.answers);
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) return this.dispatch({ type: "up" });
    if (matchesKey(data, Key.down)) return this.dispatch({ type: "down" });
    if (matchesKey(data, Key.right) || matchesKey(data, Key.space))
      return this.dispatch({ type: "toggle" });
    if (matchesKey(data, Key.enter)) return this.dispatch({ type: "confirm" });
    if (matchesKey(data, Key.left) || matchesKey(data, Key.backspace))
      return this.dispatch({ type: "back" });
    if (matchesKey(data, Key.escape)) return this.dispatch({ type: "skip" });
  }
  render(width: number): string[] {
    const s = this.state;
    const spec = s.questions[s.index] as QuestionSpec;
    const lines: string[] = [];
    const breadcrumb = this.label ? style.dim(`${this.label} asks:`) : undefined;
    if (breadcrumb) lines.push(truncateToWidth(breadcrumb, width));
    lines.push(
      truncateToWidth(
        `${style.bold(style.yellow(spec.header))} ${style.dim(`Question ${s.index + 1}/${s.questions.length}`)}`,
        width,
      ),
    );
    lines.push(...wrap(spec.question, Math.max(1, width - 2)).map((l) => `  ${l}`));
    spec.options.forEach((option, i) => {
      const focused = i === s.cursor;
      const cursor = focused ? style.cyan("❯ ") : "  ";
      const box = spec.multiSelect ? (s.toggled.has(i) ? "[x] " : "[ ] ") : "";
      const label = focused ? style.bold(style.cyan(option.label)) : option.label;
      const tag = option.recommended ? ` ${style.green("(recommended)")}` : "";
      lines.push(truncateToWidth(`${cursor}${box}${label}${tag}`, width));
      if (option.description)
        lines.push(
          ...wrap(option.description, Math.max(1, width - 4)).map((l) => `    ${style.gray(l)}`),
        );
    });
    const hints = [
      "↑↓ select",
      ...(spec.multiSelect ? ["→/Space toggle"] : []),
      "Enter confirm",
      ...(s.index > 0 ? ["←/Backspace back"] : []),
      "Esc skip",
    ];
    lines.push(style.dim(`  ${hints.join(" · ")}`));
    return fit(lines, width);
  }
}

/**
 * The `/btw` side-question panel (picker slot, never the transcript): a pending question with a
 * spinner, then the answer rendered as Markdown like assistant text, scrollable, with ←/→ through
 * the session's earlier side answers. `onClose` runs on Esc (the app cancels a pending question).
 */
export class BtwPanel implements Component {
  private markdown?: { id: string; width: number; lines: string[] };
  constructor(
    private state: BtwState,
    private readonly onClose: () => void,
    private readonly height: () => number,
  ) {}
  get pending(): boolean {
    return !!this.state.pending;
  }
  dispatch(action: BtwAction): void {
    this.state = reduceBtw(this.state, action);
  }
  invalidate(): void {
    this.markdown = undefined;
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) return this.onClose();
    if (matchesKey(data, Key.left)) return this.dispatch({ type: "prev" });
    if (matchesKey(data, Key.right)) return this.dispatch({ type: "next" });
    if (matchesKey(data, Key.up)) return this.dispatch({ type: "scroll", lines: -1 });
    if (matchesKey(data, Key.down)) return this.dispatch({ type: "scroll", lines: 1 });
    if (matchesKey(data, Key.pageUp))
      return this.dispatch({ type: "scroll", lines: -this.height() });
    if (matchesKey(data, Key.pageDown))
      return this.dispatch({ type: "scroll", lines: this.height() });
  }
  private answerLines(id: string, text: string, width: number): string[] {
    if (this.markdown?.id === id && this.markdown.width === width) return this.markdown.lines;
    const lines = new Markdown(text, 0, 0, markdownTheme, markdownDefaultTextStyle, {
      transform: markdownTransform,
    }).render(Math.max(1, width));
    this.markdown = { id, width, lines };
    return lines;
  }
  render(width: number): string[] {
    const s = this.state;
    const inner = Math.max(1, width - 2);
    const bar = style.gray("│");
    const current = btwCurrent(s);
    const position = btwPosition(s);
    const lines: string[] = [
      "",
      `${style.bold(style.yellow("btw"))}${position ? ` ${style.dim(position)}` : ""}${style.dim(" · side question, not added to the conversation")}`,
    ];
    const question = s.pending?.question ?? s.error?.question ?? current?.question ?? "";
    lines.push(...wrap(question, inner).map((l) => `${bar} ${style.bold(l)}`));
    let overflow = false;
    if (s.pending) {
      const spinner = SPINNER[clock.frame % SPINNER.length] ?? "…";
      lines.push(
        `${bar} ${style.cyan(spinner)} Thinking… ${style.dim(formatDuration(clock.now - s.pending.startedAt))}`,
      );
    } else if (s.error) {
      lines.push(...wrap(s.error.message, inner).map((l) => `${bar} ${style.red(l)}`));
    } else if (current) {
      const body = this.answerLines(current.id, current.answer, inner);
      const view = btwWindow(body, s.scroll, Math.max(3, this.height()));
      if (view.scroll !== s.scroll) this.state = { ...s, scroll: view.scroll };
      overflow = view.above || view.below;
      if (view.above) lines.push(`${bar} ${style.dim("↑ more")}`);
      lines.push(...view.lines.map((l) => `${bar} ${l}`));
      if (view.below) lines.push(`${bar} ${style.dim("↓ more")}`);
      lines.push(`${bar} ${style.dim(btwUsageLine(current))}`);
    }
    lines.push(style.dim(`  ${btwHints(this.state, overflow)}`));
    return fit(lines, width);
  }
}
