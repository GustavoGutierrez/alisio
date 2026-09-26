/**
 * Prompt templates: Markdown files with YAML frontmatter that expand into a user turn.
 *
 * Syntax (same convention as Claude Code, opencode and pi): `$ARGUMENTS` is the whole argument
 * string, `$1`..`$9` are shell-like positional arguments (single digit; missing ones are empty).
 * When the body references neither, non-empty arguments are appended after a blank line.
 *
 * Precedence (documented, later wins): builtin < plugin < user < project. Plugins at the same
 * level resolve by plugin id, then registration order, and report `prompt_conflict`.
 */
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { readText } from "../runtime/fs.ts";

export type PromptSourceKind = "builtin" | "plugin" | "user" | "project";
export type PromptRequirement = "write" | "process";
export interface PromptTemplate {
  name: string;
  description: string;
  argumentHint?: string;
  requires: PromptRequirement[];
  body: string;
  source: PromptSourceKind;
  /** File path, or `builtin`. */
  origin: string;
}
export interface PromptSource {
  kind: PromptSourceKind;
  /** `builtin`, the plugin id, `user` or `project`. */
  id: string;
  dir?: string;
  entries?: Array<{ name: string; text: string }>;
}
export type PromptDiagnostic =
  | { type: "prompt_invalid"; origin: string; error: string }
  | { type: "prompt_override"; name: string; winner: string; overridden: string[] }
  | { type: "prompt_conflict"; name: string; winner: string; losers: string[] }
  | { type: "prompt_shadowed"; name: string; origin: string };

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_BYTES = 64_000;
const frontmatter = z
  .object({
    description: z.string().trim().min(1).max(300),
    "argument-hint": z.string().trim().max(120).optional(),
    requires: z
      .array(z.enum(["write", "process"]))
      .max(2)
      .optional(),
  })
  .strict();

export function parsePromptTemplate(
  text: string,
  meta: { name: string; source: PromptSourceKind; origin: string },
): PromptTemplate {
  if (!NAME.test(meta.name))
    throw new Error(`Invalid template name "${meta.name}" (lowercase letters, digits and dashes)`);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new Error("Missing YAML frontmatter (--- description: ... ---)");
  const parsed = frontmatter.safeParse(parse(match[1] ?? "", { maxAliasCount: 20 }) ?? {});
  if (!parsed.success)
    throw new Error(
      parsed.error.issues
        .map((i) => `${i.path.join(".") || "frontmatter"}: ${i.message}`)
        .join("; ") +
        (parsed.error.issues.some((i) => i.code === "unrecognized_keys")
          ? ` (${parsed.error.issues.flatMap((i) => ("keys" in i ? (i.keys as string[]) : [])).join(", ")})`
          : ""),
    );
  const body = (match[2] ?? "").trim();
  if (!body) throw new Error("Template body is empty");
  return {
    name: meta.name,
    description: parsed.data.description,
    ...(parsed.data["argument-hint"] ? { argumentHint: parsed.data["argument-hint"] } : {}),
    requires: [...new Set(parsed.data.requires ?? [])],
    body,
    source: meta.source,
    origin: meta.origin,
  };
}

/** Shell-like split: whitespace separates, single or double quotes group. */
export function splitArguments(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of args.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}
export function renderPromptTemplate(body: string, args: string): string {
  const trimmed = args.trim();
  const positional = splitArguments(trimmed);
  const references = /\$ARGUMENTS|\$[1-9]/.test(body);
  const rendered = body
    .replace(/\$ARGUMENTS/g, () => trimmed)
    .replace(/\$([1-9])/g, (_m, n: string) => positional[Number(n) - 1] ?? "");
  return !references && trimmed ? `${rendered}\n\n${trimmed}` : rendered;
}

const RANK: Record<PromptSourceKind, number> = { builtin: 0, plugin: 1, user: 2, project: 3 };
const label = (s: PromptSource) => (s.kind === "plugin" ? `plugin:${s.id}` : s.kind);

