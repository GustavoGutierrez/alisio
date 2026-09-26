import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { type JsonSchema, type ToolDefinition, textResult } from "@alisio/sdk";
import type { ToolRegistry } from "../core/registry.ts";
import type { ProjectContext } from "../resources/context.ts";
import type { Skills } from "../resources/skills.ts";
import { safePath } from "../runtime/paths.ts";
import { runProcess } from "../runtime/process.ts";

const str = { type: "string" },
  integer = { type: "integer", minimum: 0 };
export const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function existing(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return;
  if (file.size > 1_048_576) throw new Error("Editable files are limited to 1 MiB");
  return file.text();
}
async function atomicWrite(
  root: string,
  path: string,
  content: string,
  expected: string | null,
): Promise<void> {
  path = await safePath(root, path);
  await mkdir(dirname(path), { recursive: true });
  const before = await existing(path);
  if (before === undefined ? expected !== null : hash(before) !== expected)
    throw new Error("File precondition failed: reread the file and use its current sha256");
  const temporary = `${path}.alisio-${crypto.randomUUID()}.tmp`;
  try {
    const mode = before === undefined ? 0o644 : (await stat(path)).mode & 0o777;
    await Bun.write(temporary, content, { mode });
    await safePath(root, path);
    const now = await existing(path);
    if (now !== before) throw new Error("File changed while preparing write");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export function registerStandard(
  registry: ToolRegistry,
  workspace: string,
  skills: Skills,
  context: ProjectContext,
): void {
  const register = (tool: ToolDefinition) => registry.register(tool);
  const filePaths = (input: Record<string, unknown>) =>
    typeof input.path === "string" ? [input.path] : [];
  register({
    name: "read_file",
    effect: "read",
    description: "Read UTF-8 text by line; returns sha256 for safe edits. Max scan 1 MiB.",
    inputSchema: objectSchema(
      {
        path: str,
        startLine: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      ["path"],
    ),
    paths: filePaths,
    async execute(i) {
      const path = await safePath(workspace, String(i.path)),
        file = Bun.file(path);
      const raw = await file.slice(0, 1_048_576).text();
      if (raw.includes("\0")) throw new Error("Binary file; text reader refused");
      const start = Number(i.startLine ?? 1),
        limit = Number(i.limit ?? 200),
        lines = raw.split("\n");
      const content = lines
        .slice(start - 1, start - 1 + limit)
        .map((line, n) => `${start + n}: ${line}`)
        .join("\n");
      return textResult(
        JSON.stringify({
          path: i.path,
          sha256: file.size <= 1_048_576 ? hash(raw) : null,
          startLine: start,
          content: content.slice(0, 28_000),
          truncated:
            file.size > 1_048_576 || start - 1 + limit < lines.length || content.length > 28_000,
        }),
      );
    },
  });
  register({
    name: "write_file",
    effect: "write",
    description:
      "Create or replace a file. expectedHash is null only for a new file, otherwise use read_file sha256.",
    inputSchema: objectSchema(
      { path: str, content: str, expectedHash: { type: ["string", "null"] } },
      ["path", "content", "expectedHash"],
    ),
    paths: filePaths,
    async execute(i) {
      const content = String(i.content);
      if (Buffer.byteLength(content) > 1_048_576) throw new Error("Write exceeds 1 MiB");
      await atomicWrite(workspace, String(i.path), content, i.expectedHash as string | null);
      return textResult(JSON.stringify({ path: i.path, sha256: hash(content) }));
    },
  });
  register({
    name: "edit_file",
    effect: "write",
    description:
      "Replace exactly one occurrence. Requires expectedHash from read_file; preserves untouched bytes and line endings.",
    inputSchema: objectSchema(
      { path: str, oldText: { type: "string", minLength: 1 }, newText: str, expectedHash: str },
      ["path", "oldText", "newText", "expectedHash"],
    ),
    paths: filePaths,
    async execute(i) {
      const path = await safePath(workspace, String(i.path)),
        before = await existing(path);
      if (before === undefined) throw new Error("File not found");
      const needle = String(i.oldText),
        index = before.indexOf(needle);
      if (index < 0 || before.indexOf(needle, index + 1) >= 0)
        throw new Error("Edit must match exactly one occurrence");
      const after =
        before.slice(0, index) + String(i.newText) + before.slice(index + needle.length);
      await atomicWrite(workspace, path, after, String(i.expectedHash));
      return textResult(JSON.stringify({ path: i.path, sha256: hash(after) }));
    },
  });
  register({
    name: "list_files",
    effect: "read",
    description: "List gitignore-aware files using ripgrep, paginated. Hidden files are excluded.",
    inputSchema: objectSchema({
      path: str,
      offset: integer,
      limit: { type: "integer", minimum: 1, maximum: 500 },
    }),
    paths: filePaths,
    async execute(i, c) {
      const path = await safePath(workspace, String(i.path ?? "."));
      const result = await runProcess(
        "rg",
        ["--files", "--glob", "!.git", "--glob", "!node_modules", "--", path],
        { cwd: workspace, signal: c.signal, maxBytes: 200_000 },
      );
      if (result.exitCode > 1 && !result.truncated) throw new Error(result.stderr);
      const all = result.stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((p) => relative(workspace, p))
          .sort(),
        offset = Number(i.offset ?? 0),
        limit = Number(i.limit ?? 100);
      return textResult(
        JSON.stringify({
          files: all.slice(offset, offset + limit),
          nextOffset: offset + limit < all.length ? offset + limit : null,
          truncated: result.truncated,
        }),
      );
    },
  });
  register({
    name: "search_text",
    effect: "read",
    description:
      "Search text using ripgrep regex, JSON results and bounded output; exit code 1 means no matches.",
    inputSchema: objectSchema({ pattern: str, path: str, literal: { type: "boolean" } }, [
      "pattern",
    ]),
    paths: filePaths,
    async execute(i, c) {
      const path = await safePath(workspace, String(i.path ?? "."));
      const r = await runProcess(
        "rg",
        [
          "--json",
          "--max-count",
          "100",
          "--glob",
          "!.git",
          "--glob",
          "!node_modules",
          ...(i.literal ? ["--fixed-strings"] : []),
          "--",
          String(i.pattern),
          path,
        ],
        { cwd: workspace, signal: c.signal },
      );
      if (r.exitCode > 1 && !r.truncated) throw new Error(r.stderr);
      return textResult(JSON.stringify(r));
    },
  });
  register({
    name: "run_process",
    effect: "process",
    description:
      "Run an executable with an argument array. Not sandboxed; may access outside workspace.",
    inputSchema: objectSchema(
      {
        command: str,
        args: { type: "array", items: str },
        timeoutMs: { type: "integer", minimum: 1, maximum: 120000 },
      },
      ["command", "args"],
    ),
    async execute(i, c) {
      return textResult(
        JSON.stringify(
          await runProcess(String(i.command), i.args as string[], {
            cwd: workspace,
            signal: c.signal,
            timeoutMs: Number(i.timeoutMs ?? 30000),
            onData: c.emit,
          }),
        ),
      );
    },
  });
  register({
    name: "shell",
    effect: "process",
    description:
      "Run an arbitrary shell command. Explicit process capability required; not sandboxed.",
    inputSchema: objectSchema({ command: str }, ["command"]),
    async execute(i, c) {
      return textResult(
        JSON.stringify(
          await runProcess(
            process.platform === "win32" ? "cmd.exe" : "/bin/sh",
            process.platform === "win32"
              ? ["/d", "/s", "/c", String(i.command)]
              : ["-c", String(i.command)],
            { cwd: workspace, signal: c.signal, onData: c.emit },
          ),
        ),
      );
    },
  });
  for (const [name, args] of [
    ["git_status", ["status", "--porcelain=v1"]],
    ["git_diff", ["diff", "--no-ext-diff", "--no-textconv"]],
  ] as const)
    register({
      name,
      effect: "read",
      description: `Read ${name} without mutating the repository.`,
      inputSchema: objectSchema({}),
      async execute(_i, c) {
        const r = await runProcess("git", ["--no-pager", ...args], {
          cwd: workspace,
          signal: c.signal,
        });
        if (r.exitCode !== 0) throw new Error(r.stderr);
        return textResult(JSON.stringify(r));
      },
    });
  register({
    name: "skill_load",
    effect: "read",
    description: "Load a skill's full instructions on demand.",
    inputSchema: objectSchema({ name: str }, ["name"]),
    async execute(i) {
      return textResult(await skills.load(String(i.name)));
    },
  });
  register({
    name: "skill_search",
    effect: "read",
    description: "Search available skill metadata.",
    inputSchema: objectSchema({ query: str }, ["query"]),
    async execute(i) {
      const q = String(i.query).toLowerCase();
      return textResult(
        JSON.stringify(
          [...skills.items.values()]
            .filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(q))
            .slice(0, 30),
        ),
      );
    },
  });
  register({
    name: "skill_resource",
    effect: "read",
    description: "Read a supporting file relative to a skill root.",
    inputSchema: objectSchema({ name: str, path: str }, ["name", "path"]),
    async execute(i) {
      return textResult(await skills.resource(String(i.name), String(i.path)));
    },
  });
  register({
    name: "context_explain",
    effect: "read",
    description: "Inspect scoped AGENTS.md for a target file.",
    inputSchema: objectSchema({ path: str }, ["path"]),
    paths: filePaths,
    async execute(i) {
      return textResult(JSON.stringify(await context.explain(String(i.path))));
    },
  });
}
