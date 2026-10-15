/**
 * Scope globs against edited paths (specs/011 3.4, D5). Pure: no filesystem, no clock.
 *
 * Paths are workspace-relative with `/` separators. A scope entry covers a path when its glob
 * matches the path or any ancestor directory of it, so `src` and `src/**` both cover
 * `src/a/b.ts`. No scope (absent or empty) means the whole workspace. Supported glob syntax:
 * `*`, `?`, `**`, `[abc]`/`[a-z]`/`[!x]` and `{a,b}`; anything else is literal.
 */

const MAX_PATTERN = 256;
const MAX_EXPANSIONS = 32;

/** Forward slashes, no leading `./`, no trailing `/`. */
export function normalizeScopePath(path: string): string {
  let out = path.replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  out = out.replace(/\/{2,}/g, "/");
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** Expands `{a,b}` groups (innermost first) into plain patterns, bounded. */
function expandBraces(pattern: string): string[] {
  const open = pattern.search(/\{[^{}]*\}/);
  if (open < 0) return [pattern];
  const close = pattern.indexOf("}", open);
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const out: string[] = [];
  for (const option of pattern.slice(open + 1, close).split(",")) {
    for (const rest of expandBraces(head + option + tail)) {
      out.push(rest);
      if (out.length >= MAX_EXPANSIONS) return out;
    }
  }
  return out;
}

const escapeChar = (c: string): string => c.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");

/** Compiles one brace-free glob to an anchored regular expression. */
function compile(glob: string): RegExp {
  let g = glob.replace(/(?:\*\*\/)+/g, "**/").replace(/\*{3,}/g, "**");
  // A trailing `/**` also matches the directory itself.
  const tail = g.endsWith("/**") ? "(?:/.*)?" : "";
  if (tail) g = g.slice(0, -3);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g.charAt(i);
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        // `**/` also matches nothing.
        if (slash) {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const close = g.indexOf("]", i + 2);
      if (close < 0) re += "\\[";
      else {
        const body = g.slice(i + 1, close);
        const negate = body.startsWith("!") || body.startsWith("^");
        const set = (negate ? body.slice(1) : body).replace(/[\\\]^]/g, "\\$&");
        re += `[${negate ? "^/" : ""}${set}]`;
        i = close;
      }
    } else re += escapeChar(c);
  }
  return new RegExp(`^${re}${tail}$`);
}

const cache = new Map<string, RegExp[] | null>();

function compiled(entry: string): RegExp[] | null {
  const known = cache.get(entry);
  if (known !== undefined) return known;
  let value: RegExp[] | null;
  try {
    value = expandBraces(normalizeScopePath(entry)).map(compile);
  } catch {
    value = null; // unusable entry: callers fail safe and treat it as matching everything
  }
  if (cache.size >= 512) cache.clear();
  cache.set(entry, value);
  return value;
}

/** Whether any scope entry covers `path`. Absent or empty scope: the whole workspace. */
export function scopeMatches(scope: readonly string[] | undefined, path: string): boolean {
  if (!scope || scope.length === 0) return true;
  const target = normalizeScopePath(path);
  const segments = target.split("/");
  const prefixes = segments.map((_, i) => segments.slice(0, i + 1).join("/"));
  for (const entry of scope) {
    if (entry.length > MAX_PATTERN) return true;
    const patterns = compiled(entry);
    if (patterns === null) return true;
    for (const pattern of patterns) {
      if (prefixes.some((p) => pattern.test(p))) return true;
    }
  }
  return false;
}
