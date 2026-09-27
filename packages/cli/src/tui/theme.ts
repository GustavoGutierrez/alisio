import type {
  DefaultTextStyle,
  EditorTheme,
  ImageTheme,
  MarkdownTheme,
  SelectListTheme,
} from "@earendil-works/pi-tui";
import type { Level } from "./state.ts";

const enabled = !process.env.NO_COLOR;
const sgr =
  (open: number | string, close: number) =>
  (text: string): string =>
    enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text;

export const style = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  italic: sgr(3, 23),
  underline: sgr(4, 24),
  strike: sgr(9, 29),
  red: sgr(31, 39),
  green: sgr(32, 39),
  yellow: sgr(33, 39),
  blue: sgr(34, 39),
  magenta: sgr(35, 39),
  cyan: sgr(36, 39),
  gray: sgr(90, 39),
  brightCyan: sgr(96, 39),
  userBg: sgr("48;5;236", 49),
};
export const levelColor = (level: Level) =>
  level === "ok" ? style.green : level === "warn" ? style.yellow : style.red;

/**
 * Dependency-free, line-based syntax highlighting for code blocks in responses.
 *
 * The tokenizer is deliberately approximate: it walks each line once and colors keywords, strings,
 * comments, numbers, function calls and property keys for the common response languages. It never
 * tries to be a real parser, never throws on malformed input, and strips ANSI/control characters
 * from the source first (a model response must never be able to inject terminal control codes).
 */
export type TokenStyle =
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "function"
  | "property"
  | "plain";
export interface CodeToken {
  text: string;
  style: TokenStyle;
}

const TS_KEYWORDS = new Set([
  "abstract",
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "constructor",
  "continue",
  "debugger",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "is",
  "keyof",
  "let",
  "namespace",
  "new",
  "never",
  "null",
  "of",
  "override",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "satisfies",
  "set",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "unknown",
  "using",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);
const PYTHON_KEYWORDS = new Set([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "case",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "False",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "match",
  "None",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "True",
  "try",
  "while",
  "with",
  "yield",
]);
const SHELL_KEYWORDS = new Set([
  "alias",
  "break",
  "case",
  "continue",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "exit",
  "export",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "local",
  "readonly",
  "return",
  "select",
  "set",
  "shift",
  "source",
  "then",
  "time",
  "true",
  "false",
  "until",
  "while",
]);
const CSS_KEYWORDS = new Set([
  "@charset",
  "@font-face",
  "@import",
  "@keyframes",
  "@layer",
  "@media",
  "@namespace",
  "@page",
  "@supports",
  "important",
]);
/** Standalone words highlighted in HTML (tags themselves are matched structurally). */
const HTML_WORDS = new Set<string>([]);

/** Rules used for TS/JS and as the fallback for unknown language tags. */
const TS_RULES: LangRules = {
  keywords: TS_KEYWORDS,
  lineComment: "//",
  blockComment: ["/*", "*/"],
  strings: ['"', "'", "`"],
};

interface LangRules {
  keywords: ReadonlySet<string>;
  /** Line comment opener (e.g. "//" or "#"). */
  lineComment?: string;
  /** Block comment delimiters, e.g. `/* ... *` + `/` for C-style or `<!-- ... -->`. */
  blockComment?: readonly [string, string];
  /** Quote delimiters for strings. */
  strings: readonly string[];
  /** Multi-line string openers (Python docstrings). */
  triple?: readonly string[];
  /** Bash `$var` / `${var}` / `$1` expansions. */
  dollarVars?: boolean;
  /** A string followed by `:` is a property key (JSON). */
  keyString?: boolean;
  /** A word followed by `:` is a property key (YAML, CSS). */
  colonKey?: boolean;
  /** A word followed by `=` is an attribute/assignment (HTML, Bash). */
  eqKey?: boolean;
  /** A word after `def`/`class` is a function name (Python). */
  defNames?: boolean;
  /** `@decorator` names (Python). */
  decorators?: boolean;
  /** String prefixes like `f"..."` / `r"..."` / `b"..."` (Python). */
  prefixedStrings?: boolean;
  /** HTML tags (`<div`) and attributes (`class=...`). */
  html?: boolean;
  /** Markdown headings (`# Title`). */
  headings?: boolean;
  /** Hex colors `#fff` (CSS, HTML). */
  hexColors?: boolean;
  /** `@media`-style at-rules. */
  atWord?: boolean;
}

const LANG_RULES: Record<string, LangRules> = {
  ts: TS_RULES,
  js: TS_RULES,
  json: {
    keywords: new Set(["true", "false", "null"]),
    lineComment: "//",
    blockComment: ["/*", "*/"],
    strings: ['"', "'"],
    keyString: true,
  },
  python: {
    keywords: PYTHON_KEYWORDS,
    lineComment: "#",
    strings: ['"', "'"],
    triple: ['"""', "'''"],
    defNames: true,
    decorators: true,
    prefixedStrings: true,
  },
  bash: {
    keywords: SHELL_KEYWORDS,
    lineComment: "#",
    strings: ['"', "'"],
    dollarVars: true,
    eqKey: true,
  },
  sh: {
    keywords: SHELL_KEYWORDS,
    lineComment: "#",
    strings: ['"', "'"],
    dollarVars: true,
    eqKey: true,
  },
  yaml: {
    keywords: new Set(["true", "false", "yes", "no", "on", "off", "null"]),
    lineComment: "#",
    strings: ['"', "'"],
    colonKey: true,
  },
  css: {
    keywords: CSS_KEYWORDS,
    blockComment: ["/*", "*/"],
    strings: ['"', "'"],
    colonKey: true,
    hexColors: true,
    atWord: true,
  },
  html: {
    keywords: HTML_WORDS,
    blockComment: ["<!--", "-->"],
    strings: ['"', "'"],
    html: true,
    eqKey: true,
    hexColors: true,
  },
  md: { keywords: new Set<string>(), strings: ["`"], headings: true },
};

const LANG_ALIASES: Record<string, string> = {
  typescript: "ts",
  tsx: "ts",
  javascript: "js",
  jsx: "js",
  node: "js",
  jsonc: "json",
  json5: "json",
  shell: "bash",
  zsh: "bash",
  python3: "python",
  py: "python",
  yml: "yaml",
  markdown: "md",
};

/** Unknown or missing language tags fall back to TypeScript rules (closest to plain code). */
const rulesFor = (lang?: string): LangRules => {
  const base =
    (lang ?? "")
      .trim()
      .toLowerCase()
      .split(/[\s.]+/)[0] ?? "";
  return LANG_RULES[LANG_ALIASES[base] ?? base] ?? TS_RULES;
};

/** Strips ANSI escapes, OSC sequences and control characters; normalizes tabs. */
export function sanitizeCode(code: string): string {
  return code
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][0-9A-Za-z]/g, "")
    .replace(/\x1b/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000D\u000E-\u001F\u007F]/g, "")
    .replace(/\t/g, "  ");
}

