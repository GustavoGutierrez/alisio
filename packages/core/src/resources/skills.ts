import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { exists, fileSize, readText } from "../runtime/fs.ts";
import { safePath } from "../runtime/paths.ts";

/** Agent Skills name rule: 1-64 lowercase letters/digits, single hyphens, no edge hyphens. */
const metadata = z.object({
  name: z
    .string()
    .max(64)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "name must be lowercase letters, digits and single hyphens",
    ),
  description: z.string().min(1).max(1024),
});
export interface Skill {
  name: string;
  description: string;
  directory: string;
  file: string;
  scope: SkillScope;
}
export type SkillScope = "project" | "config" | "user" | "plugin";
export interface SkillRoot {
  dir: string;
  scope: SkillScope;
}
/**
 * Discovery roots in precedence order (first wins): project `.agents/skills`, `.alisio/skills`
 * and `.claude/skills` (compat) from cwd up to the workspace root (trusted projects only), then
 * explicitly configured paths, then `~/.agents/skills` and `<config home>/skills`, then plugins.
 */
export function skillRoots(options: {
  workspace: string;
  cwd: string;
  home: string;
  configHome: string;
  trusted: boolean;
  configSkills?: string[];
  pluginRoots?: string[];
}): SkillRoot[] {
  const roots: SkillRoot[] = [];
  if (options.trusted) {
    let dir = options.cwd;
    while (true) {
      for (const convention of [".agents", ".alisio", ".claude"])
        roots.push({ dir: join(dir, convention, "skills"), scope: "project" });
      if (dir === options.workspace || dirname(dir) === dir) break;
      dir = dirname(dir);
    }
  }
  for (const dir of options.configSkills ?? []) roots.push({ dir, scope: "config" });
  roots.push(
    { dir: join(options.home, ".agents", "skills"), scope: "user" },
    { dir: join(options.configHome, "skills"), scope: "user" },
  );
  for (const dir of options.pluginRoots ?? []) roots.push({ dir, scope: "plugin" });
  return roots;
}
export class Skills {
  items = new Map<string, Skill>();
  diagnostics: string[] = [];
  private seen = new Set<string>();
  private scanned = 0;
  private maxDepth: number;
  private maxDirs: number;
  constructor(options: { maxDepth?: number; maxDirs?: number } = {}) {
    this.maxDepth = options.maxDepth ?? 5;
    this.maxDirs = options.maxDirs ?? 2000;
  }
  /** Roots in precedence order; plain strings are treated as user-level roots. */
  async discover(roots: Array<string | SkillRoot>): Promise<void> {
    this.items.clear();
    this.diagnostics = [];
    this.seen.clear();
    this.scanned = 0;
    for (const root of roots) {
      const entry = typeof root === "string" ? { dir: root, scope: "user" as const } : root;
      await this.walk(entry.dir, 0, entry.scope);
    }
  }
  private async walk(path: string, depth: number, scope: SkillScope): Promise<void> {
    if (depth > this.maxDepth) return;
    if (this.scanned >= this.maxDirs) {
      if (this.scanned === this.maxDirs) {
        this.diagnostics.push(
          `Skill scan limit of ${this.maxDirs} directories reached; stopped at ${path}`,
        );
        this.scanned++;
      }
      return;
    }
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch (e) {
      if (["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) return;
      throw e;
    }
    if (this.seen.has(canonical)) return;
    this.seen.add(canonical);
    this.scanned++;
    const file = join(canonical, "SKILL.md");
    if (await exists(file)) {
      try {
        await safePath(canonical, file);
        const data = await this.parse(file);
        if (data.name !== basename(canonical))
          this.diagnostics.push(
            `Skill ${data.name} lives in directory "${basename(canonical)}" (spec expects the same name); loaded anyway: ${file}`,
          );
        const existing = this.items.get(data.name);
        if (existing)
          this.diagnostics.push(
            `Skill ${data.name} from ${file} (${scope}) is shadowed: ${existing.file} (${existing.scope}) overrides it`,
          );
        else this.items.set(data.name, { ...data, directory: canonical, file, scope });
      } catch (e) {
        this.diagnostics.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(canonical, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)))
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
        await this.walk(join(canonical, entry.name), depth + 1, scope);
  }
  private async parse(file: string) {
    if (((await fileSize(file)) ?? 0) > 64_000) throw new Error("Skill exceeds 64 KB");
    const text = await readText(file);
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match?.[1]) throw new Error("Missing YAML frontmatter");
    return metadata.parse(parse(match[1], { maxAliasCount: 20 }));
  }
  catalog(): string {
    const entries = [...this.items.values()].map((s) => ({
      name: s.name,
      description: s.description,
    }));
    const text = JSON.stringify(entries);
    if (text.length > 24_000)
      return "Large skill catalog. Use skill_search to find skills, then skill_load.";
    return `Available skills (load instructions with skill_load):\n${text}`;
  }
  async load(name: string): Promise<string> {
    const skill = this.items.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    await this.parse(skill.file);
    return `Skill root: ${skill.directory}\nUse skill_resource to read supporting files.\n${await readText(skill.file)}`;
  }
  async resource(name: string, path: string): Promise<string> {
    const skill = this.items.get(name);
    if (!skill) throw new Error("Unknown skill");
    const file = await safePath(skill.directory, path);
    if (((await fileSize(file)) ?? 0) > 32_000)
      throw new Error("Resource exceeds 32 KB; split it into smaller files");
    return readText(file);
  }
}
