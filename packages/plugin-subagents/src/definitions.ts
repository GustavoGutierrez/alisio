/**
 * Agent definitions: Markdown files with YAML frontmatter (Alisio format), plus compatible
 * readers for Claude Code (`.claude/agents`) and opencode (`.opencode/agent(s)`) files.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "yaml";

export type Level = "allow" | "ask" | "deny";
export interface AgentDefinition {
  name: string;
  description: string;
  /** System prompt (the Markdown body). */
  prompt: string;
  /** Allowlist; `*` means every tool the parent has (including `task`). */
  tools?: string[];
  disallowedTools?: string[];
  /** Model id; undefined inherits the parent's current model. */
  model?: string;
  mode: "subagent" | "primary" | "all";
  maxTurns?: number;
  color?: string;
  permission?: { write?: Level; process?: Level };
  readOnly?: boolean;
  hidden: boolean;
  background: boolean;
  skills?: string[];
  /** builtin | cli | project | convention | compat | user | plugin:<id> */
  source: string;
  path?: string;
}
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KNOWN = new Set([
  "name",
  "description",
  "tools",
  "disallowedTools",
  "model",
  "mode",
  "maxTurns",
  "steps",
  "maxSteps",
  "color",
  "permission",
  "hidden",
  "background",
  "skills",
  "readOnly",
  // Compat keys accepted silently.
  "temperature",
  "top_p",
  "disable",
]);
/** Claude Code tool names → Alisio tools. */
const TOOL_ALIASES: Record<string, string[]> = {
  read: ["read_file"],
  grep: ["search_text"],
  glob: ["list_files"],
  ls: ["list_files"],
  edit: ["edit_file"],
  multiedit: ["edit_file"],
  write: ["write_file"],
  bash: ["shell", "run_process"],
  task: ["task"],
};
const CLAUDE_MODEL_ALIASES = new Set(["sonnet", "opus", "haiku"]);
const list = (value: unknown): string[] | undefined => {
  if (Array.isArray(value))
    return value
      .map(String)
      .map((s) => s.trim())
      .filter(Boolean);
  if (typeof value === "string")
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return undefined;
};
const mapTools = (names: string[]) => [
  ...new Set(names.flatMap((n) => TOOL_ALIASES[n.toLowerCase()] ?? [n])),
];
const level = (value: unknown): Level | undefined =>
  value === "allow" || value === "ask" || value === "deny"
    ? value
    : value && typeof value === "object"
      ? "ask" // pattern maps (opencode) narrow to per-call approval
      : undefined;

export function parseAgentDefinition(
  text: string,
  meta: { source: string; path?: string },
): { definition?: AgentDefinition; warnings: string[] } {
  const warnings: string[] = [];
  const where = meta.path ?? meta.source;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) return { warnings: [`${where}: missing YAML frontmatter`] };
  let front: Record<string, unknown>;
  try {
    front = (parse(match[1] ?? "", { maxAliasCount: 20 }) ?? {}) as Record<string, unknown>;
  } catch (error) {
    return { warnings: [`${where}: invalid YAML (${String(error)})`] };
  }
  const fileName = meta.path ? basename(meta.path, ".md") : undefined;
  const name = String(front.name ?? fileName ?? "");
  if (!NAME.test(name) || name.length > 64)
    return {
      warnings: [`${where}: invalid agent name "${name}" (lowercase letters, digits, hyphens)`],
    };
  const description = typeof front.description === "string" ? front.description.trim() : "";
  if (!description) return { warnings: [`${where}: description is required`] };
  for (const key of Object.keys(front))
    if (!KNOWN.has(key)) warnings.push(`${where}: unknown key "${key}" ignored`);
  const definition: AgentDefinition = {
    name,
    description,
    prompt: (match[2] ?? "").trim(),
    mode: front.mode === "primary" || front.mode === "all" ? front.mode : "subagent",
    hidden: front.hidden === true,
    background: front.background === true,
    source: meta.source,
    ...(meta.path ? { path: meta.path } : {}),
  };
  const tools = front.tools;
  if (tools && typeof tools === "object" && !Array.isArray(tools)) {
    // opencode: { tool: false } disables a tool.
    const off = Object.entries(tools as Record<string, unknown>)
      .filter(([, v]) => v === false)
      .map(([k]) => k);
    if (off.length) definition.disallowedTools = mapTools(off);
  } else {
    const allow = list(tools);
    if (allow) definition.tools = mapTools(allow);
  }
  const deny = list(front.disallowedTools);
  if (deny)
    definition.disallowedTools = [
      ...new Set([...(definition.disallowedTools ?? []), ...mapTools(deny)]),
    ];
  if (typeof front.model === "string" && front.model !== "inherit") {
    if (CLAUDE_MODEL_ALIASES.has(front.model))
      warnings.push(
        `${where}: model alias "${front.model}" is Claude-specific; inheriting the parent's model`,
      );
    else definition.model = front.model;
  }
  const turns = front.maxTurns ?? front.steps ?? front.maxSteps;
  if (typeof turns === "number" && Number.isInteger(turns) && turns > 0)
    definition.maxTurns = turns;
  if (typeof front.color === "string") definition.color = front.color;
  const permission = front.permission as Record<string, unknown> | undefined;
  if (permission && typeof permission === "object") {
    const write = level(permission.edit ?? permission.write);
    const process = level(permission.bash ?? permission.process);
    definition.permission = { ...(write ? { write } : {}), ...(process ? { process } : {}) };
  }
  if (front.readOnly === true) definition.readOnly = true;
  const skills = list(front.skills);
  if (skills) definition.skills = skills;
  return { definition, warnings };
}

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: "general",
    description:
      "General-purpose agent for multi-step tasks: research, code changes and verification. Has every tool its parent has, including delegation.",
    prompt:
      "You are a general-purpose subagent. Work autonomously on the delegated task, verify your results, and finish with a concise report of what you did, what you found and anything left undone.",
    tools: ["*"],
    mode: "subagent",
    hidden: false,
    background: false,
    source: "builtin",
  },
  {
    name: "explore",
    description:
      "Fast read-only agent for exploring a codebase: find files, search code and summarize how things work. Cannot modify files or run processes.",
    prompt:
      "You are a read-only exploration subagent. Use list_files, search_text, read_file and git tools efficiently to answer the delegated question. Cite file paths. Do not propose edits unless asked. Finish with a concise, factual summary.",
    tools: [
      "read_file",
      "list_files",
      "search_text",
      "git_status",
      "git_diff",
      "context_explain",
      "skill_load",
      "skill_search",
      "skill_resource",
    ],
    readOnly: true,
    mode: "subagent",
    hidden: false,
    background: false,
    color: "cyan",
    source: "builtin",
  },
  {
    name: "plan",
    description:
      "Read-only planning agent: analyzes the code and returns a step-by-step implementation plan with the files to change. Never edits.",
    prompt:
      "You are a read-only planning subagent. Investigate the relevant code, then return a concrete, ordered implementation plan listing files, functions and risks. Do not modify anything.",
    tools: ["read_file", "list_files", "search_text", "git_status", "git_diff", "context_explain"],
    readOnly: true,
    mode: "subagent",
    hidden: false,
    background: false,
    color: "yellow",
    source: "builtin",
  },
];

