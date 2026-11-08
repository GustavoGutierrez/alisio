/**
 * Theme catalog (spec 026 D5, §5.4): a theme is `manifest.json` (tokens) plus `theme.css`; the
 * shared structure lives in `base/print-base.css`. Tokens become CSS custom properties; the
 * `@page` rules (size, margins, margin boxes) are generated per render because they depend on
 * the page setup and the document title.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type Brand, contrast, MIN_CONTRAST, mix } from "./brand.ts";
import { DocumentError } from "./limits.ts";
import type { PageSetup, PageSize } from "./ports.ts";

export const ASSETS_ROOT = fileURLToPath(new URL("../../assets/documents/", import.meta.url));

const tone = z.strictObject({ bg: z.string(), bar: z.string() });
const slot = z.enum(["none", "title", "org", "date", "page", "pageOfTotal"]);

const manifestSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  name: z.string(),
  purpose: z.string(),
  version: z.number(),
  pageSizes: z.array(z.enum(["A4", "Letter", "Legal", "A5"])).min(1),
  fonts: z.array(z.string()).min(1),
  /** Numbers headings automatically (unless the document numbers them itself). */
  numberedHeadings: z.boolean().optional(),
  /** With a brand accent, the cover background is a dark shade of it. */
  coverFromAccent: z.boolean().optional(),
  tokens: z.strictObject({
    colors: z.strictObject({
      ink: z.string(),
      heading: z.string(),
      muted: z.string(),
      accent: z.string(),
      rule: z.string(),
      paper: z.string(),
      surface: z.string(),
      codeBg: z.string(),
      coverBg: z.string(),
      coverInk: z.string(),
      coverMuted: z.string(),
      tones: z.strictObject({ info: tone, success: tone, warning: tone, danger: tone }),
    }),
    type: z.strictObject({
      body: z.string(),
      display: z.string(),
      mono: z.string(),
      bodySize: z.string(),
      lineHeight: z.string(),
      h1: z.string(),
      h2: z.string(),
      h3: z.string(),
      cover: z.string(),
      small: z.string(),
      caption: z.string(),
      table: z.string(),
      code: z.string(),
    }),
    grid: z.strictObject({
      margin: z.strictObject({
        top: z.string(),
        right: z.string(),
        bottom: z.string(),
        left: z.string(),
      }),
      baseline: z.string(),
      columns: z.number().int().min(1).max(2),
      gutter: z.string(),
    }),
    chrome: z.strictObject({
      header: z.strictObject({ left: slot, right: slot }),
      footer: z.strictObject({ left: slot, center: slot, right: slot }),
    }),
  }),
});

export type ThemeManifest = z.infer<typeof manifestSchema>;

export interface Theme {
  manifest: ThemeManifest;
  css: string;
}

/** Where the assets are read from: the package folder, or the extracted embedded copy (binary). */
let activeRoot = ASSETS_ROOT;
export const assetsRoot = () => activeRoot;

const readText = (rel: string) => readFile(`${activeRoot}${rel}`, "utf8");

