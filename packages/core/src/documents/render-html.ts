/**
 * `DocumentSpec` + theme to a render bundle (spec 026 D4, §5.7.1). Every string is escaped; no
 * field is inserted as markup; the page has no script, no inline style and a strict CSP.
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Lexer, type Token, type Tokens } from "marked";
import type { ResolvedAsset } from "./assets.ts";
import type { Brand } from "./brand.ts";
import { chartSvg } from "./chart-svg.ts";
import type { PageSetup } from "./ports.ts";
import type { Block, DocumentSpec } from "./spec.ts";
import { sanitizeSvg } from "./svg-sanitize.ts";
import { assetsRoot, loadBaseCss, loadFontsCss, loadTheme, pageCss, tokensCss } from "./themes.ts";
import type { TocMode } from "./toc-two-pass.ts";

export const ORIGIN = "https://document.invalid/";
export const CSP =
  "default-src 'none'; style-src https://document.invalid; font-src https://document.invalid; img-src https://document.invalid";

/** Presentation hints the repair strategies set (spec §5.8); never content. */
export interface RenderHints {
  density?: "normal" | "compact";
  breakBefore?: ReadonlySet<number>;
  mediumImages?: boolean;
}

export interface RenderOptions {
  theme: string;
  page: PageSetup;
  lang?: string;
  title?: string;
  hints?: RenderHints;
  /** Brand accent and ink (validated by `resolveBrand`). */
  brand?: Brand;
  /** Images left out of the bundle: id to alt text; they print as a small placeholder. */
  skippedAssets?: ReadonlyMap<string, string>;
  /** Contents page numbers: placeholders (pass 1), real numbers (pass 2) or none (links only). */
  toc?: TocMode;
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};
const decode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);

const SAFE_LINK = /^(?:https?:|mailto:)/i;

/** Renders inline tokens. `html` tokens and unknown tokens become visible, escaped text. */
function inlineTokens(tokens: Token[]): string {
  return tokens
    .map((t) => {
      switch (t.type) {
        case "text":
        case "escape":
          return esc(decode((t as Tokens.Text).text));
        case "strong":
          return `<strong>${inlineTokens((t as Tokens.Strong).tokens)}</strong>`;
        case "em":
          return `<em>${inlineTokens((t as Tokens.Em).tokens)}</em>`;
        case "del":
          return `<del>${inlineTokens((t as Tokens.Del).tokens)}</del>`;
        case "codespan":
          return `<code>${esc(decode((t as Tokens.Codespan).text))}</code>`;
        case "br":
          return "<br>";
        case "link": {
          const l = t as Tokens.Link;
          const inner = inlineTokens(l.tokens);
          return SAFE_LINK.test(l.href.trim())
            ? `<a href="${esc(l.href.trim())}">${inner}</a>`
            : inner;
        }
        case "image":
          return esc((t as Tokens.Image).text);
        default:
          return esc(t.raw);
      }
    })
    .join("");
}

export const inline = (text: string): string => inlineTokens(new Lexer().inlineTokens(text));

/** Plain text of an inline string (table of contents, document title). */
export function plain(text: string): string {
  const walk = (tokens: Token[]): string =>
    tokens
      .map((t) => {
        if (t.type === "image") return (t as Tokens.Image).text;
        if ("tokens" in t && Array.isArray(t.tokens)) return walk(t.tokens);
        if (t.type === "text" || t.type === "escape" || t.type === "codespan")
          return decode((t as Tokens.Text).text);
        return t.raw;
      })
      .join("");
  return walk(new Lexer().inlineTokens(text));
}

const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => `<p>${inline(p.trim()).replace(/\n/g, " ")}</p>`)
    .join("");

/** Label of the table of contents by language (UI strings are EN and ES; a few more are free). */
const TOC_LABELS: Record<string, string> = {
  es: "Índice",
  pt: "Sumário",
  fr: "Sommaire",
  it: "Indice",
  de: "Inhalt",
};

/** A heading that already starts with its number (`02. Historia`, `2.1 Origen`, `3.`). */
export const NUMBERED = /^\d+(\.\d+)*\.?\s/;

