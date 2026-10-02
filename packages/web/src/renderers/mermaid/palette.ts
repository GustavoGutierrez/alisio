/**
 * Alisio's diagram theme for plan diagrams (the plan viewer asks for it; Mermaid blocks in chat
 * messages keep Mermaid's own look). Two parts, both applied at render time:
 *
 * - a semantic palette: the plan agent's style guide names classes (`input`, `process`, `data`,
 *   `system`, `external`, `decision`, `risk`). Every class a flowchart uses without defining it
 *   gets a `classDef` appended here, in a light or dark variant;
 * - Mermaid `themeVariables` built from the same colors and Alisio's design tokens, so a diagram
 *   that sets no colors at all still looks like part of the interface.
 *
 * Pure functions: no DOM and no Mermaid import.
 */
export type DiagramTheme = "dark" | "light";

export const PALETTE_CLASSES = [
  "input",
  "process",
  "data",
  "system",
  "external",
  "decision",
  "risk",
] as const;
export type PaletteClass = (typeof PALETTE_CLASSES)[number];

interface Swatch {
  fill: string;
  stroke: string;
  color: string;
  dashed?: boolean;
}

export const PALETTE: Record<DiagramTheme, Record<PaletteClass, Swatch>> = {
  light: {
    input: { fill: "#e3f1fc", stroke: "#1f6fb2", color: "#0f3a5f" },
    process: { fill: "#dff3ef", stroke: "#0a7768", color: "#0b3b34" },
    data: { fill: "#fdf1d6", stroke: "#8a5f00", color: "#4a3300" },
    system: { fill: "#e6e9fb", stroke: "#4453b8", color: "#1e2660" },
    external: { fill: "#eef2f2", stroke: "#56646b", color: "#172125", dashed: true },
    decision: { fill: "#f6e4fa", stroke: "#8d36a6", color: "#4b1458" },
    risk: { fill: "#fbe3e4", stroke: "#b92f39", color: "#5d1219" },
  },
  dark: {
    input: { fill: "#14283a", stroke: "#5aa9e6", color: "#d6ecfb" },
    process: { fill: "#123530", stroke: "#4cc2b1", color: "#d5f3ee" },
    data: { fill: "#3a2f12", stroke: "#e3b55c", color: "#fbeccb" },
    system: { fill: "#1f2540", stroke: "#8b9bf0", color: "#e1e5fb" },
    external: { fill: "#222c33", stroke: "#93a0a8", color: "#e3e9ec", dashed: true },
    decision: { fill: "#34203a", stroke: "#d58ae6", color: "#f6dcfb" },
    risk: { fill: "#3a1a1d", stroke: "#f07a7f", color: "#fbd9db" },
  },
};

const classDefLine = (name: PaletteClass, swatch: Swatch): string =>
  `  classDef ${name} fill:${swatch.fill},stroke:${swatch.stroke},color:${swatch.color},stroke-width:1.5px${
    swatch.dashed ? ",stroke-dasharray:5 4" : ""
  }`;

const isFlowchart = (source: string): boolean =>
  /^\s*(?:(?:---[\s\S]*?\n---\s*\n)|(?:%%.*\n)|(?:%%\{[\s\S]*?\}%%\s*\n)|\s)*(?:flowchart|graph)\b/.test(
    source,
  );

/** The palette classes a flowchart uses (`:::name` or `class A,B name`) without defining them. */
export function undefinedPaletteClasses(source: string): PaletteClass[] {
  const used = new Set<string>();
  for (const match of source.matchAll(/:::\s*([A-Za-z_][\w-]*)/g)) if (match[1]) used.add(match[1]);
  for (const match of source.matchAll(/^\s*class\s+[^\n]*?\s+([A-Za-z_][\w-]*)\s*;?\s*$/gm))
    if (match[1]) used.add(match[1]);
  const defined = new Set<string>();
  for (const match of source.matchAll(/^\s*classDef\s+([^\s]+)/gm))
    for (const name of (match[1] ?? "").split(",")) defined.add(name.trim());
  return PALETTE_CLASSES.filter((name) => used.has(name) && !defined.has(name));
}

/**
 * The source with a `classDef` block for every palette class it uses but does not define. A
 * diagram that defines a class itself keeps its own colors; anything that is not a flowchart is
 * returned unchanged.
 */
export function applyPalette(source: string, theme: DiagramTheme): string {
  if (!isFlowchart(source)) return source;
  const missing = undefinedPaletteClasses(source);
  if (!missing.length) return source;
  const lines = missing.map((name) => classDefLine(name, PALETTE[theme][name]));
  return `${source.replace(/\s+$/, "")}\n  %% Alisio palette\n${lines.join("\n")}\n`;
}

/** Design tokens (see `styles/tokens.css`) the diagram theme matches. */
const SURFACE: Record<
  DiagramTheme,
  { bg: string; panel: string; text: string; muted: string; border: string; accent: string }
> = {
  dark: {
    bg: "#0f1417",
    panel: "#182025",
    text: "#e3e9ec",
    muted: "#93a0a8",
    border: "#35424a",
    accent: "#4cc2b1",
  },
  light: {
    bg: "#f6f8f8",
    panel: "#ffffff",
    text: "#172125",
    muted: "#56646b",
    border: "#bccbcd",
    accent: "#0a7768",
  },
};

/** Mermaid `themeVariables` (theme `base`) in Alisio's colors, for light or dark. */
export function themeVariables(theme: DiagramTheme): Record<string, string | boolean> {
  const s = SURFACE[theme];
  const p = PALETTE[theme];
  return {
    darkMode: theme === "dark",
    background: s.bg,
    fontFamily: "inherit",
    fontSize: "14px",
    textColor: s.text,
    // Flowcharts and most diagrams
    primaryColor: p.process.fill,
    primaryTextColor: p.process.color,
    primaryBorderColor: p.process.stroke,
    secondaryColor: p.system.fill,
    secondaryTextColor: p.system.color,
    secondaryBorderColor: p.system.stroke,
    tertiaryColor: s.panel,
    tertiaryTextColor: s.text,
    tertiaryBorderColor: s.border,
    lineColor: s.muted,
    mainBkg: p.process.fill,
    nodeBorder: p.process.stroke,
    nodeTextColor: p.process.color,
    clusterBkg: s.panel,
    clusterBorder: s.border,
    titleColor: s.text,
    edgeLabelBackground: s.bg,
    // Sequence diagrams
    actorBkg: p.system.fill,
    actorBorder: p.system.stroke,
    actorTextColor: p.system.color,
    actorLineColor: s.muted,
    signalColor: s.muted,
    signalTextColor: s.text,
    labelBoxBkgColor: s.panel,
    labelBoxBorderColor: s.border,
    labelTextColor: s.text,
    loopTextColor: s.text,
    noteBkgColor: p.data.fill,
    noteBorderColor: p.data.stroke,
    noteTextColor: p.data.color,
    activationBkgColor: p.process.fill,
    activationBorderColor: p.process.stroke,
    sequenceNumberColor: s.bg,
    // State diagrams and others
    labelColor: s.text,
    altBackground: s.panel,
    stateBkg: p.process.fill,
    stateLabelColor: p.process.color,
    transitionColor: s.muted,
    transitionLabelColor: s.text,
    compositeBackground: s.panel,
    compositeBorder: s.border,
    compositeTitleBackground: p.system.fill,
    // Entity-relationship and class diagrams
    attributeBackgroundColorOdd: s.panel,
    attributeBackgroundColorEven: s.bg,
    classText: s.text,
  };
}
