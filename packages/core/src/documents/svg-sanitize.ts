/**
 * Strict SVG sanitizer (spec 026 §5.7.3). SVG is parsed as XML by a small tokenizer (no DOCTYPE,
 * entities, CDATA or processing instructions) and rebuilt from allowlists of elements and
 * attributes. Nothing external survives: `href` only points to `#id` (or raster data on
 * `<image>`), `url()` only to `#id`, no scripts, no `foreignObject`, no event handlers.
 * Anything that cannot be made safe is rejected with a reason; the caller skips the image.
 */

export const SVG_LIMITS = { bytes: 2 * 1024 * 1024, elements: 20_000, depth: 64 } as const;

export type SvgResult = { ok: true; svg: string } | { ok: false; reason: string };

const ELEMENTS = [
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
  "pattern",
  "symbol",
  "use",
  "image",
  "title",
  "desc",
  "style",
];
const ELEMENT_BY_LOWER = new Map(ELEMENTS.map((e) => [e.toLowerCase(), e]));
const TEXTUAL = new Set(["text", "tspan", "title", "desc", "style"]);

const ATTRIBUTES = [
  "id",
  "class",
  "style",
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "color",
  "d",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "viewBox",
  "preserveAspectRatio",
  "points",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "fx",
  "fy",
  "fr",
  "patternUnits",
  "patternTransform",
  "patternContentUnits",
  "clip-path",
  "clip-rule",
  "clipPathUnits",
  "mask",
  "maskUnits",
  "maskContentUnits",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "letter-spacing",
  "dx",
  "dy",
  "rotate",
  "textLength",
  "lengthAdjust",
  "display",
  "visibility",
  "vector-effect",
  "role",
  "aria-label",
  "aria-hidden",
  "aria-labelledby",
  "href",
  "xlink:href",
];
const ATTRIBUTE_BY_LOWER = new Map(ATTRIBUTES.map((a) => [a.toLowerCase(), a]));
const SVG_NS = "http://www.w3.org/2000/svg";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

class Reject extends Error {}
const reject = (reason: string): never => {
  throw new Reject(reason);
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (_m, name: string) => {
    if (name.startsWith("#")) {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      if (
        !Number.isFinite(code) ||
        code < 9 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code < 0xe000)
      )
        return reject("invalid character reference");
      return String.fromCodePoint(code);
    }
    const value = ENTITIES[name];
    return value ?? reject(`entity &${name}; is not allowed`);
  });
}

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

const FRAGMENT = /^#[A-Za-z_][\w.:-]*$/;
const RASTER_DATA = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/;