export interface ScanState {
  /** Closing delimiter of a block comment started on a previous line. */
  inComment?: string;
  /** Delimiter of a multi-line string started on a previous line. */
  inString?: string;
}

function scanLine(line: string, rules: LangRules, state: ScanState): CodeToken[] {
  const out: CodeToken[] = [];
  const len = line.length;
  const push = (text: string, style: TokenStyle) => {
    if (text) out.push({ text, style });
  };
  /** Finds the unescaped closing delimiter of a string starting at `from`. */
  const scanString = (from: number, delimiter: string): { end: number; closed: boolean } => {
    let j = from;
    while (j < len) {
      if (line[j] === "\\") {
        j += 2;
        continue;
      }
      if (line.startsWith(delimiter, j)) return { end: j + delimiter.length, closed: true };
      j++;
    }
    return { end: len, closed: false };
  };
  let i = 0;

  // Continue a multi-line string opened on a previous line.
  if (state.inString) {
    const end = line.indexOf(state.inString);
    if (end < 0) {
      push(line, "string");
      return out;
    }
    push(line.slice(0, end + state.inString.length), "string");
    i = end + state.inString.length;
    state.inString = undefined;
  }
  // Continue a block comment opened on a previous line.
  if (state.inComment) {
    const end = line.indexOf(state.inComment);
    if (end < 0) {
      push(line, "comment");
      return out;
    }
    push(line.slice(0, end + state.inComment.length), "comment");
    i = end + state.inComment.length;
    state.inComment = undefined;
  }

  while (i < len) {
    const rem = line.slice(i);
    // Markdown headings: color the `#` marker run (approximate; only at the start of a line).
    if (rules.headings && /^#{1,6}[ \t]/.test(rem)) {
      const m = /^#{1,6}/.exec(rem);
      push(m?.[0] ?? "", "keyword");
      push(rem.slice(m?.[0].length ?? 0), "plain");
      break;
    }
    const ws = /^ +/.exec(rem);
    if (ws) {
      push(ws[0], "plain");
      i += ws[0].length;
      continue;
    }
    if (rules.triple) {
      const delim = rules.triple.find((d) => rem.startsWith(d));
      if (delim) {
        const end = line.indexOf(delim, i + delim.length);
        if (end >= 0) {
          push(line.slice(i, end + delim.length), "string");
          i = end + delim.length;
        } else {
          push(line.slice(i), "string");
          state.inString = delim;
          i = len;
        }
        continue;
      }
    }
    // Escape-aware quoted strings, with optional Python-style prefixes (`f"..."`, `r"..."`).
    const anyQuote = ():
      | { quote: string; from: number; closed: boolean; end: number }
      | undefined => {
      for (const d of rules.strings) {
        if (rem.startsWith(d)) {
          const scan = scanString(i + d.length, d);
          return { quote: d, from: i, closed: scan.closed, end: scan.end };
        }
      }
      if (rules.prefixedStrings) {
        const pm = /^(?:[fF][rR]?|[rR][fF]?|[bB]|[uU])(["'])/.exec(rem);
        if (pm?.[1] && rules.strings.includes(pm[1])) {
          const scan = scanString(i + pm[0].length, pm[1]);
          return { quote: pm[1], from: i, closed: scan.closed, end: scan.end };
        }
      }
      return undefined;
    };
    const str = anyQuote();
    if (str) {
      const key = rules.keyString && /^\s*:/.test(line.slice(str.end));
      push(line.slice(str.from, str.end), key ? "property" : "string");
      i = str.end;
      if (!str.closed && str.quote === "`") state.inString = str.quote;
      continue;
    }
    if (rules.lineComment && rem.startsWith(rules.lineComment)) {
      push(rem, "comment");
      break;
    }
    if (rules.blockComment && rem.startsWith(rules.blockComment[0])) {
      const end = line.indexOf(rules.blockComment[1], i + rules.blockComment[0].length);
      if (end >= 0) {
        push(line.slice(i, end + rules.blockComment[1].length), "comment");
        i = end + rules.blockComment[1].length;
      } else {
        push(line.slice(i), "comment");
        state.inComment = rules.blockComment[1];
        i = len;
      }
      continue;
    }
    if (rules.dollarVars && rem.startsWith("$")) {
      const m = /^\$(?:\{[^}]*\}|\d+|[A-Za-z_][\w]*)/.exec(rem);
      if (m) {
        push(m[0], "number");
        i += m[0].length;
        continue;
      }
    }
    if (rules.decorators && rem.startsWith("@")) {
      const m = /^@[A-Za-z_][\w]*/.exec(rem);
      if (m) {
        push("@", "plain");
        push(m[0].slice(1), "function");
        i += m[0].length;
        continue;
      }
    }
    if (rules.atWord && rem.startsWith("@")) {
      const m = /^@[A-Za-z-][\w-]*/.exec(rem);
      if (m) {
        push(m[0], "keyword");
        i += m[0].length;
        continue;
      }
    }
    if (rules.html) {
      const tag = /^<\/?[A-Za-z][\w-]*/.exec(rem);
      if (tag && tag[0].length > 1) {
        push(tag[0], "keyword");
        i += tag[0].length;
        continue;
      }
    }
    if (rules.hexColors && rem.startsWith("#")) {
      const m = /^#[0-9a-fA-F]{3,8}\b/.exec(rem);
      if (m) {
        push(m[0], "number");
        i += m[0].length;
        continue;
      }
    }
    const num = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rem);
    if (num) {
      push(num[0], "number");
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(rem);
    if (word) {
      const w = word[0];
      const rest = line.slice(i + w.length);
      const prevWord = out.at(-1)?.text;
      if (rules.keywords.has(w)) push(w, "keyword");
      else if (rules.defNames && (prevWord === "def" || prevWord === "class")) push(w, "function");
      else if (/^\(/.test(rest)) push(w, "function");
      else if (rules.eqKey && /^=/.test(rest)) push(w, "property");
      else if (rules.colonKey && /^:/.test(rest)) push(w, "property");
      else push(w, "plain");
      i += w.length;
      continue;
    }
    push(line[i] ?? "", "plain");
    i++;
  }
  return out;
}

/** Tokenizes code into styled segments, maintaining multi-line string/comment state. */
export function tokenizeCode(code: string, lang?: string): CodeToken[][] {
  const rules = rulesFor(lang);
  const state: ScanState = {};
  return sanitizeCode(code)
    .split("\n")
    .map((line) => scanLine(line, rules, state));
}

const TOKEN_PAINT: Record<TokenStyle, (text: string) => string> = {
  keyword: (t) => style.bold(style.magenta(t)),
  string: (t) => style.green(t),
  comment: (t) => style.gray(style.italic(t)),
  number: (t) => style.yellow(t),
  function: (t) => style.cyan(t),
  property: (t) => style.brightCyan(t),
  plain: (t) => t,
};

/**
 * Per-line highlighting for markdown code blocks (pi-tui `MarkdownTheme.highlightCode`).
 * Returns one styled (or plain, under NO_COLOR) line per source line; never emits ANSI for
 * bytes that came from the input.
 */
export function highlightCode(code: string, lang?: string): string[] {
  const lines = tokenizeCode(code, lang);
  if (process.env.NO_COLOR !== undefined)
    return lines.map((tokens) => tokens.map((t) => t.text).join(""));
  return lines.map((tokens) =>
    tokens.map((t) => (t.style === "plain" ? t.text : TOKEN_PAINT[t.style](t.text))).join(""),
  );
}

/**
 * Normalizes table separator rows so models' sloppy ASCII art still renders as aligned tables:
 * em/en/box dashes become plain `-` runs (marked's table tokenizer only accepts `-`), while
 * alignment colons are preserved. Anything that is not an obvious separator row, including
 * fenced or indented code, is left untouched. A bare `---` (horizontal rule / setext) has no
 * `|` and is never touched.
 */
export function normalizeTableSeparators(markdown: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0] ?? "";
      if (!fence) fence = marker;
      else if (fenceMatch[1]?.startsWith(fence)) fence = undefined;
      out.push(line);
      continue;
    }
    if (!fence && isTableSeparator(line)) {
      out.push(
        line.replace(
          /(:)?[-—–─]+(:)?/g,
          (_m, left?: string, right?: string) => `${left ?? ""}---${right ?? ""}`,
        ),
      );
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function isTableSeparator(line: string): boolean {
  if (!line.includes("|") || /^ {4}/.test(line)) return false;
  const cells = line.split("|");
  let dashes = 0;
  for (const cell of cells) {
    const c = cell.trim();
    if (c === "") continue;
    if (!/^:?[-—–─]+:?$/.test(c)) return false;
    dashes++;
  }
  return dashes > 0;
}

/** Pre-parse hook for the Markdown component: normalizes table separators before marked parses. */
export const markdownTransform = (markdown: string, _availableWidth: number): string =>
  normalizeTableSeparators(markdown);

/** Subtle base tone for response body text; inline styles override it. */
export const markdownDefaultTextStyle: DefaultTextStyle = { color: (t) => style.gray(t) };

export const markdownTheme: MarkdownTheme = {
  heading: (t) => style.bold(style.brightCyan(t)),
  link: (t) => style.underline(style.blue(t)),
  linkUrl: (t) => style.dim(t),
  code: (t) => style.yellow(t),
  codeBlock: (t) => style.green(t),
  codeBlockBorder: (t) => style.dim(t),
  quote: (t) => style.italic(style.gray(t)),
  quoteBorder: (t) => style.dim(t),
  hr: (t) => style.dim(t),
  listBullet: (t) => style.cyan(t),
  bold: (t) => style.bold(t),
  italic: (t) => style.italic(t),
  strikethrough: (t) => style.strike(t),
  underline: (t) => style.underline(t),
  highlightCode,
  codeBlockIndent: "  ",
};
export const selectListTheme: SelectListTheme = {
  selectedPrefix: (t) => style.cyan(t),
  selectedText: (t) => style.bold(style.cyan(t)),
  description: (t) => style.gray(t),
  scrollInfo: (t) => style.dim(t),
  noMatch: (t) => style.yellow(t),
};
export const editorTheme: EditorTheme = {
  borderColor: (t) => style.gray(t),
  selectList: selectListTheme,
};
export const imageTheme: ImageTheme = {
  fallbackColor: (t) => style.gray(t),
};
