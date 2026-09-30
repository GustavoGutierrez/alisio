/**
 * KaTeX rendering as a pure function (spec §10.4): untrusted input (`trust:false`), bounded
 * macro expansion and no throwing. A parse error comes back as `{error}` so the view shows the
 * source and the message instead of KaTeX's inline red error span.
 */
import type { KatexOptions } from "katex";

export const KATEX_OPTIONS = {
  throwOnError: false,
  trust: false,
  strict: "ignore",
  maxExpand: 500,
  maxSize: 50,
  output: "htmlAndMathml",
} as const satisfies KatexOptions;

export interface KatexLike {
  renderToString(latex: string, options: KatexOptions): string;
}

export type MathResult = { html: string } | { error: string };

const ERROR_TITLE = /class="katex-error"[^>]*title="([^"]*)"/;

const unescape = (text: string) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

export function renderMath(katex: KatexLike, latex: string, display: boolean): MathResult {
  try {
    // Per block macros: KaTeX mutates the object with `\gdef`, so each call gets its own.
    const html = katex.renderToString(latex, {
      ...KATEX_OPTIONS,
      displayMode: display,
      macros: {},
    });
    const failed = ERROR_TITLE.exec(html);
    if (failed) return { error: unescape(failed[1] ?? "KaTeX parse error") };
    return { html };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
