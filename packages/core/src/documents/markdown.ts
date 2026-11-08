/**
 * Markdown to `DocumentSpec` (spec 026 §5.3). Uses only the `marked` lexer; raw HTML never
 * becomes markup: it stays text inside the inline strings, which `render-html.ts` escapes.
 */
import { Lexer, type Token, type Tokens } from "marked";
import { parse as parseYaml } from "yaml";
import { DOCUMENT_LIMITS, DocumentError } from "./limits.ts";
import type { Block, DocumentSpec, Tone } from "./spec.ts";

export interface MarkdownAsset {
  id: string;
  /** Link as written (relative to the Markdown file or the workspace; resolved by the caller). */
  href: string;
  alt: string;
}

export interface MarkdownResult {
  spec: DocumentSpec;
  assets: MarkdownAsset[];
  warnings: Array<{ code: string; message: string; blockIndex?: number }>;
  /** `theme` from front matter. */
  theme?: string;
  lang?: string;
  accent?: string;
  ink?: string;
}

const REMOTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const CALLOUTS: Record<string, { tone: Tone; title: string }> = {
  NOTE: { tone: "info", title: "Note" },
  TIP: { tone: "success", title: "Tip" },
  IMPORTANT: { tone: "info", title: "Important" },
  WARNING: { tone: "warning", title: "Warning" },
  CAUTION: { tone: "danger", title: "Caution" },
};

function frontMatter(source: string): { data: Record<string, unknown>; body: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!m) return { data: {}, body: source };
  try {
    const data = parseYaml(m[1] ?? "");
    if (data && typeof data === "object" && !Array.isArray(data))
      return { data: data as Record<string, unknown>, body: source.slice(m[0].length) };
  } catch {
    // not front matter: keep the text as content
  }
  return { data: {}, body: source };
}

const str = (v: unknown, max = 300): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

/** Inline Markdown of a token list, with images replaced by their alt text. */
function inlineText(tokens: Token[] | undefined, fallback: string): string {
  if (!tokens) return fallback;
  return tokens
    .map((t) => {
      if (t.type === "image") return (t as Tokens.Image).text;
      if ("tokens" in t && Array.isArray(t.tokens) && (t.type === "strong" || t.type === "em")) {
        return `${t.type === "strong" ? "**" : "*"}${inlineText(t.tokens, t.raw)}${t.type === "strong" ? "**" : "*"}`;
      }
      return t.raw;
    })
    .join("");
}

export interface MarkdownOptions {
  /** `false` builds no cover at all (also ignores a front matter title for the cover). */
  cover?: boolean;
}

const META_LINE = /^\*\*(.+?)\*\*[ \t]*:?[ \t]*(.*)$/;
const SUBTITLE_KEY = /^(subt[ií]tulo|subtitle|tagline|lema)$/i;

/** A paragraph made only of bold "Key: value" lines (or a lone bold line) right under the title. */
function coverMetadata(text: string): { meta: string[]; subtitle?: string } | undefined {
  const lines = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length || lines.length > 8) return undefined;
  const meta: string[] = [];
  let subtitle: string | undefined;
  for (const line of lines) {
    const m = META_LINE.exec(line);
    if (!m?.[1]) return undefined;
    const key = m[1].replace(/[:：]\s*$/, "").trim();
    const value = (m[2] ?? "").trim();
    if (SUBTITLE_KEY.test(key) && value) subtitle = value;
    else if (!value && lines.length === 1) subtitle = key;
    else meta.push(value ? `${key}: ${value}` : key);
  }
  return { meta: meta.slice(0, 6), ...(subtitle ? { subtitle } : {}) };
}