/** Throws when a value (attribute or style text) could load or run anything. */
function checkValue(value: string, where: string): void {
  if (/javascript:|vbscript:|livescript:/i.test(value)) reject(`${where} contains javascript:`);
  if (/expression\s*\(|behavior\s*:|-moz-binding|@import|@font-face/i.test(value))
    reject(`${where} is not allowed in style (expression, behavior or @import)`);
  const urls = value.match(/url\s*\(/gi) ?? [];
  const safe = value.match(/url\(\s*(['"]?)#[\w.:-]+\1\s*\)/g) ?? [];
  if (urls.length !== safe.length) reject(`${where} has an external url() reference`);
  if (/\bimage-set\s*\(|\bsrc\s*\(/i.test(value)) reject(`${where} has an external reference`);
}

interface Node {
  name: string;
  attrs: Array<[string, string]>;
  children: Array<Node | string>;
}

function cleanAttributes(element: string, raw: Array<[string, string]>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [rawName, rawValue] of raw) {
    const lower = rawName.toLowerCase();
    if (lower.startsWith("on")) reject(`event handler attribute ${rawName} is not allowed`);
    if (lower === "xmlns" || lower === "xmlns:xlink") {
      if (lower === "xmlns" && decode(rawValue) !== SVG_NS)
        reject("foreign namespace is not allowed");
      continue;
    }
    if (lower.startsWith("xmlns:")) reject("foreign namespace is not allowed");
    const name = ATTRIBUTE_BY_LOWER.get(lower);
    if (!name) continue;
    const value = decode(rawValue);
    if (name === "href" || name === "xlink:href") {
      const v = value.trim();
      const dataOk = element === "image" && RASTER_DATA.test(v);
      if (!FRAGMENT.test(v) && !dataOk)
        reject("href may only point to an internal #fragment or, on image, raster data");
      out.push(["href", v]);
      continue;
    }
    checkValue(value, name === "style" ? "style attribute" : `attribute ${name}`);
    out.push([name, value]);
  }
  return out;
}

function parse(source: string): Node {
  let text = source.replace(/^﻿/, "");
  const prolog = /^\s*<\?xml\s[^>]*\?>/i.exec(text);
  if (prolog) text = text.slice(prolog[0].length);
  const tag = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>"']+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
  const attr = /\s+([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const root: Node = { name: "#root", attrs: [], children: [] };
  const stack: Node[] = [root];
  let elements = 0;
  let pos = 0;
  while (pos < text.length) {
    const lt = text.indexOf("<", pos);
    const chunk = text.slice(pos, lt === -1 ? undefined : lt);
    if (chunk) {
      const top = stack[stack.length - 1] as Node;
      if (TEXTUAL.has(top.name)) top.children.push(decode(chunk));
      else if (chunk.trim() && top === root) reject("malformed: text outside the svg element");
      else decode(chunk);
    }
    if (lt === -1) break;
    pos = lt;
    if (text.startsWith("<!--", pos)) {
      const end = text.indexOf("-->", pos + 4);
      if (end === -1) reject("malformed: unterminated comment");
      pos = end + 3;
      continue;
    }
    if (text.startsWith("<!DOCTYPE", pos) || text.startsWith("<!doctype", pos))
      reject("DOCTYPE is not allowed");
    if (text.startsWith("<![CDATA[", pos)) reject("CDATA is not allowed");
    if (text.startsWith("<?", pos)) reject("processing instructions are not allowed");
    if (text.startsWith("<!", pos)) reject("malformed: unsupported declaration");
    tag.lastIndex = pos;
    const m = tag.exec(text);
    if (!m) reject("malformed markup");
    const [whole, closing, rawName = "", rawAttrs = "", selfClose] = m as RegExpExecArray;
    pos += whole.length;
    if (rawName.includes(":")) reject("foreign namespace element is not allowed");
    const name = ELEMENT_BY_LOWER.get(rawName.toLowerCase());
    const top = stack[stack.length - 1] as Node;
    if (closing) {
      if (!name || top.name !== name || top === root) reject("malformed: mismatched closing tag");
      stack.pop();
      continue;
    }
    if (!name) reject(`element <${rawName}> is not allowed (only svg drawing elements are)`);
    if (++elements > SVG_LIMITS.elements) reject(`more than ${SVG_LIMITS.elements} elements`);
    if (stack.length > SVG_LIMITS.depth) reject("nesting is too deep");
    if (top === root && (root.children.length > 0 || name !== "svg"))
      reject("the root element must be a single svg");
    const raw: Array<[string, string]> = [];
    attr.lastIndex = 0;
    for (const a of rawAttrs.matchAll(attr)) raw.push([a[1] as string, (a[2] ?? a[3]) as string]);
    const node: Node = {
      name: name as string,
      attrs: cleanAttributes(name as string, raw),
      children: [],
    };
    top.children.push(node);
    if (!selfClose) stack.push(node);
  }
  if (stack.length !== 1) reject("malformed: unclosed element");
  const svg = root.children.find((c): c is Node => typeof c !== "string");
  if (!svg || svg.name !== "svg") return reject("the root element must be svg");
  return svg;
}

function checkStyleElement(node: Node): void {
  const css = node.children.filter((c): c is string => typeof c === "string").join("");
  try {
    checkValue(css, "style element");
  } catch (e) {
    if (e instanceof Reject) reject(`unsafe style element: ${e.message}`);
    throw e;
  }
}

function serialize(node: Node, isRoot: boolean): string {
  if (node.name === "style") checkStyleElement(node);
  const attrs = [...node.attrs];
  if (isRoot) attrs.unshift(["xmlns", SVG_NS]);
  const open = `<${node.name}${attrs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("")}`;
  if (node.children.length === 0) return `${open}/>`;
  const inner = node.children
    .map((c) => (typeof c === "string" ? escText(c) : serialize(c, false)))
    .join("");
  return `${open}>${inner}</${node.name}>`;
}

export function sanitizeSvg(source: string | Uint8Array): SvgResult {
  const text = typeof source === "string" ? source : Buffer.from(source).toString("utf8");
  if (Buffer.byteLength(text) > SVG_LIMITS.bytes)
    return { ok: false, reason: `SVG is larger than ${SVG_LIMITS.bytes / (1024 * 1024)} MB` };
  try {
    return { ok: true, svg: serialize(parse(text), true) };
  } catch (error) {
    if (error instanceof Reject) return { ok: false, reason: error.message };
    throw error;
  }
}
