/**
 * Web UI size budgets (spec §10.7): initial JS ≤ 90 KB gzip and initial CSS ≤ 20 KB gzip.
 * "Initial" means what `index.html` loads before any user action: its module script, the chunks
 * it preloads or statically imports, and its stylesheets. Lazy chunks (syntax highlighting,
 * heavier renderers) are reported for information only.
 * Usage: node --experimental-strip-types scripts/web-size.ts [distDir]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const BUDGET = { js: 90 * 1024, css: 20 * 1024 };
const dist = resolve(process.argv[2] ?? "packages/web/dist");
if (!existsSync(join(dist, "index.html"))) {
  console.error(`web:size: ${dist}/index.html not found; run \`pnpm build\` first.`);
  process.exit(1);
}
const html = readFileSync(join(dist, "index.html"), "utf8");
const gz = (path: string) => gzipSync(readFileSync(join(dist, path)), { level: 9 }).length;
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

/** Chunks reachable from an entry through static `import … from "./x.js"` statements. */
function staticGraph(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const code = readFileSync(join(dist, entry), "utf8");
  for (const match of code.matchAll(
    /(?:^|[;\s}])import\s*(?:[\w*{}\s,$]+from\s*)?["']\.\/([^"']+\.js)["']/g,
  ))
    staticGraph(`assets/${match[1]}`, seen);
  return seen;
}

const refs = (pattern: RegExp) =>
  [...html.matchAll(pattern)].map((m) => (m[1] ?? "").replace(/^\//, ""));
const entries = refs(/<script[^>]+type="module"[^>]+src="([^"]+)"/g);
const preloads = refs(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g);
const styles = refs(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g);
const initialJs = new Set<string>();
for (const file of [...entries, ...preloads]) for (const f of staticGraph(file)) initialJs.add(f);
const jsTotal = [...initialJs].reduce((sum, f) => sum + gz(f), 0);
const cssTotal = styles.reduce((sum, f) => sum + gz(f), 0);
const lazy = readdirSync(join(dist, "assets"))
  .filter((f) => f.endsWith(".js") && !initialJs.has(`assets/${f}`))
  .map((f) => ({ f, size: gz(`assets/${f}`) }))
  .sort((a, b) => b.size - a.size);

console.log("Initial (gzip):");
for (const f of initialJs) console.log(`  ${f.padEnd(40)} ${kb(gz(f)).padStart(9)}`);
for (const f of styles) console.log(`  ${f.padEnd(40)} ${kb(gz(f)).padStart(9)}`);
console.log(`  JS  ${kb(jsTotal)} / ${kb(BUDGET.js)}    CSS ${kb(cssTotal)} / ${kb(BUDGET.css)}`);
console.log(
  `Lazy chunks (gzip, informational): ${lazy.length}, ${kb(lazy.reduce((s, l) => s + l.size, 0))} total`,
);
for (const { f, size } of lazy.slice(0, 8))
  console.log(`  ${f.padEnd(40)} ${kb(size).padStart(9)}`);
const failures = [
  ...(jsTotal > BUDGET.js ? [`initial JS ${kb(jsTotal)} exceeds ${kb(BUDGET.js)}`] : []),
  ...(cssTotal > BUDGET.css ? [`initial CSS ${kb(cssTotal)} exceeds ${kb(BUDGET.css)}`] : []),
];
if (failures.length) {
  console.error(`web:size failed: ${failures.join("; ")}`);
  process.exit(1);
}
