/**
 * Brand colors (`theme.accent`, `theme.ink`): validated hex values with a minimum contrast
 * against the theme's paper; a low-contrast color is darkened and reported, never rejected silently.
 */
import { DocumentError } from "./limits.ts";

export interface BrandInput {
  accent?: string | undefined;
  ink?: string | undefined;
}

export interface Brand {
  /** As given (normalized): used for fills, rules and bars, which need no text contrast. */
  accent?: string;
  /** The accent darkened to 4.5:1 on paper: used wherever the accent colors text. */
  accentText?: string;
  ink?: string;
  warnings: Array<{ code: string; message: string }>;
}

export const MIN_CONTRAST = 4.5;

type Rgb = [number, number, number];

export function normalizeHex(value: string, field: string): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m?.[1])
    throw new DocumentError(
      "DOCUMENT_INPUT_INVALID",
      `theme.${field} must be a hex color such as #1d4f91`,
    );
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${hex.toLowerCase()}`;
}

export const toRgb = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

export const toHex = (rgb: Rgb): string =>
  `#${rgb
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

export function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `a` mixed with `b`; `t` is the share of `b` (0..1). */
export function mix(a: string, b: string, t: number): string {
  const [x, y] = [toRgb(a), toRgb(b)];
  return toHex([0, 1, 2].map((i) => (x[i] as number) * (1 - t) + (y[i] as number) * t) as Rgb);
}

/** Darkens toward black until the contrast with `paper` reaches the minimum. */
export function ensureContrast(hex: string, paper: string): { color: string; adjusted: boolean } {
  let color = hex;
  let adjusted = false;
  for (let i = 0; i < 40 && contrast(color, paper) < MIN_CONTRAST; i++) {
    color = mix(color, "#000000", 0.06);
    adjusted = true;
  }
  return { color, adjusted };
}

export function resolveBrand(input: BrandInput, paper: string): Brand {
  const out: Brand = { warnings: [] };
  for (const field of ["accent", "ink"] as const) {
    const raw = input[field];
    if (raw === undefined) continue;
    const hex = normalizeHex(raw, field);
    const fixed = ensureContrast(hex, paper);
    if (field === "accent") {
      out.accent = hex;
      out.accentText = fixed.color;
    } else out.ink = fixed.color;
    if (fixed.adjusted)
      out.warnings.push({
        code: `${field}_adjusted`,
        message:
          field === "accent"
            ? `theme.accent ${hex} has low contrast on the page (minimum ${MIN_CONTRAST}:1); it is kept for rules and fills and darkened to ${fixed.color} where it colors text.`
            : `theme.ink ${hex} has low contrast on the page (minimum ${MIN_CONTRAST}:1); it was darkened to ${fixed.color}.`,
      });
  }
  return out;
}