export async function themeIds(): Promise<string[]> {
  try {
    const entries = await readdir(`${activeRoot}themes`, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * True when themes and fonts can be read. The standalone binary carries no loose files: its
 * embedded copy (D-28) is extracted once under the state folder and read from there.
 */
export async function assetsAvailable(): Promise<boolean> {
  if ((await themeIds()).length > 0) return true;
  const { EMBEDDED_ASSETS } = await import("./embedded-assets.ts");
  if (!EMBEDDED_ASSETS) return false;
  const { materializeAssets } = await import("./embedded.ts");
  const { stateHome } = await import("../config.ts");
  activeRoot = await materializeAssets(
    EMBEDDED_ASSETS,
    join(stateHome(), "documents", "assets", EMBEDDED_ASSETS.version),
  );
  return (await themeIds()).length > 0;
}

export async function loadManifest(id: string): Promise<ThemeManifest> {
  let raw: string;
  try {
    raw = await readText(`themes/${id}/manifest.json`);
  } catch {
    throw new DocumentError(
      "DOCUMENT_INPUT_INVALID",
      `Unknown theme "${id}". Available: ${(await themeIds()).join(", ") || "none (assets not found)"}`,
    );
  }
  return manifestSchema.parse(JSON.parse(raw));
}

export async function loadCatalog(): Promise<ThemeManifest[]> {
  return Promise.all((await themeIds()).map(loadManifest));
}

export async function loadTheme(id: string): Promise<Theme> {
  const manifest = await loadManifest(id);
  return { manifest, css: await readText(`themes/${id}/theme.css`) };
}

export const loadBaseCss = () => readText("base/print-base.css");
export const loadFontsCss = () => readText("base/fonts.css");

/** Paper size in mm (portrait). */
const PAPER: Record<PageSize, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  Letter: { w: 215.9, h: 279.4 },
  Legal: { w: 215.9, h: 355.6 },
  A5: { w: 148, h: 210 },
};
const MARGIN_SCALE: Record<PageSize, number> = { A4: 1, Letter: 1, Legal: 1, A5: 0.78 };

export function pageDimensions(page: PageSetup): { w: number; h: number } {
  const p = PAPER[page.size];
  return page.orientation === "landscape" ? { w: p.h, h: p.w } : p;
}

/** CSS custom properties of a theme. */
export function tokensCss(manifest: ThemeManifest, page: PageSetup, brand?: Brand): string {
  const { colors: c, type: t, grid: g } = manifest.tokens;
  const dim = pageDimensions(page);
  const scale = MARGIN_SCALE[page.size];
  const mm = (v: string) => `${(Number.parseFloat(v) * scale).toFixed(1)}mm`;
  const pad = (v: string) => `${(Number.parseFloat(v) * scale).toFixed(1)}mm`;
  const vars: Record<string, string> = {
    ink: c.ink,
    heading: c.heading,
    muted: c.muted,
    accent: c.accent,
    rule: c.rule,
    paper: c.paper,
    surface: c.surface,
    "code-bg": c.codeBg,
    "cover-bg": c.coverBg,
    "cover-ink": c.coverInk,
    "cover-muted": c.coverMuted,
    "info-bg": c.tones.info.bg,
    "info-bar": c.tones.info.bar,
    "success-bg": c.tones.success.bg,
    "success-bar": c.tones.success.bar,
    "warning-bg": c.tones.warning.bg,
    "warning-bar": c.tones.warning.bar,
    "danger-bg": c.tones.danger.bg,
    "danger-bar": c.tones.danger.bar,
    "font-body": t.body,
    "font-display": t.display,
    "font-mono": t.mono,
    "fs-body": t.bodySize,
    "lh-body": t.lineHeight,
    "fs-h1": t.h1,
    "fs-h2": t.h2,
    "fs-h3": t.h3,
    "fs-cover": t.cover,
    "fs-small": t.small,
    "fs-caption": t.caption,
    "fs-table": t.table,
    "fs-code": t.code,
    u: g.baseline,
    "cell-y": "3.2pt",
    "cell-x": "5pt",
    "page-w": `${dim.w}mm`,
    "page-h": `${dim.h}mm`,
    "cover-pad-top": mm("24mm"),
    "cover-pad-x": pad("24mm"),
    "cover-pad-bottom": pad("22mm"),
  };
  const accent = brand?.accent ?? c.accent;
  vars.accent = accent;
  vars["accent-text"] = brand?.accentText ?? c.accent;
  vars["accent-dark"] = mix(vars["accent-text"] as string, "#000000", 0.3);
  vars["accent-tint"] = mix(accent, "#ffffff", 0.9);
  vars["accent-soft"] = mix(accent, "#ffffff", 0.75);
  const chartInk = brand?.ink ?? c.heading;
  const palette = [
    accent,
    chartInk,
    mix(accent, "#ffffff", 0.4),
    mix(chartInk, "#ffffff", 0.45),
    mix(accent, chartInk, 0.5),
    mix(accent, "#ffffff", 0.7),
  ];
  palette.forEach((color, i) => {
    vars[`chart-${i + 1}`] = color;
  });
  if (brand?.ink) {
    vars.ink = brand.ink;
    vars.heading = brand.ink;
  }
  if (brand?.accent) {
    vars["info-bar"] = accent;
    vars["info-bg"] = vars["accent-tint"] as string;
    if (!brand.ink && manifest.coverFromAccent)
      vars["cover-bg"] = mix(vars["accent-text"] as string, "#000000", 0.42);
  }
  if (brand?.ink) {
    // Ink is the dark brand color: it paints the cover (large surface) in every theme and the
    // accent stays for rules, bars and highlights.
    const onInk = "#ffffff";
    let muted = mix(brand.ink, onInk, 0.78);
    for (let t = 0.78; contrast(muted, brand.ink) < MIN_CONTRAST && t < 1; t += 0.04)
      muted = mix(brand.ink, onInk, t);
    let kicker = accent;
    for (let t = 0; contrast(kicker, brand.ink) < MIN_CONTRAST && t <= 1; t += 0.1)
      kicker = mix(accent, onInk, t);
    vars["cover-bg"] = brand.ink;
    vars["cover-ink"] = onInk;
    vars["cover-muted"] = muted;
    vars["cover-title"] = onInk;
    vars["cover-sub"] = muted;
    vars["cover-kicker"] = kicker;
    vars["cover-deco"] = mix(brand.ink, onInk, 0.12);
  }
  return `:root {\n${Object.entries(vars)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join("\n")}\n}\n`;
}

const cssString = (s: string) =>
  `"${s
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\"]/g, "\\$&")
    .trim()
    .slice(0, 90)}"`;

export interface PageCssInput {
  manifest: ThemeManifest;
  page: PageSetup;
  title: string;
  organization?: string | undefined;
  date?: string | undefined;
  hasCover: boolean;
}

/** `@page` rules: size, margins, header/footer margin boxes and the borderless cover page. */
export function pageCss(input: PageCssInput): string {
  const { manifest, page } = input;
  const { margin } = manifest.tokens.grid;
  const scale = MARGIN_SCALE[page.size];
  const m = (v: string) => `${(Number.parseFloat(v) * scale).toFixed(1)}mm`;
  const { type: t, colors: c, chrome } = manifest.tokens;
  const label = (kind: string): string | undefined => {
    switch (kind) {
      case "title":
        return cssString(input.title);
      case "org":
        return input.organization ? cssString(input.organization) : undefined;
      case "date":
        return input.date ? cssString(input.date) : undefined;
      case "page":
        return "counter(page)";
      case "pageOfTotal":
        return 'counter(page) " / " counter(pages)';
      default:
        return undefined;
    }
  };
  const box = (name: string, kind: string, align: string, edge: "top" | "bottom") => {
    const content = label(kind);
    if (!content) return "";
    return `  @${name} { content: ${content}; font-family: ${t.display}; font-size: 7.6pt; font-weight: 500; letter-spacing: 0.04em; color: ${c.muted}; text-align: ${align}; vertical-align: ${edge === "top" ? "bottom" : "top"}; padding-${edge === "top" ? "bottom" : "top"}: 7pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n`;
  };
  const dim = pageDimensions(page);
  const none = (name: string) => `  @${name} { content: none; }\n`;
  const boxes = [
    "top-left",
    "top-center",
    "top-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
  ];
  return (
    `@page {\n  size: ${dim.w}mm ${dim.h}mm;\n  margin: ${m(margin.top)} ${m(margin.right)} ${m(margin.bottom)} ${m(margin.left)};\n` +
    box("top-left", chrome.header.left, "left", "top") +
    box("top-right", chrome.header.right, "right", "top") +
    box("bottom-left", chrome.footer.left, "left", "bottom") +
    box("bottom-center", chrome.footer.center, "center", "bottom") +
    box("bottom-right", chrome.footer.right, "right", "bottom") +
    "}\n" +
    (input.hasCover ? `@page cover {\n  margin: 0;\n${boxes.map(none).join("")}}\n` : "")
  );
}

export function supportedSizes(manifest: ThemeManifest): PageSize[] {
  return manifest.pageSizes;
}