export interface RenderedBundle {
  entry: string;
  files: string[];
  title: string;
  hasCover: boolean;
  headings: Array<{ block: number; level: number; text: string; id: string }>;
}

/** Headings of the document (and appendix titles) with the ids the contents link to. */
export function collectHeadings(spec: DocumentSpec): RenderedBundle["headings"] {
  const out: RenderedBundle["headings"] = [];
  spec.blocks.forEach((b, i) => {
    if (b.type === "heading")
      out.push({ block: i, level: b.level, text: plain(b.text), id: b.id ?? `h-${i}` });
    if (b.type === "appendix") {
      out.push({ block: i, level: 1, text: plain(b.title), id: `appendix-${i}` });
      b.blocks.forEach((x, j) => {
        if (x.type === "heading")
          out.push({ block: i, level: x.level, text: plain(x.text), id: x.id ?? `h-${i}-${j}` });
      });
    }
  });
  return out;
}

function renderBlocks(
  spec: DocumentSpec,
  assets: ReadonlyMap<string, ResolvedAsset>,
  hints: RenderHints,
  tocLabel: string,
  skippedAlt: ReadonlyMap<string, string>,
  toc: TocMode = { kind: "none" },
  lang?: string,
) {
  const headings = collectHeadings(spec);
  const attrTop = (i: number, extra = "") =>
    `data-b="${i}"${hints.breakBefore?.has(i) ? ' class="force-break"' : ""}${extra}`;
  const src = (id: string) => {
    const a = assets.get(id);
    return a ? `${ORIGIN}${a.file}` : "";
  };

  const render = (b: Block, i: number, nested?: number): string => {
    const key = nested === undefined ? `${i}` : `${i}-${nested}`;
    const attr = (index: number, extra = "") =>
      nested === undefined ? attrTop(index, extra) : `data-n="${key}"${extra}`;
    switch (b.type) {
      case "cover": {
        const org = spec.meta?.organization;
        const img = b.imageAsset && src(b.imageAsset);
        const logo = b.logoAsset && src(b.logoAsset);
        const logoAlt = (b.logoAsset && assets.get(b.logoAsset)?.alt) || "";
        return `<section class="cover" data-b="${i}">
${logo ? `<img class="cover-logo" src="${esc(logo)}" alt="${esc(logoAlt)}">` : ""}
<div class="cover-kicker">${org ? esc(org) : ""}</div>
<div class="cover-rule"></div>
<div class="cover-title" role="heading" aria-level="1">${inline(b.title)}</div>
${b.subtitle ? `<p class="cover-sub">${inline(b.subtitle)}</p>` : ""}
${img ? `<img class="cover-image" src="${esc(img)}" alt="">` : ""}
<div class="cover-spacer"></div>
${b.meta?.length ? `<ul class="cover-meta">${b.meta.map((m) => `<li>${inline(m)}</li>`).join("")}</ul>` : ""}
</section>`;
      }
      case "heading": {
        const id = b.id ?? `h-${key}`;
        return `<h${b.level} id="${esc(id)}" ${attr(i)}>${inline(b.text)}</h${b.level}>`;
      }
      case "paragraph":
        return `<div ${attr(i)}>${paragraphs(b.text)}</div>`;
      case "bullets": {
        const tag = b.ordered ? "ol" : "ul";
        const items = b.items
          .map((it) =>
            typeof it === "string"
              ? `<li>${inline(it)}</li>`
              : `<li>${inline(it.text)}<${tag}>${it.items.map((s) => `<li>${inline(s)}</li>`).join("")}</${tag}></li>`,
          )
          .join("");
        return `<${tag} ${attr(i)}>${items}</${tag}>`;
      }
      case "table": {
        const cols = b.columns;
        const cls = (n: number) => {
          const a = cols[n]?.align;
          return a === "right" ? ' class="a-r"' : a === "center" ? ' class="a-c"' : "";
        };
        const colgroup = cols.some((c) => c.width && c.width !== "auto")
          ? `<colgroup>${cols.map((c) => `<col${c.width && c.width !== "auto" ? ` class="${c.width}"` : ""}>`).join("")}</colgroup>`
          : "";
        const head =
          b.header === false
            ? ""
            : `<thead><tr>${cols.map((c, n) => `<th${cls(n)}>${inline(c.label)}</th>`).join("")}</tr></thead>`;
        const rows = b.rows
          .map(
            (r) =>
              `<tr>${cols.map((_, n) => `<td${cls(n)}>${inline(r[n] ?? "")}</td>`).join("")}</tr>`,
          )
          .join("");
        return `<div class="tablewrap" ${attr(i)}><table>${b.caption ? `<caption>${inline(b.caption)}</caption>` : ""}${colgroup}${head}<tbody>${rows}</tbody></table></div>`;
      }
      case "image": {
        if (!assets.has(b.asset)) {
          const label = skippedAlt.get(b.asset) || b.caption || b.asset;
          return `<figure class="img placeholder" ${attr(i)}><div class="ph">${esc(label)}</div></figure>`;
        }
        const size =
          hints.mediumImages && (b.size ?? "full") === "full" ? "medium" : (b.size ?? "full");
        const a = assets.get(b.asset);
        return `<figure class="img size-${size}" ${attr(i)}><img src="${esc(src(b.asset))}" alt="${esc(a?.alt ?? b.caption ?? "")}">${b.caption ? `<figcaption>${inline(b.caption)}</figcaption>` : ""}</figure>`;
      }
      case "quote":
        return `<blockquote class="quote" ${attr(i)}>${paragraphs(b.text)}${b.attribution ? `<div class="attr">${inline(b.attribution)}</div>` : ""}</blockquote>`;
      case "callout":
        return `<aside class="callout tone-${b.tone}" ${attr(i)}>${b.title ? `<div class="t">${inline(b.title)}</div>` : ""}${paragraphs(b.text)}</aside>`;
      case "code":
        return `<div class="code" ${attr(i)}>${b.language ? `<div class="lang">${esc(b.language)}</div>` : ""}<pre><code>${esc(b.text)}</code></pre></div>`;
      case "stat_grid":
        return `<div class="stats n${b.items.length}" ${attr(i)}>${b.items
          .map(
            (s) =>
              `<div class="stat${s.tone ? ` tone-${s.tone}` : ""}"><div class="v">${esc(s.value)}</div><div class="l">${esc(s.label)}</div>${s.delta ? `<div class="d">${esc(s.delta)}</div>` : ""}</div>`,
          )
          .join("")}</div>`;
      case "page_break":
        return `<div class="page-break" ${attr(i)}></div>`;
      case "chart": {
        const svg = chartSvg({
          kind: b.kind,
          labels: b.labels,
          series: b.series,
          ...(b.title ? { title: plain(b.title) } : {}),
          ...(b.unit ? { unit: b.unit } : {}),
          ...(lang ? { lang } : {}),
        });
        const clean = sanitizeSvg(svg);
        return `<figure class="chart" ${attr(i)}>${b.title ? `<div class="chart-title">${inline(b.title)}</div>` : ""}${clean.ok ? clean.svg : ""}</figure>`;
      }
      case "svg": {
        if (!assets.has(b.asset)) {
          const label = skippedAlt.get(b.asset) || b.caption || b.asset;
          return `<figure class="img placeholder" ${attr(i)}><div class="ph">${esc(label)}</div></figure>`;
        }
        const a = assets.get(b.asset);
        return `<figure class="img svg size-${b.size ?? "full"}" ${attr(i)}><img src="${esc(src(b.asset))}" alt="${esc(a?.alt ?? b.caption ?? "")}">${b.caption ? `<figcaption>${inline(b.caption)}</figcaption>` : ""}</figure>`;
      }
      case "appendix":
        return `<section class="appendix" id="appendix-${i}" ${attr(i)}><h1 class="appendix-title">${inline(b.title)}</h1>${b.blocks.map((x, j) => render(x, i, j)).join("\n")}</section>`;
      case "toc": {
        const depth = b.depth ?? 2;
        const items = headings
          .filter((h) => h.level <= depth)
          .map((h) => {
            const page =
              toc.kind === "placeholder"
                ? "00"
                : toc.kind === "numbers" && toc.pages.has(h.id)
                  ? String(toc.pages.get(h.id))
                  : "";
            const label = page
              ? `<span class="toc-t">${esc(h.text)}</span><span class="toc-p">${page}</span>`
              : esc(h.text);
            return `<li class="l${h.level}"><a href="#${esc(h.id)}">${label}</a></li>`;
          })
          .join("");
        return `<nav class="toc" ${attr(i)}><div class="toc-title" role="heading" aria-level="1">${esc(tocLabel)}</div><ol>${items}</ol></nav>`;
      }
    }
  };
  const cover = spec.blocks[0]?.type === "cover" ? render(spec.blocks[0], 0) : "";
  const rest = spec.blocks
    .map((b, i) => (b.type === "cover" ? "" : render(b, i)))
    .filter(Boolean)
    .join("\n");
  return { cover, rest, headings };
}

