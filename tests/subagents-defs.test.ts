import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { subagentsConfigSchema } from "../packages/plugin-subagents/src/config.ts";
import {
  BUILTIN_AGENTS,
  discoverAgents,
  parseAgentDefinition,
} from "../packages/plugin-subagents/src/definitions.ts";

const root = await mkdtemp(join(tmpdir(), "alisio-agents-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const md = (front: string, body = "You are careful.") => `---\n${front}\n---\n${body}`;

describe("agent definition parsing", () => {
  it("reads the Alisio format with every optional field", () => {
    const { definition, warnings } = parseAgentDefinition(
      md(
        "name: reviewer\ndescription: Reviews diffs\ntools: [read_file, search_text]\ndisallowedTools: [shell]\nmodel: inherit\nmode: subagent\nmaxTurns: 12\ncolor: magenta\npermission:\n  edit: deny\n  bash: ask\nhidden: false\nbackground: true\nskills: [review]\nfuture: 1",
      ),
      { source: "project", path: "/x/reviewer.md" },
    );
    expect(definition).toMatchObject({
      name: "reviewer",
      description: "Reviews diffs",
      prompt: "You are careful.",
      tools: ["read_file", "search_text"],
      disallowedTools: ["shell"],
      mode: "subagent",
      maxTurns: 12,
      color: "magenta",
      permission: { write: "deny", process: "ask" },
      hidden: false,
      background: true,
      skills: ["review"],
      source: "project",
    });
    expect(definition?.model).toBeUndefined();
    expect(warnings.some((w) => /future/.test(w))).toBe(true);
  });

  it("maps Claude Code and opencode formats", () => {
    const claude = parseAgentDefinition(
      md("name: code-reviewer\ndescription: Review\ntools: Read, Grep, Glob, Bash\nmodel: sonnet"),
      { source: "compat", path: "/p/.claude/agents/code-reviewer.md" },
    );
    expect(claude.definition?.tools).toEqual([
      "read_file",
      "search_text",
      "list_files",
      "shell",
      "run_process",
    ]);
    expect(claude.definition?.model).toBeUndefined();
    expect(claude.warnings.some((w) => /sonnet/.test(w))).toBe(true);
    const opencode = parseAgentDefinition(
      md(
        "description: Docs writer\nmode: subagent\nsteps: 7\ntools:\n  bash: false\n  write: true\nmodel: deepseek/deepseek-chat",
      ),
      { source: "compat", path: "/p/.opencode/agent/docs-writer.md" },
    );
    expect(opencode.definition).toMatchObject({
      name: "docs-writer",
      maxTurns: 7,
      disallowedTools: ["shell", "run_process"],
      model: "deepseek/deepseek-chat",
    });
  });

  it("rejects invalid names and missing descriptions", () => {
    expect(
      parseAgentDefinition(md("name: Bad Name\ndescription: x"), { source: "user" }).definition,
    ).toBeUndefined();
    expect(parseAgentDefinition(md("name: ok"), { source: "user" }).definition).toBeUndefined();
  });

  it("marks definitions main-capable when mode is primary or all", () => {
    const primary = parseAgentDefinition(
      md("name: reviewer\ndescription: Reviews\ntools: [read_file]\nmode: primary"),
      { source: "project", path: "/p/.alisio/agents/reviewer.md" },
    );
    expect(primary.definition).toMatchObject({ name: "reviewer", mode: "primary" });
    const all = parseAgentDefinition(md("name: copilot\ndescription: Everything\nmode: all"), {
      source: "project",
    });
    expect(all.definition?.mode).toBe("all");
    const plain = parseAgentDefinition(md("name: scout\ndescription: Explore\nmode: subagent"), {
      source: "project",
    });
    expect(plain.definition?.mode).toBe("subagent");
  });
});

describe("agent discovery", () => {
  const write = async (dir: string, name: string, description: string) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.md`), md(`name: ${name}\ndescription: ${description}`));
  };
  it("applies precedence cli > project > .agents > compat > user > plugin > builtin", async () => {
    const workspace = join(root, "w"),
      home = join(root, "home");
    await write(join(workspace, ".alisio", "agents"), "shared", "alisio project");
    await write(join(workspace, ".agents", "agents"), "shared", "agents convention");
    await write(join(workspace, ".claude", "agents"), "claude-only", "claude compat");
    await write(join(workspace, ".opencode", "agent"), "oc-only", "opencode compat");
    await write(join(home, ".config", "alisio", "agents"), "explore", "user explore");
    await write(join(root, "plugin-agents"), "helper", "from plugin");
    const cli = { shared: { description: "from cli", prompt: "CLI" } };
    const found = await discoverAgents({
      workspace,
      home,
      configHome: join(home, ".config", "alisio"),
      trusted: true,
      cli,
      plugins: [{ plugin: "acme", dir: join(root, "plugin-agents") }],
    });
    const by = (name: string) => found.agents.get(name);
    expect(by("shared")?.description).toBe("from cli");
    expect(by("claude-only")?.source).toBe("compat");
    expect(by("oc-only")?.description).toBe("opencode compat");
    expect(by("explore")?.description).toBe("user explore");
    expect(by("acme:helper")?.description).toBe("from plugin");
    expect(by("general")?.source).toBe("builtin");
    expect(found.warnings.some((w) => /shared/.test(w) && /shadow/i.test(w))).toBe(true);
  });

  it("ignores project sources for untrusted projects", async () => {
    const workspace = join(root, "untrusted");
    await write(join(workspace, ".alisio", "agents"), "evil", "project agent");
    const found = await discoverAgents({
      workspace,
      home: join(root, "nohome"),
      configHome: join(root, "nohome", ".config", "alisio"),
      trusted: false,
      plugins: [],
    });
    expect(found.agents.has("evil")).toBe(false);
    expect([...BUILTIN_AGENTS.map((a) => a.name)].every((n) => found.agents.has(n))).toBe(true);
  });

  it("ships general, explore and plan built-ins with read-only explore/plan", () => {
    const names = BUILTIN_AGENTS.map((a) => a.name);
    expect(names).toEqual(["general", "explore", "plan"]);
    expect(BUILTIN_AGENTS.find((a) => a.name === "general")?.tools).toEqual(["*"]);
    for (const n of ["explore", "plan"])
      expect(BUILTIN_AGENTS.find((a) => a.name === n)?.readOnly).toBe(true);
  });

  it("reads mode from --agents JSON: primary/all are main-capable, subagent by default", async () => {
    const found = await discoverAgents({
      workspace: root,
      home: join(root, "nohome"),
      configHome: join(root, "nohome", ".config", "alisio"),
      trusted: true,
      cli: {
        reviewer: { description: "Reviews", prompt: "Review.", mode: "primary" },
        planner: { description: "Plans", prompt: "Plan.", mode: "all" },
        helper: { description: "Helps", prompt: "Help." },
      },
      plugins: [],
    });
    expect(found.agents.get("reviewer")?.mode).toBe("primary");
    expect(found.agents.get("planner")?.mode).toBe("all");
    expect(found.agents.get("helper")?.mode).toBe("subagent");
    // The plugin configuration schema accepts the same shape.
    const parsed = subagentsConfigSchema.parse({
      agents: { reviewer: { description: "d", prompt: "p", mode: "primary" } },
    });
    expect(parsed.agents.reviewer?.mode).toBe("primary");
  });
});
