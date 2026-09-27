/**
 * Default startup screen built from small, reusable section functions. Every section returns
 * plain lines (SGR only when color is allowed); layout never exceeds `terminal.columns`.
 */
import type { StartupContext, StartupScreenProvider, TerminalCapabilities } from "@alisio/sdk";
import { padEnd, sgr, truncate, visibleWidth } from "./text.ts";

const TIPS = [
  "Type /help to see every command and key.",
  "Switch models for the next turn with /model.",
  "Running out of context? /compact [focus] summarizes older turns.",
  "Hold Shift while dragging to use your terminal's native selection.",
  "/stats shows tokens, tools, plugins and context usage.",
  "Press Esc to interrupt a running turn.",
  "/memory searches what Alisio remembers about this project.",
];
/** Deterministic tip rotation: the same seed always yields the same tips. */
export function startupTips(seed: number, count = 2): string[] {
  const start = Math.abs(Math.trunc(seed)) % TIPS.length;
  return Array.from(
    { length: Math.min(count, TIPS.length) },
    (_, i) => TIPS[(start + i) % TIPS.length] as string,
  );
}

const glyph = (t: TerminalCapabilities, unicode: string, ascii: string) =>
  t.unicode ? unicode : ascii;
export function shortenPath(path: string, max: number, home?: string): string {
  let display =
    home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
  if (visibleWidth(display) <= max) return display;
  const parts = display.split("/").filter(Boolean);
  display = parts.at(-1) ?? display;
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = `${parts[i]}/${display}`;
    if (visibleWidth(`.../${next}`) > max) break;
    display = next;
  }
  return truncate(`.../${display}`, max, "");
}

export function titleSection(ctx: StartupContext): string[] {
  const t = ctx.terminal;
  const bold = sgr(t.color, "1;96");
  const dim = sgr(t.color, "2");
  return [`${bold("Alisio")} ${dim(`v${ctx.version}`)}`];
}
export function welcomeSection(ctx: StartupContext): string[] {
  const name = ctx.userName ? `, ${ctx.userName}` : "";
  return [`Welcome${name}! Trade winds for your code.`];
}
/** Label/value rows: model, provider host (never keys), working directory, host facts. */
export function infoSection(ctx: StartupContext, width: number): string[] {
  const t = ctx.terminal;
  const label = sgr(t.color, "2");
  const pad = " ".repeat(2);
  const rows: Array<[string, string]> = [];
  if (ctx.model) rows.push(["model", ctx.model]);
  if (ctx.provider) rows.push(["provider", ctx.provider]);
  rows.push(["cwd", ctx.cwd]);
  for (const f of ctx.facts ?? []) rows.push([f.label, f.value]);
  const plugins = ctx.plugins.length;
  rows.push(["plugins", plugins ? `${plugins} loaded` : "none"]);
  const labelWidth = Math.min(12, Math.max(...rows.map(([l]) => l.length)) + 1);
  return rows.map(([l, v]) => {
    const room = Math.max(1, width - labelWidth - 1 - 4);
    const value = l === "cwd" ? shortenPath(v, room) : truncate(v, room);
    return `${pad}${label(padEnd(l, labelWidth))} ${value}${pad}`;
  });
}
export function pluginsSection(ctx: StartupContext): string[] {
  if (!ctx.plugins.length) return [];
  const t = ctx.terminal;
  const modelProviders = ctx.plugins.filter((p) => p.categories?.includes("model-provider"));
  const names = [
    ...(modelProviders.length
      ? [`${modelProviders.length} model provider${modelProviders.length === 1 ? "" : "s"}`]
      : []),
    ...ctx.plugins
      .filter((p) => !p.categories?.includes("model-provider"))
      .map((p) => `${p.id}${p.builtin ? " (builtin)" : ""}`),
  ];
  return [`  ${sgr(t.color, "2")("with")} ${names.join(", ")}  `];
}
export function tipsSection(ctx: StartupContext): string[] {
  const t = ctx.terminal;
  const bullet = sgr(t.color, "33")(glyph(t, "›", ">"));
  return ctx.tips.map((tip) => `  ${bullet} Tip: ${tip}  `);
}
export function mascotSection(ctx: StartupContext): string[] {
  return [ctx.mascot.render({ terminal: ctx.terminal, version: ctx.version })].flat();
}
/** Mascot on the left and info on the right, or stacked when there is no room. */
export function composeSideBySide(
  left: string[],
  right: string[],
  columns: number,
  gap = 3,
): string[] {
  const leftWidth = Math.max(0, ...left.map(visibleWidth));
  const rows = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const l = padEnd(left[i] ?? "", leftWidth);
    const r = truncate(right[i] ?? "", Math.max(0, columns - leftWidth - gap));
    out.push(`${l}${" ".repeat(gap)}${r}`.trimEnd());
  }
  return out;
}

const SIDE_BY_SIDE_MIN_INFO = 34;
export const DefaultStartupScreen: StartupScreenProvider = {
  id: "alisio.default",
  render(ctx: StartupContext): string[] {
    const columns = Math.max(1, ctx.terminal.columns);
    const mascot = mascotSection(ctx);
    const mascotWidth = Math.max(0, ...mascot.map(visibleWidth));
    const side = mascot.length > 1 && columns - mascotWidth - 3 >= SIDE_BY_SIDE_MIN_INFO;
    const infoWidth = side ? columns - mascotWidth - 3 : columns;
    const info = [
      ...titleSection(ctx),
      ...welcomeSection(ctx),
      ...infoSection(ctx, infoWidth),
      ...pluginsSection(ctx),
    ];
    const body = side ? composeSideBySide(mascot, info, columns) : [...mascot, ...info];
    const rule = sgr(ctx.terminal.color, "2")(glyph(ctx.terminal, "─", "-").repeat(columns - 2));
    return [...body, "", ...tipsSection(ctx), rule].map((line) => truncate(line, columns));
  },
};
