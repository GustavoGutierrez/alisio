import { readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { safePath } from "../runtime/paths.ts";

const metadata = z.object({
  name: z
    .string()
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().min(1).max(1024),
});
export interface Skill {
  name: string;
  description: string;
  directory: string;
  file: string;
}
export class Skills {
  items = new Map<string, Skill>();
  diagnostics: string[] = [];
  private seen = new Set<string>();
  async discover(roots: string[]): Promise<void> {
    this.items.clear();
    this.diagnostics = [];
    this.seen.clear();
    for (const root of roots) await this.walk(root, 0);
  }
  private async walk(path: string, depth: number): Promise<void> {
    if (depth > 8) {
      this.diagnostics.push(`Skill depth exceeded: ${path}`);
      return;
    }
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    if (this.seen.has(canonical)) return;
    this.seen.add(canonical);
    const file = join(canonical, "SKILL.md");
    if (await Bun.file(file).exists()) {
      try {
        await safePath(canonical, file);
        const data = await this.parse(file);
        if (data.name !== basename(canonical)) throw new Error("Skill name must match directory");
        if (this.items.has(data.name))
          this.diagnostics.push(`Shadowed skill ${data.name}: ${file}`);
        else this.items.set(data.name, { ...data, directory: canonical, file });
      } catch (e) {
        this.diagnostics.push(`${file}: ${String(e)}`);
      }
      return;
    }
    for (const entry of (await readdir(canonical, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    ))
      if (entry.isDirectory() && !entry.name.startsWith("."))
        await this.walk(join(canonical, entry.name), depth + 1);
  }
  private async parse(file: string) {
    const f = Bun.file(file);
    if (f.size > 64_000) throw new Error("Skill exceeds 64 KB");
    const text = await f.text();
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
    return `Skill root: ${skill.directory}\nUse skill_resource to read supporting files.\n${await Bun.file(skill.file).text()}`;
  }
  async resource(name: string, path: string): Promise<string> {
    const skill = this.items.get(name);
    if (!skill) throw new Error("Unknown skill");
    const file = Bun.file(await safePath(skill.directory, path));
    if (file.size > 32_000) throw new Error("Resource exceeds 32 KB; split it into smaller files");
    return file.text();
  }
}
