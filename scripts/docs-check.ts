/**
 * Checks the documentation sources before VitePress builds them: every internal link resolves to
 * a page, every `#anchor` exists on that page, local images exist, and the English and Spanish
 * pages keep the same structure. VitePress's dead-link check validates pages but not fragments,
 * so this runs first (`pnpm docs:build`).
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/docs-check.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS = resolve("docs");
/** Mirrors `srcExclude` in docs/.vitepress/config.ts; keep both lists in sync. */
const SITE_EXCLUDE = new Set([
  "specification.md",
  "herdr.md",
  "implementation-status.md",
  "validation.txt",
  "benchmark.json",
  "README.md",
]);
/** Pairs whose structure is allowed to differ, with the reason. */
const PARITY_EXEMPT = new Map([
  [
    "limitations.md",
    "docs/es/limitations.md includes docs/implementation-status.md verbatim, so it is a stub",
  ],
]);

export type Heading = { level: number; id: string };
export type Link = { raw: string; line: number; image: boolean };
export type Page = { file: string; headings: Heading[]; links: Link[]; fences: number };

const CONTROL = /[\u0000-\u001f]/g;
const COMBINING = /[\u0300-\u036f]/g;
const SPECIAL = /[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'<>,.?/]+/g;
const HEADING = /^(#{1,6})\s+(.*)$/;
const EXPLICIT = /\{#([^}\s]+)\}\s*$/;
const LINK = /(!?)\[([^\]]*)\]\((<[^>]*>|[^)\s]+)/g;
const FENCE = /^\s*(`{3,}|~{3,})/;

/** VitePress/@mdit-vue heading slug; an explicit `{#id}` in the heading always wins. */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(COMBINING, "")
    .replace(CONTROL, "")
    .replace(SPECIAL, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^(\d)/, "_$1")
    .toLowerCase();
}

/**
 * Comparison key for a `#anchor` target: exact VitePress slug after normalizing the URL encoding.
 * It is deliberately not accent-insensitive — VitePress strips accents when slugifying
 * (`## Ruta rápida` becomes `#ruta-rapida`), so a loose match would hide a broken link.
 */
export function anchorKey(value: string): string {
  return decodeURIComponent(value).trim().toLowerCase();
}

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || entry.name === "public") continue;
      out.push(...markdownFiles(full));
    } else if (entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

export function parseMarkdown(file: string, text: string): Page {
  const headings: Heading[] = [];
  const links: Link[] = [];
  const lines = text.split(/\r?\n/);
  let fence: string | null = null;
  let fences = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const marker = FENCE.exec(line);
    if (marker) {
      const char = (marker[1] ?? "`").charAt(0);
      if (fence === null) {
        fence = char;
        fences++;
      } else if (char === fence) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;
    const heading = HEADING.exec(line);
    if (heading) {
      const text = heading[2] ?? "";
      const explicit = EXPLICIT.exec(text);
      headings.push({
        level: (heading[1] ?? "#").length,
        id: explicit ? (explicit[1] ?? "") : slugify(text.replace(EXPLICIT, "")),
      });
    }
    for (const match of line.matchAll(LINK)) {
      links.push({
        raw: (match[3] ?? "").replace(/^<|>$/g, ""),
        line: i + 1,
        image: match[1] === "!",
      });
    }
  }
  return { file, headings, links, fences };
}

function sitePage(path: string): string | null {
  const clean = path
    .replace(/^\/alisio\//, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (clean === "") return join(DOCS, "index.md");
  if (clean.endsWith(".md")) return existsSync(join(DOCS, clean)) ? join(DOCS, clean) : null;
  if (existsSync(join(DOCS, `${clean}.md`))) return join(DOCS, `${clean}.md`);
  if (existsSync(join(DOCS, clean, "index.md"))) return join(DOCS, clean, "index.md");
  return existsSync(join(DOCS, clean)) ? join(DOCS, clean) : null;
}

function asset(path: string, from: string): boolean {
  if (path.startsWith("/")) {
    const rel = path.replace(/^\/alisio\//, "/").replace(/^\/+/, "");
    return existsSync(join(DOCS, "public", rel)) || existsSync(join(DOCS, rel));
  }
  return existsSync(resolve(dirname(from), decodeURIComponent(path)));
}

type Problem = { file: string; line: number; message: string };

function main(): void {
  const files = markdownFiles(DOCS);
  const cache = new Map<string, Page>();
  const page = (file: string): Page => {
    const cached = cache.get(file);
    if (cached) return cached;
    const parsed = parseMarkdown(file, readFileSync(file, "utf8"));
    cache.set(file, parsed);
    return parsed;
  };

  const problems: Problem[] = [];
  let links = 0;
  let anchors = 0;
  let images = 0;

  for (const file of files) {
    const current = page(file);
    for (const link of current.links) {
      const raw = link.raw;
      const external = /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//");
      if (link.image) {
        images++;
        if (external) continue;
        const [path] = raw.split("#");
        if (path && !asset(path, file)) {
          problems.push({ file, line: link.line, message: `image not found: ${raw}` });
        }
        continue;
      }
      if (external) continue;
      links++;
      const hash = raw.indexOf("#");
      const path = hash === -1 ? raw : raw.slice(0, hash);
      const anchor = hash === -1 ? "" : raw.slice(hash + 1);
      const target =
        path === "" ? file : path.startsWith("/") ? sitePage(path) : resolve(dirname(file), path);
      if (target === null || !existsSync(target)) {
        problems.push({ file, line: link.line, message: `link not found: ${raw}` });
        continue;
      }
      if (anchor === "") continue;
      anchors++;
      if (!target.endsWith(".md")) continue;
      const ids = new Set(page(target).headings.map((h) => anchorKey(h.id)));
      if (!ids.has(anchorKey(anchor))) {
        problems.push({
          file,
          line: link.line,
          message: `anchor not found: ${raw} (${target.replace(`${DOCS}/`, "docs/")} has no such heading)`,
        });
      }
    }
  }

  for (const file of files) {
    const name = file.replace(`${DOCS}/es/`, "").replace(`${DOCS}/`, "");
    const isEs = file.startsWith(join(DOCS, "es"));
    if (isEs) {
      const en = join(DOCS, name);
      if (!existsSync(en) && !SITE_EXCLUDE.has(name)) {
        problems.push({ file, line: 1, message: `parity: docs/es/${name} has no docs/${name}` });
      }
      continue;
    }
    if (SITE_EXCLUDE.has(name) || PARITY_EXEMPT.has(name)) continue;
    const es = join(DOCS, "es", name);
    if (!existsSync(es)) continue;
    const enPage = page(file);
    const esPage = page(es);
    const enLevels = countLevels(enPage);
    const esLevels = countLevels(esPage);
    if (enLevels !== esLevels) {
      problems.push({
        file,
        line: 1,
        message: `parity: headings differ from docs/es/${name} (${enLevels} vs ${esLevels})`,
      });
    }
    if (enPage.fences !== esPage.fences) {
      problems.push({
        file,
        line: 1,
        message: `parity: code fences differ from docs/es/${name} (${enPage.fences} vs ${esPage.fences})`,
      });
    }
  }

  for (const problem of problems) {
    const where = problem.file.replace(`${DOCS}/`, "docs/");
    console.log(`FAIL ${where}:${problem.line} ${problem.message}`);
  }
  if (problems.length > 0) {
    console.log(`docs-check: ${problems.length} problem(s).`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `docs-check: OK — ${files.length} pages, ${links} links (${anchors} anchors), ${images} images.`,
  );
}

export function countLevels(page: Page): string {
  const counts = new Map<number, number>();
  for (const heading of page.headings) {
    counts.set(heading.level, (counts.get(heading.level) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([level, count]) => `h${level}=${count}`)
    .join(" ");
}
const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) main();
