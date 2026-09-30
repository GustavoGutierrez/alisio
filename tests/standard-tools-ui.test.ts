import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Message,
  type ModelProvider,
  type ToolResult,
  textProjection,
  type UiBlock,
} from "@alisio/sdk";
import { describe, expect, it, vi } from "vitest";
import { richPartsOf } from "../packages/cli/src/tui/state.ts";
import { createApplication } from "../packages/core/src/application.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { Skills } from "../packages/core/src/resources/skills.ts";
import { unifiedPatch } from "../packages/core/src/runtime/diff.ts";
import { registerStandard } from "../packages/core/src/tools/standard.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "alisio-std-ui-"));
  const reg = new ToolRegistry();
  registerStandard(reg, root, new Skills(), new ProjectContext(root));
  const ctx = { signal: AbortSignal.timeout(10_000), workspace: root, emit: () => {} };
  const run = (name: string, input: Record<string, unknown>) => reg.get(name).execute(input, ctx);
  return { root, run };
}

const ui = (result: ToolResult): UiBlock | undefined =>
  result.content.find((p) => p.type === "ui")?.type === "ui"
    ? (result.content.find((p) => p.type === "ui") as { block: UiBlock }).block
    : undefined;

describe("unified patches", () => {
  it("renders hunks with context and /dev/null for new files", () => {
    expect(unifiedPatch("a.txt", undefined, "x\ny\n")).toBe(
      "--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+x\n+y",
    );
    const before = `${Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n")}\n`;
    const after = before.replace("l5\n", "L5\n");
    expect(unifiedPatch("f", before, after, { context: 1 })).toBe(
      "--- a/f\n+++ b/f\n@@ -4,3 +4,3 @@\n l4\n-l5\n+L5\n l6",
    );
    expect(unifiedPatch("f", "same\n", "same\n")).toBe("");
  });

  it("marks a missing final newline", () => {
    expect(unifiedPatch("f", "a\n", "a")).toBe(
      "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+a\n\\ No newline at end of file",
    );
  });
});

describe("standard tools add web ui parts after the unchanged text", () => {
  it("write_file keeps its JSON text first and adds a diff block", async () => {
    const { root, run } = await setup();
    const result = await run("write_file", {
      path: "src/new.ts",
      content: "export const a = 1;\n",
      expectedHash: null,
    });
    expect(result.content[0]).toEqual({
      type: "text",
      text: JSON.stringify({ path: "src/new.ts", sha256: sha("export const a = 1;\n") }),
    });
    expect(ui(result)).toEqual({
      kind: "diff",
      path: "src/new.ts",
      lang: "ts",
      patch: "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+export const a = 1;",
    });
    // Providers only ever see the text: the model input is unchanged.
    expect(textProjection(result).content).toEqual([result.content[0]]);
    expect(await readFile(join(root, "src/new.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  it("edit_file adds a diff of the change", async () => {
    const { root, run } = await setup();
    await writeFile(join(root, "notes.md"), "one\ntwo\nthree\n");
    const result = await run("edit_file", {
      path: "notes.md",
      oldText: "two",
      newText: "TWO",
      expectedHash: sha("one\ntwo\nthree\n"),
    });
    expect(result.content[0]?.type).toBe("text");
    const block = ui(result);
    expect(block).toMatchObject({ kind: "diff", path: "notes.md", lang: "md" });
    expect(block?.kind === "diff" && block.patch).toContain("-two\n+TWO");
  });

  it("bounds large diffs to 200 KB and says so", async () => {
    const { run } = await setup();
    const content = `${"x".repeat(99)}\n`.repeat(5000); // 500 KB
    const result = await run("write_file", { path: "big.txt", content, expectedHash: null });
    const block = ui(result);
    expect(block?.kind).toBe("diff");
    if (block?.kind !== "diff") return;
    expect(Buffer.byteLength(block.patch ?? "")).toBeLessThanOrEqual(200 * 1024);
    expect(block.caption).toMatch(/truncated/i);
  });

  it("shell adds a terminal block with output and exit code", async () => {
    const { run } = await setup();
    const result = await run("shell", { command: "printf 'hi\\n'; printf 'oops' >&2; exit 3" });
    const text = result.content[0];
    expect(text?.type).toBe("text");
    expect(JSON.parse(text?.type === "text" ? text.text : "{}")).toMatchObject({
      stdout: "hi\n",
      stderr: "oops",
      exitCode: 3,
    });
    const block = ui(result);
    expect(block).toMatchObject({
      kind: "terminal",
      command: "printf 'hi\\n'; printf 'oops' >&2; exit 3",
      output: "hi\noops",
      exitCode: 3,
    });
    expect(block?.kind === "terminal" && typeof block.durationMs).toBe("number");
  });

  it("run_process adds a terminal block with the command line", async () => {
    const { run } = await setup();
    const result = await run("run_process", { command: "node", args: ["-e", "console.log(1)"] });
    expect(ui(result)).toMatchObject({
      kind: "terminal",
      command: "node -e console.log(1)",
      output: "1\n",
      exitCode: 0,
    });
  });

  it("the TUI keeps its current rendering for these standard blocks", async () => {
    const { run } = await setup();
    const shell = await run("shell", { command: "echo hi" });
    expect(richPartsOf(shell, "shell")).toEqual({});
    const write = await run("write_file", { path: "a.txt", content: "a\n", expectedHash: null });
    expect(richPartsOf(write, "write_file")).toEqual({});
    // Other tools (plugins, MCP) keep their rich parts in the TUI.
    expect(richPartsOf(shell, "plugin_tool").ui?.kind).toBe("terminal");
  });
});

describe("runner result bound with ui parts", () => {
  it("measures the 48 KB bound on the text the model sees, not on display blocks", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-std-bound-"));
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    const seen: Message[][] = [];
    // ~27 KB of output: under the bound as text, over it once the terminal block doubles it.
    const command = "seq 1 3000 | sed 's/^/row /'";
    const provider: ModelProvider = {
      id: "fake",
      model: "fake",
      async *stream(request) {
        seen.push(request.messages);
        if (request.messages.at(-1)?.role === "tool") {
          yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
          return;
        }
        yield {
          type: "completed",
          message: {
            role: "assistant",
            text: "",
            calls: [{ id: "s1", name: "shell", arguments: JSON.stringify({ command }) }],
          },
        };
      },
    };
    const app = await createApplication({
      cwd: root,
      db: join(root, "state", "sessions.sqlite"),
      noHerdr: true,
      provider,
      allowProcess: true,
    });
    try {
      const session = app.store.create(root, "fake", "fake");
      await app.runner.run(session.id, "go");
      const tool = seen[1]?.find((m) => m.role === "tool");
      const text = tool?.role === "tool" ? tool.result.content : [];
      expect(text).toHaveLength(1);
      expect(JSON.stringify(text)).not.toContain("[tool output truncated]");
      expect(JSON.stringify(text)).toContain("row 3000");
      expect(richPartsOf(app.store.callResult(session.id, "s1"), "plugin").ui?.kind).toBe(
        "terminal",
      );
    } finally {
      await app.close();
      vi.unstubAllEnvs();
    }
  });
});