async function readDir(dir: string): Promise<Array<{ path: string; text: string }>> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const out: Array<{ path: string; text: string }> = [];
  for (const name of names.slice(0, 200)) {
    const path = join(dir, name);
    try {
      const text = await readFile(path, "utf8");
      if (text.length <= 64_000) out.push({ path, text });
    } catch {
      /* unreadable entries are skipped */
    }
  }
  return out;
}
export interface CliAgent {
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
}
/**
 * Discovery, first match wins by name: CLI `--agents` > project `.alisio/agents` >
 * `.agents/agents` (speculative convention) > compat `.claude/agents`, `.opencode/agent(s)`
 * > user `<config>/agents`, `~/.claude/agents`, `~/.config/opencode/agent(s)` > plugin
 * directories (namespaced `plugin:name`) > built-ins. Project sources require trust.
 */
export async function discoverAgents(options: {
  workspace: string;
  home: string;
  configHome: string;
  trusted: boolean;
  cli?: Record<string, CliAgent>;
  plugins: Array<{ plugin: string; dir: string }>;
}): Promise<{ agents: Map<string, AgentDefinition>; warnings: string[] }> {
  const agents = new Map<string, AgentDefinition>();
  const warnings: string[] = [];
  const add = (definition: AgentDefinition) => {
    const existing = agents.get(definition.name);
    if (existing)
      warnings.push(
        `Agent ${definition.name} from ${definition.path ?? definition.source} is shadowed by ${existing.path ?? existing.source}`,
      );
    else agents.set(definition.name, definition);
  };
  for (const [name, spec] of Object.entries(options.cli ?? {})) {
    const { definition, warnings: w } = parseAgentDefinition(
      `---\n${JSON.stringify({ name, description: spec.description, ...(spec.tools ? { tools: spec.tools } : {}), ...(spec.model ? { model: spec.model } : {}) })}\n---\n${spec.prompt ?? ""}`,
      { source: "cli" },
    );
    warnings.push(...w);
    if (definition) add(definition);
  }
  const sources: Array<{ dir: string; source: string; project: boolean }> = [
    { dir: join(options.workspace, ".alisio", "agents"), source: "project", project: true },
    { dir: join(options.workspace, ".agents", "agents"), source: "convention", project: true },
    { dir: join(options.workspace, ".claude", "agents"), source: "compat", project: true },
    { dir: join(options.workspace, ".opencode", "agent"), source: "compat", project: true },
    { dir: join(options.workspace, ".opencode", "agents"), source: "compat", project: true },
    { dir: join(options.configHome, "agents"), source: "user", project: false },
    { dir: join(options.home, ".claude", "agents"), source: "user", project: false },
    { dir: join(options.home, ".config", "opencode", "agent"), source: "user", project: false },
    { dir: join(options.home, ".config", "opencode", "agents"), source: "user", project: false },
  ];
  for (const { dir, source, project } of sources) {
    if (project && !options.trusted) continue;
    for (const file of await readDir(dir)) {
      const { definition, warnings: w } = parseAgentDefinition(file.text, {
        source,
        path: file.path,
      });
      warnings.push(...w);
      if (definition) add(definition);
    }
  }
  for (const { plugin, dir } of options.plugins)
    for (const file of await readDir(dir)) {
      const { definition, warnings: w } = parseAgentDefinition(file.text, {
        source: `plugin:${plugin}`,
        path: file.path,
      });
      warnings.push(...w);
      if (definition) add({ ...definition, name: `${plugin}:${definition.name}` });
    }
  for (const builtin of BUILTIN_AGENTS) add(builtin);
  return { agents, warnings };
}