async function read(source: PromptSource, diagnostics: PromptDiagnostic[]) {
  const found: PromptTemplate[] = [];
  const add = (name: string, text: string, origin: string) => {
    try {
      found.push(parsePromptTemplate(text, { name, source: source.kind, origin }));
    } catch (error) {
      diagnostics.push({
        type: "prompt_invalid",
        origin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  for (const entry of source.entries ?? []) add(entry.name, entry.text, source.id);
  if (source.dir) {
    let files: string[] = [];
    try {
      files = (await readdir(source.dir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => e.name)
        .sort();
    } catch (e) {
      if (!["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
    }
    for (const name of files) {
      const path = join(source.dir, name);
      try {
        add(basename(name, ".md"), await readText(path, MAX_BYTES), path);
      } catch (error) {
        diagnostics.push({ type: "prompt_invalid", origin: path, error: String(error) });
      }
    }
  }
  return found;
}

export async function loadPromptTemplates(
  sources: PromptSource[],
  options: { reserved?: Iterable<string> } = {},
): Promise<{ templates: Map<string, PromptTemplate>; diagnostics: PromptDiagnostic[] }> {
  const diagnostics: PromptDiagnostic[] = [];
  const reserved = new Set(options.reserved ?? []);
  const candidates: Array<{ template: PromptTemplate; source: PromptSource; order: number }> = [];
  let order = 0;
  for (const source of sources)
    for (const template of await read(source, diagnostics)) {
      if (reserved.has(template.name)) {
        diagnostics.push({ type: "prompt_shadowed", name: template.name, origin: template.origin });
        continue;
      }
      candidates.push({ template, source, order: order++ });
    }
  const templates = new Map<string, PromptTemplate>();
  for (const name of [...new Set(candidates.map((c) => c.template.name))].sort()) {
    const ranked = candidates
      .filter((c) => c.template.name === name)
      .sort(
        (a, b) =>
          RANK[b.source.kind] - RANK[a.source.kind] ||
          (a.source.id < b.source.id ? -1 : a.source.id > b.source.id ? 1 : 0) ||
          a.order - b.order,
      );
    const [winner, ...rest] = ranked;
    if (!winner) continue;
    templates.set(name, winner.template);
    const peers = rest.filter((c) => c.source.kind === winner.source.kind);
    if (peers.length)
      diagnostics.push({
        type: "prompt_conflict",
        name,
        winner: label(winner.source),
        losers: peers.map((c) => label(c.source)),
      });
    const lower = rest.filter((c) => c.source.kind !== winner.source.kind);
    if (lower.length)
      diagnostics.push({
        type: "prompt_override",
        name,
        winner: label(winner.source),
        overridden: [...new Set(lower.map((c) => label(c.source)))].sort(
          (a, b) =>
            RANK[a.split(":")[0] as PromptSourceKind] - RANK[b.split(":")[0] as PromptSourceKind],
        ),
      });
  }
  return { templates, diagnostics };
}

/** Ordered sources; project prompts only when the project is trusted. */
export function promptSources(options: {
  builtin?: Array<{ name: string; text: string }>;
  plugins: Array<{ plugin: string; dir: string }>;
  userDir: string;
  projectDir: string;
  trusted: boolean;
}): PromptSource[] {
  return [
    { kind: "builtin", id: "builtin", entries: options.builtin ?? [] },
    ...options.plugins.map((p) => ({ kind: "plugin" as const, id: p.plugin, dir: p.dir })),
    { kind: "user", id: "user", dir: options.userDir },
    ...(options.trusted
      ? [{ kind: "project" as const, id: "project", dir: options.projectDir }]
      : []),
  ];
}

/** `/name args` → rendered template, or undefined when `name` is not a template. */
export function expandSlashPrompt(
  input: string,
  templates: ReadonlyMap<string, PromptTemplate>,
):
  | { name: string; args: string; display: string; text: string; template: PromptTemplate }
  | undefined {
  const match = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(input.trim());
  const template = match?.[1] ? templates.get(match[1]) : undefined;
  if (!match?.[1] || !template) return undefined;
  const args = (match[2] ?? "").trim();
  return {
    name: match[1],
    args,
    display: `/${match[1]}${args ? ` ${args}` : ""}`,
    text: renderPromptTemplate(template.body, args),
    template,
  };
}