/** Writes the bundle (index.html, css/, fonts/) into `bundleDir`; assets are already there. */
export async function writeBundle(
  spec: DocumentSpec,
  assets: ReadonlyMap<string, ResolvedAsset>,
  bundleDir: string,
  options: RenderOptions,
): Promise<RenderedBundle> {
  const theme = await loadTheme(options.theme);
  const hints = options.hints ?? {};
  const tocLabel = TOC_LABELS[(options.lang ?? "en").slice(0, 2).toLowerCase()] ?? "Contents";
  const { cover, rest, headings } = renderBlocks(
    spec,
    assets,
    hints,
    tocLabel,
    options.skippedAssets ?? new Map(),
    options.toc,
    options.lang,
  );
  const title =
    options.title ??
    spec.meta?.title ??
    (spec.blocks[0]?.type === "cover" ? plain(spec.blocks[0].title) : headings[0]?.text) ??
    "Document";
  const hasCover = cover !== "";
  // Auto-numbering is decided per document: headings that already carry a number are left alone.
  const autoNumber =
    !!theme.manifest.numberedHeadings && !headings.some((h) => NUMBERED.test(h.text));
  const lang = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(options.lang ?? "")
    ? (options.lang as string)
    : "en";
  const css = {
    "css/fonts.css": await loadFontsCss(),
    "css/tokens.css": tokensCss(theme.manifest, options.page, options.brand),
    "css/print-base.css": await loadBaseCss(),
    "css/theme.css": `${theme.css}\n.force-break { break-before: page; }\n`,
    "css/page.css": pageCss({
      manifest: theme.manifest,
      page: options.page,
      title,
      organization: spec.meta?.organization,
      date: spec.meta?.date,
      hasCover,
    }),
  };
  const links = Object.keys(css)
    .map((f) => `<link rel="stylesheet" href="${ORIGIN}${f}">`)
    .join("\n");
  const html = `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${esc(title)}</title>
${spec.meta?.author ? `<meta name="author" content="${esc(spec.meta.author)}">` : ""}
${links}
</head>
<body class="density-${hints.density ?? "normal"}${autoNumber ? " auto-number" : ""}${spec.blocks.some((b) => b.type === "heading" && b.level === 1) ? "" : " no-h1"}">
${cover}
<main>
${rest}
</main>
</body>
</html>
`;
  const written: string[] = ["index.html"];
  await writeFile(join(bundleDir, "index.html"), html);
  for (const [file, text] of Object.entries(css)) {
    await mkdir(dirname(join(bundleDir, file)), { recursive: true });
    await writeFile(join(bundleDir, file), text);
    written.push(file);
  }
  // Fonts of the theme's families (files named in fonts.css).
  const fontFiles = [...css["css/fonts.css"].matchAll(/fonts\/([^"]+\.woff2)/g)].map(
    (m) => m[1] as string,
  );
  const families = new Set(theme.manifest.fonts.map((f) => f.toLowerCase().replace(/ /g, "-")));
  for (const rel of new Set(fontFiles)) {
    if (!families.has(rel.split("/")[0] ?? "")) continue;
    await mkdir(dirname(join(bundleDir, "fonts", rel)), { recursive: true });
    await copyFile(`${assetsRoot()}fonts/${rel}`, join(bundleDir, "fonts", rel));
    written.push(`fonts/${rel}`);
  }
  return { entry: "index.html", files: written, title, hasCover, headings };
}
