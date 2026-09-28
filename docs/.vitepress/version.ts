/**
 * Build-time version for the docs site.
 *
 * Docs pages must never hardcode the Alisio version: it goes stale on every release.
 * Instead they use the `__ALISIO_VERSION__` token. `docs/.vitepress/config.ts` registers
 * a markdown-it core rule that replaces the token with the real version read from
 * `packages/cli/package.json`, so the built site always shows the current release.
 *
 * Usage in markdown:
 * - In prose (paragraphs, headings, tables), the token works bare (`__ALISIO_VERSION__`) or
 *   wrapped in backticks; substitution happens before inline parsing, so the underscores never
 *   reach the emphasis parser.
 * - Inside fenced code blocks, write the token as-is; it is substituted in the fence content
 *   too (e.g. `` "@alisio/sdk": "^__ALISIO_VERSION__" ``).
 *
 * `docs:check` validates the markdown **sources** (links, anchors, EN/ES parity), so it runs
 * on un-substituted text; the substitution is covered by `tests/docs-version.test.ts` and by
 * grepping the built HTML after `pnpm docs:build`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLI_PACKAGE_PATH = fileURLToPath(new URL("../../packages/cli/package.json", import.meta.url));

/** The placeholder docs pages use instead of a hardcoded version. */
export const VERSION_TOKEN = "__ALISIO_VERSION__";

/** Current version of the CLI package, read from packages/cli/package.json at build time. */
export const ALISIO_VERSION: string = (
  JSON.parse(readFileSync(CLI_PACKAGE_PATH, "utf8")) as {
    version: string;
  }
).version;

/** Replace every occurrence of the version token in a string. */
export function substituteVersion(text: string, version: string = ALISIO_VERSION): string {
  return text.split(VERSION_TOKEN).join(version);
}

/** Minimal shape of the markdown-it tokens this rule touches. */
export type VersionToken = {
  type: string;
  content?: string;
};

/**
 * Walk markdown-it tokens and replace the token in the raw content of inline, fenced and
 * indented-code tokens. Registered as a core rule *before* inline parsing (see
 * `docs/.vitepress/config.ts`), so the version is substituted in the raw markdown first and
 * every downstream consumer — inline children, heading slugs and VitePress's header anchors —
 * sees the real version. This also means the token is safe bare in prose: the replaced text
 * never reaches the emphasis parser.
 */
export function substituteTokens(tokens: VersionToken[]): VersionToken[] {
  for (const token of tokens) {
    if (
      (token.type === "inline" || token.type === "fence" || token.type === "code_block") &&
      typeof token.content === "string" &&
      token.content.includes(VERSION_TOKEN)
    ) {
      token.content = substituteVersion(token.content);
    }
  }
  return tokens;
}