export function markdownToSpec(source: string, options: MarkdownOptions = {}): MarkdownResult {
  if (Buffer.byteLength(source) > DOCUMENT_LIMITS.markdownBytes)
    throw new DocumentError(
      "DOCUMENT_LIMIT_EXCEEDED",
      `Markdown is larger than ${DOCUMENT_LIMITS.markdownBytes / 1024} KB`,
    );
  const { data, body } = frontMatter(source);
  const blocks: Block[] = [];
  const assets: MarkdownAsset[] = [];
  const warnings: MarkdownResult["warnings"] = [];
  const title = str(data.title, 200);

  const add = (block: Block) => blocks.push(block);
  const imageBlock = (img: Tokens.Image) => {
    if (REMOTE.test(img.href)) {
      warnings.push({
        code: "remote_image_skipped",
        message: `Remote image not fetched: ${img.text || "image"}`,
        blockIndex: blocks.length,
      });
      if (img.text) add({ type: "paragraph", text: img.text });
      return;
    }
    const id = `img${assets.length + 1}`;
    assets.push({ id, href: img.href, alt: img.text });
    add({ type: "image", asset: id, ...(img.text ? { caption: img.text } : {}) });
  };

  const itemText = (item: Tokens.ListItem): string => {
    const own = item.tokens.filter((t) => t.type === "text" || t.type === "paragraph");
    const text = own
      .map((t) => inlineText((t as Tokens.Text).tokens, t.raw))
      .join(" ")
      .trim();
    return item.task ? `${item.checked ? "[x]" : "[ ]"} ${text}` : text;
  };

  const walk = (tokens: Token[]) => {
    for (const token of tokens) {
      switch (token.type) {
        case "heading": {
          const t = token as Tokens.Heading;
          add({
            type: "heading",
            level: Math.min(t.depth, 3) as 1 | 2 | 3,
            text: inlineText(t.tokens, t.text),
          });
          break;
        }
        case "paragraph": {
          const t = token as Tokens.Paragraph;
          const trimmed = t.text.trim();
          if (trimmed === "---pagebreak---") add({ type: "page_break" });
          else if (/^\[toc\]$/i.test(trimmed)) add({ type: "toc" });
          else if (t.tokens?.length === 1 && t.tokens[0]?.type === "image")
            imageBlock(t.tokens[0] as Tokens.Image);
          else add({ type: "paragraph", text: inlineText(t.tokens, t.text) });
          break;
        }
        case "text":
          add({ type: "paragraph", text: (token as Tokens.Text).text });
          break;
        case "html":
          // Raw HTML is untrusted: it is kept as visible text, never as markup.
          add({ type: "paragraph", text: (token as Tokens.HTML).text.trim() });
          break;
        case "list": {
          const t = token as Tokens.List;
          add({
            type: "bullets",
            ...(t.ordered ? { ordered: true } : {}),
            items: t.items.map((item) => {
              const nested = item.tokens.find((x) => x.type === "list") as Tokens.List | undefined;
              const text = itemText(item);
              return nested ? { text, items: nested.items.map(itemText) } : text;
            }),
          });
          break;
        }
        case "table": {
          const t = token as Tokens.Table;
          add({
            type: "table",
            columns: t.header.slice(0, 12).map((h) => ({
              label: inlineText(h.tokens, h.text),
              ...(h.align ? { align: h.align } : {}),
            })),
            rows: t.rows.map((r) => r.slice(0, 12).map((c) => inlineText(c.tokens, c.text))),
          });
          break;
        }
        case "blockquote": {
          const t = token as Tokens.Blockquote;
          const paragraphs = t.tokens
            .filter((x) => x.type === "paragraph")
            .map((x) => inlineText((x as Tokens.Paragraph).tokens, x.raw).trim());
          const first = paragraphs[0] ?? t.text;
          const m = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?([\s\S]*)$/.exec(first);
          if (m?.[1]) {
            const meta = CALLOUTS[m[1]];
            if (meta)
              add({
                type: "callout",
                tone: meta.tone,
                title: meta.title,
                text: [m[2]?.trim() ?? "", ...paragraphs.slice(1)].filter(Boolean).join("\n\n"),
              });
          } else add({ type: "quote", text: paragraphs.join("\n\n") || t.text });
          break;
        }
        case "code": {
          const t = token as Tokens.Code;
          add({
            type: "code",
            text: t.text,
            ...(t.lang ? { language: t.lang.split(/\s/)[0] ?? "" } : {}),
          });
          break;
        }
        default:
          // space, hr (only `---pagebreak---` breaks pages), def, escape...
          break;
      }
    }
  };
  walk(Lexer.lex(body));

  const wantCover = options.cover !== false && data.cover !== false;
  const head: Block[] = [];
  let derived: { title: string; subtitle?: string; meta?: string[] } | undefined;
  let logoAsset: string | undefined;
  const logoHref = str(data.logo, 300);
  if (logoHref && !REMOTE.test(logoHref)) {
    logoAsset = "logo";
    assets.unshift({ id: "logo", href: logoHref, alt: str(data.logoAlt, 200) ?? "" });
  }
  /** An image block right under the cover title (or its details) becomes the cover logo. */
  const takeLogo = () => {
    const next = blocks[0];
    if (logoAsset || next?.type !== "image") return;
    const asset = assets.find((x) => x.id === next.asset);
    if (!asset) return;
    blocks.shift();
    asset.id = "logo";
    logoAsset = "logo";
  };
  if (!title && wantCover) {
    // No front matter title: the first H1 is the title and the bold "Key: value" lines under it
    // (version, date, author...) become the cover.
    const first = blocks[0];
    if (first?.type === "heading" && first.level === 1) {
      blocks.shift();
      derived = { title: first.text };
      takeLogo();
      const next = blocks[0];
      const found = next?.type === "paragraph" ? coverMetadata(next.text) : undefined;
      if (found) {
        blocks.shift();
        if (found.subtitle) derived.subtitle = found.subtitle;
        if (found.meta.length) derived.meta = found.meta;
        takeLogo();
      }
    }
  }
  if (derived) {
    head.push({
      type: "cover",
      title: derived.title,
      ...(derived.subtitle ? { subtitle: derived.subtitle } : {}),
      ...(derived.meta ? { meta: derived.meta } : {}),
      ...(logoAsset ? { logoAsset } : {}),
    });
  } else if (title && wantCover) {
    const meta = [str(data.author, 200), str(data.date, 60), str(data.organization, 200)].filter(
      (x): x is string => !!x,
    );
    const subtitle = str(data.subtitle);
    head.push({
      type: "cover",
      title,
      ...(subtitle ? { subtitle } : {}),
      ...(meta.length ? { meta } : {}),
      ...(logoAsset ? { logoAsset } : {}),
    });
  }
  if (data.toc === true && !blocks.some((b) => b.type === "toc")) head.push({ type: "toc" });
  const spec: DocumentSpec = {
    version: 1,
    meta: {
      ...(title ? { title } : derived ? { title: derived.title.replace(/[*_`]/g, "") } : {}),
      ...(str(data.subtitle) ? { subtitle: str(data.subtitle) as string } : {}),
      ...(str(data.author, 200) ? { author: str(data.author, 200) as string } : {}),
      ...(str(data.date, 60) ? { date: str(data.date, 60) as string } : {}),
      ...(str(data.organization, 200)
        ? { organization: str(data.organization, 200) as string }
        : {}),
    },
    blocks: [...head, ...blocks],
  };
  const theme = str(data.theme, 60);
  const lang = str(data.lang, 35);
  const accent = str(data.accent, 20);
  const ink = str(data.ink, 20);
  return {
    spec,
    assets,
    warnings,
    ...(theme ? { theme } : {}),
    ...(lang ? { lang } : {}),
    ...(accent ? { accent } : {}),
    ...(ink ? { ink } : {}),
  };
}
