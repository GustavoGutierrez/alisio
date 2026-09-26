import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import {
  type AskQuestionsRequest,
  type AskQuestionsResult,
  type JsonSchema,
  type Question,
  type SearchProvider,
  type ToolDefinition,
  textResult,
} from "@alisio/sdk";
import type { Policy } from "../core/contracts.ts";
import type { ToolRegistry } from "../core/registry.ts";
import type { ProjectContext } from "../resources/context.ts";
import type { Skills } from "../resources/skills.ts";
import { fileSize, readHead, readText } from "../runtime/fs.ts";
import { safePath } from "../runtime/paths.ts";
import { runProcess } from "../runtime/process.ts";
import { EXECUTE_TIMEOUT_MS, MAX_NESTED_CALLS, runExecute } from "./execute.ts";
import { searchWithFallback, type WebsearchConfig } from "./search.ts";
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_RESPONSE_BYTES,
  MAX_TIMEOUT_SECONDS,
  type WebfetchFormat,
  webfetch,
} from "./webfetch.ts";

const str = { type: "string" },
  integer = { type: "integer", minimum: 0 };
export const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function existing(path: string): Promise<string | undefined> {
  const size = await fileSize(path);
  if (size === undefined) return;
  if (size > 1_048_576) throw new Error("Editable files are limited to 1 MiB");
  return readText(path);
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
    await writeFile(temporary, content, { mode });
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
  ui?: {
    interactive(): boolean;
    askQuestions(request: AskQuestionsRequest): Promise<AskQuestionsResult>;
  },
  /** Live policy accessor for `execute`'s nested tool calls (bound once the runner exists). */
  execCtx?: { policy(): Policy },
  websearchCtx?: {
    config?: WebsearchConfig;
    resolveExtension?: () => { provider: SearchProvider; plugin: string } | undefined;
  },
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
    async execute(i, c) {
      const path = await safePath(c.workspace, String(i.path));
      const size = await fileSize(path);
      if (size === undefined) throw new Error(`File not found: ${String(i.path)}`);
      const raw = await readHead(path, 1_048_576);
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
          sha256: size <= 1_048_576 ? hash(raw) : null,
          startLine: start,
          content: content.slice(0, 28_000),
          truncated:
            size > 1_048_576 || start - 1 + limit < lines.length || content.length > 28_000,
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
    async execute(i, c) {
      const content = String(i.content);
      if (Buffer.byteLength(content) > 1_048_576) throw new Error("Write exceeds 1 MiB");
      await atomicWrite(c.workspace, String(i.path), content, i.expectedHash as string | null);
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
    async execute(i, c) {
      const path = await safePath(c.workspace, String(i.path)),
        before = await existing(path);
      if (before === undefined) throw new Error("File not found");
      const needle = String(i.oldText),
        index = before.indexOf(needle);
      if (index < 0 || before.indexOf(needle, index + 1) >= 0)
        throw new Error("Edit must match exactly one occurrence");
      const after =
        before.slice(0, index) + String(i.newText) + before.slice(index + needle.length);
      await atomicWrite(c.workspace, path, after, String(i.expectedHash));
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
      const path = await safePath(c.workspace, String(i.path ?? "."));
      const result = await runProcess(
        "rg",
        ["--files", "--glob", "!.git", "--glob", "!node_modules", "--", path],
        { cwd: c.workspace, signal: c.signal, maxBytes: 200_000 },
      );
      if (result.exitCode > 1 && !result.truncated) throw new Error(result.stderr);
      const all = result.stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((p) => relative(c.workspace, p))
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
      const path = await safePath(c.workspace, String(i.path ?? "."));
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
        { cwd: c.workspace, signal: c.signal },
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
            cwd: c.workspace,
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
            { cwd: c.workspace, signal: c.signal, onData: c.emit },
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
          cwd: c.workspace,
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
  register({
    name: "ask_user_question",
    effect: "read",
    description:
      "Ask the user one or more multiple-choice questions when there is a real fork in the " +
      "approach and their preference genuinely changes what you do next. Each question needs 2-4 " +
      "concrete options; mark at most one `recommended` when you have a clear opinion, but it is " +
      "only a suggestion, never forced on the user. Prefer a single round: only ask a follow-up " +
      "batch afterward if the answers create a genuinely new fork. Only usable in an interactive " +
      "session; if it is not, this call fails and you should ask the question in plain text instead " +
      "and wait for the user's normal reply.",
    inputSchema: objectSchema(
      {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              header: { type: "string", minLength: 1, maxLength: 40 },
              question: { type: "string", minLength: 1 },
              multiSelect: { type: "boolean" },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 4,
                items: objectSchema(
                  {
                    label: { type: "string", minLength: 1 },
                    description: str,
                    recommended: { type: "boolean" },
                  },
                  ["label"],
                ),
              },
            },
            required: ["header", "question", "options"],
            additionalProperties: false,
          },
        },
      },
      ["questions"],
    ),
    async execute(i, c) {
      if (!ui?.interactive())
        return textResult(
          JSON.stringify({
            error:
              "ask_user_question is unavailable: this session is not interactive (headless or " +
              "--json). Ask the question in plain text in your reply instead and wait for the " +
              "user's normal answer; never rely on this tool here.",
          }),
          true,
        );
      const specs = i.questions as Array<{
        header: string;
        question: string;
        multiSelect?: boolean;
        options: Array<{ label: string; description?: string; recommended?: boolean }>;
      }>;
      for (const spec of specs) {
        const recommended = spec.options.filter((o) => o.recommended).length;
        if (recommended > 1)
          throw new Error(`At most one option may be recommended (question "${spec.header}")`);
        const labels = new Set(spec.options.map((o) => o.label));
        if (labels.size !== spec.options.length)
          throw new Error(`Option labels must be unique within a question ("${spec.header}")`);
      }
      const questions: Question[] = specs.map((spec, index) => ({
        id: `q${index}`,
        header: spec.header,
        question: spec.question,
        multiSelect: spec.multiSelect,
        options: spec.options.map((o) => ({
          value: o.label,
          label: o.label,
          ...(o.description ? { description: o.description } : {}),
          ...(o.recommended ? { recommended: true } : {}),
        })),
      }));
      const result = await ui.askQuestions({
        questions,
        ...(c.session ? { session: c.session } : {}),
        ...(c.label ? { label: c.label } : {}),
        signal: c.signal,
      });
      const answers = specs.map((spec, index) => {
        const value = result[`q${index}`];
        if (value === undefined) return { header: spec.header, skipped: true, selected: [] };
        return {
          header: spec.header,
          skipped: false,
          selected: Array.isArray(value) ? value : [value],
        };
      });
      return textResult(JSON.stringify({ answers }));
    },
  });
  register({
    name: "webfetch",
    effect: "external",
    description:
      "Fetch a URL as text, markdown or HTML (default markdown). Follows redirects; refuses " +
      `binary/image responses; capped at ${MAX_RESPONSE_BYTES} bytes. Long pages are truncated ` +
      "in the result with a `fullTextPath` you can read in full with read_file.",
    inputSchema: objectSchema(
      {
        url: str,
        format: { type: "string", enum: ["markdown", "text", "html"] },
        timeout: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TIMEOUT_SECONDS,
          description: "Seconds, default 30, capped at 120",
        },
      },
      ["url"],
    ),
    async execute(i, c) {
      const result = await webfetch(
        c.workspace,
        String(i.url),
        (i.format as WebfetchFormat | undefined) ?? "markdown",
        Number(i.timeout ?? DEFAULT_TIMEOUT_SECONDS),
        c.signal,
      );
      return textResult(JSON.stringify(result));
    },
  });
  // In "native" mode the provider answers search server-side (see application.ts); registering
  // this tool too would just confuse the model with a second, redundant search path.
  if (websearchCtx?.config?.provider !== "native")
    register({
      name: "websearch",
      effect: "external",
      description:
        "Search the web and return {title, url, snippet} results. Uses a configured provider " +
        "(websearch.provider in config), or a public SearXNG instance by default; check the " +
        "result's `limitation` field, since some providers (e.g. duckduckgo-instant) only answer " +
        "direct factual queries, not general search.",
      inputSchema: objectSchema({ query: { type: "string", minLength: 1 } }, ["query"]),
      async execute(i, c) {
        const outcome = await searchWithFallback(
          String(i.query),
          websearchCtx?.config,
          websearchCtx?.resolveExtension,
          c.signal,
        );
        return textResult(
          JSON.stringify({
            results: outcome.results,
            source: outcome.source,
            ...(outcome.limitation ? { limitation: outcome.limitation } : {}),
            ...(outcome.diagnostic ? { diagnostic: outcome.diagnostic } : {}),
          }),
        );
      },
    });
  register({
    name: "execute",
    effect: "process",
    description:
      "Run a short JavaScript snippet (Code Mode) that can call other tools via " +
      "`await callTool(name, input)` and return one final JSON-serializable value, so " +
      "intermediate tool results never re-enter your context — only the return value does. " +
      "The snippet runs in an isolated context with no filesystem, network, imports or timers " +
      "of its own; every nested callTool still goes through this session's normal permission " +
      `gate (an effect not already allowed is denied, never newly approved). Bounded to ` +
      `${EXECUTE_TIMEOUT_MS}ms wall-clock and ${MAX_NESTED_CALLS} nested tool calls. This is a ` +
      "correctness sandbox, not an OS security boundary. Prefer plain sequential tool calls " +
      "unless you are combining several read-only calls or post-processing their output.",
    inputSchema: objectSchema({ code: { type: "string", minLength: 1 } }, ["code"]),
    async execute(i, c) {
      const policy = execCtx?.policy() ?? { write: false, process: false, external: false };
      const result = await runExecute(String(i.code), {
        registry,
        policy,
        workspace: c.workspace,
        signal: c.signal,
        emit: c.emit,
        ...(c.session ? { session: c.session } : {}),
        ...(c.label ? { label: c.label } : {}),
      });
      return textResult(JSON.stringify({ result: result ?? null }));
    },
  });
}
