/**
 * Lazy syntax highlighting (spec §10.4): shiki core with the JavaScript regex engine (no WASM),
 * two themes (light colors inline, dark through `--shiki-dark`) and a handful of grammars, each
 * loaded on first use. This module is itself a dynamic import, outside the initial bundle.
 */
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

type LangLoader = () => Promise<unknown>;

const GRAMMARS: Record<string, LangLoader> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
};

const ALIASES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  console: "shellscript",
  py: "python",
  yml: "yaml",
  rs: "rust",
  patch: "diff",
  jsonc: "json",
  json5: "json",
};

export const grammarFor = (lang: string | undefined): string | undefined => {
  const key = (lang ?? "").toLowerCase();
  const name = ALIASES[key] ?? key;
  return name in GRAMMARS ? name : undefined;
};

export interface HighlightedToken {
  content: string;
  color?: string;
  dark?: string;
  fontStyle?: number;
}

let highlighter: Promise<HighlighterCore> | undefined;
const loaded = new Set<string>();

function core(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighter;
}

/** Token lines for `code`, or undefined when the language has no bundled grammar. */
export async function highlight(
  code: string,
  lang: string | undefined,
): Promise<HighlightedToken[][] | undefined> {
  const name = grammarFor(lang);
  if (!name) return undefined;
  const hl = await core();
  if (!loaded.has(name)) {
    const mod = (await GRAMMARS[name]?.()) as {
      default: Parameters<HighlighterCore["loadLanguage"]>[0];
    };
    await hl.loadLanguage(mod.default);
    loaded.add(name);
  }
  const result = hl.codeToTokens(code, {
    lang: name,
    themes: { light: "github-light", dark: "github-dark" },
  });
  return result.tokens.map((line) =>
    line.map((token) => {
      const style = (token.htmlStyle ?? {}) as Record<string, string>;
      return {
        content: token.content,
        ...(style.color ? { color: style.color } : {}),
        ...(style["--shiki-dark"] ? { dark: style["--shiki-dark"] } : {}),
        ...(token.fontStyle ? { fontStyle: token.fontStyle } : {}),
      };
    }),
  );
}
