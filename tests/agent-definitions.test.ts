/**
 * User agent definitions: portable `.agents/agents` Markdown files (project and global scope),
 * validation, capability-driven settings, assisted drafts and the runtime registry hot-reload.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInfo, ModelProvider } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_PLUGINS } from "../packages/cli/src/builtin.ts";
import {
  agentModelCapabilities,
  agentModelLabels,
  agentModelOptions,
  fitAgentSettings,
} from "../packages/core/src/agents/capabilities.ts";
import {
  AgentScopeStore,
  agentIdFromName,
  validateAgentDefinitionInput,
} from "../packages/core/src/agents/definitions.ts";
import { generateAgentDraft, parseAgentDraft } from "../packages/core/src/agents/draft.ts";
import { AgentDefinitionService, type AgentRegistry } from "../packages/core/src/agents/service.ts";
import { AGENT_TEMPLATES } from "../packages/core/src/agents/templates.ts";
import { createApplication } from "../packages/core/src/application.ts";
import { parseAgentDefinition } from "../packages/plugin-subagents/src/definitions.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "alisio-agent-defs-"));
  roots.push(root);
  return root;
}

const input = {
  name: "Research Agent",
  description: "Researches things",
  instructions: "You research.\n\nCite sources.",
  model: "openai/gpt-x",
  reasoning: { effort: "medium", summary: "auto" as const },
  text: { format: { type: "text" as const }, verbosity: "high" as const },
};

describe("agent definition validation", () => {
  it("normalizes a valid body and drops empty optional settings", () => {
    const result = validateAgentDefinitionInput({
      ...input,
      name: "  Research Agent ",
      reasoning: { effort: "", summary: null },
      extra: "ignored",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        name: "Research Agent",
        description: "Researches things",
        instructions: "You research.\n\nCite sources.",
        model: "openai/gpt-x",
        text: { format: { type: "text" }, verbosity: "high" },
      },
    });
  });

  it("reports every invalid field", () => {
    const result = validateAgentDefinitionInput({
      name: "",
      model: "",
      reasoning: { summary: "verbose", effort: "MAX!" },
      text: { format: { type: "xml" }, verbosity: "loud" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.field).sort()).toEqual([
      "model",
      "name",
      "reasoning.effort",
      "reasoning.summary",
      "text.format.type",
      "text.verbosity",
    ]);
  });

  it("derives ids from names, skipping reserved and taken ids", () => {
    expect(agentIdFromName("Código Reviewer!", new Set())).toBe("codigo-reviewer");
    expect(agentIdFromName("Plan", new Set())).toBe("plan-2");
    expect(agentIdFromName("Reviewer", new Set(["reviewer", "reviewer-2"]))).toBe("reviewer-3");
    expect(agentIdFromName("!!!", new Set())).toBe("agent");
  });
});

describe("agent scope store (Markdown files)", () => {
  it("creates a file other harnesses can read, then lists, updates and deletes it", async () => {
    const dir = join(await tempRoot(), ".agents", "agents");
    let now = Date.UTC(2026, 0, 1);
    const store = new AgentScopeStore("project", dir, () => now);
    const created = await store.create(input);
    expect(created).toMatchObject({
      id: "research-agent",
      scope: "project",
      name: "Research Agent",
      model: "openai/gpt-x",
      reasoning: { effort: "medium", summary: "auto" },
      text: { format: { type: "text" }, verbosity: "high" },
      instructions: "You research.\n\nCite sources.",
      path: join(dir, "research-agent.md"),
      createdAt: now,
      updatedAt: now,
    });
    const text = await readFile(created.path, "utf8");
    expect(text).toMatch(/^---\nname: research-agent\ndescription: Researches things\n/);
    expect(text).toContain("\nmode: all\n");
    expect(text.endsWith("---\n\nYou research.\n\nCite sources.\n")).toBe(true);
    // The subagents plugin (and Claude Code style parsers) accept the file without warnings.
    const parsed = parseAgentDefinition(text, { source: "project", path: created.path });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.definition).toMatchObject({
      name: "research-agent",
      description: "Researches things",
      prompt: "You research.\n\nCite sources.",
      model: "openai/gpt-x",
      mode: "all",
      effort: "medium",
    });

    now += 1000;
    const updated = await store.update("research-agent", {
      ...input,
      name: "Deep Researcher",
      reasoning: { effort: "high" },
      text: undefined,
    } as never);
    expect(updated).toMatchObject({
      id: "research-agent",
      name: "Deep Researcher",
      reasoning: { effort: "high" },
      createdAt: Date.UTC(2026, 0, 1),
      updatedAt: now,
    });
    expect(updated.text).toBeUndefined();
    expect((await store.list()).map((a) => a.id)).toEqual(["research-agent"]);
    expect(await store.delete("research-agent")).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  it("round-trips keys and comments written by another tool", async () => {
    const dir = join(await tempRoot(), "agents");
    await mkdir(dir, { recursive: true });
    const foreign = [
      "---",
      "# Written by another harness",
      "name: reviewer",
      "description: Reviews diffs",
      "tools: Read, Grep",
      "color: magenta",
      "permission:",
      "  edit: deny",
      "---",
      "Be strict.",
      "",
    ].join("\n");
    await writeFile(join(dir, "reviewer.md"), foreign);
    const store = new AgentScopeStore("global", dir);
    const [listed] = await store.list();
    expect(listed).toMatchObject({ id: "reviewer", name: "reviewer", model: "" });
    await store.update("reviewer", {
      name: "Strict Reviewer",
      instructions: "Be very strict.",
      model: "local/qwen",
      text: { verbosity: "low" },
    });
    const text = await readFile(join(dir, "reviewer.md"), "utf8");
    expect(text).toContain("# Written by another harness");
    expect(text).toContain("tools: Read, Grep");
    expect(text).toContain("color: magenta");
    expect(text).toContain("permission:\n  edit: deny");
    expect(text).toContain("model: local/qwen");
    expect(text).toContain("displayName: Strict Reviewer");
    // An edit never adds a mode the original author did not choose.
    expect(text).not.toContain("mode:");
    expect(text.trimEnd().endsWith("Be very strict.")).toBe(true);
  });

  it("ignores files with invalid names or broken frontmatter and refuses path ids", async () => {
    const dir = join(await tempRoot(), "agents");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "Bad Name.md"), "---\nname: x\ndescription: y\n---\n");
    await writeFile(join(dir, "broken.md"), "---\nname: [unclosed\n---\n");
    const store = new AgentScopeStore("global", dir);
    expect(await store.list()).toEqual([]);
    await expect(store.update("../escape", { name: "x", model: "m" })).rejects.toThrow("not found");
    expect(await store.delete("../escape")).toBe(false);
  });
});

describe("agent definition service", () => {
  const registry = (loaded: string[] = []) => {
    const reload = vi.fn(async () => true);
    const value: AgentRegistry & { loaded: string[] } = {
      loaded,
      reload,
      loadedPaths: () => value.loaded,
    };
    return value;
  };

  it("merges scopes with the project agent overriding the global one", async () => {
    const root = await tempRoot();
    const service = new AgentDefinitionService({
      workspace: join(root, "ws"),
      home: join(root, "home"),
    });
    expect(service.defaultScope).toBe("project");
    await service.create("global", { ...input, name: "Shared" });
    await service.create("global", { ...input, name: "Only Global" });
    await service.create("project", { ...input, name: "Shared" });
    const list = await service.list();
    expect(list.map((a) => [a.id, a.scope, !!a.overridesGlobal, !!a.overriddenByProject])).toEqual([
      ["only-global", "global", false, false],
      ["shared", "project", true, false],
      ["shared", "global", false, true],
    ]);
    expect(list.find((a) => a.scope === "project")?.path).toBe(
      join(root, "ws", ".agents", "agents", "shared.md"),
    );
    expect(list.find((a) => a.id === "only-global")?.path).toBe(
      join(root, "home", ".agents", "agents", "only-global.md"),
    );
  });

  it("defaults to the global scope without a workspace", async () => {
    const root = await tempRoot();
    const service = new AgentDefinitionService({ home: root });
    expect(service.scopes).toEqual(["global"]);
    await expect(service.create("project", input)).rejects.toThrow("not available");
  });

  it("reloads the registry after each write and reports whether the change is live", async () => {
    const root = await tempRoot();
    const reg = registry();
    const service = new AgentDefinitionService({ workspace: root, home: root, registry: reg });
    const pending = await service.create("project", input);
    // The registry did not pick the file up (e.g. untrusted workspace): not live.
    expect(pending.live).toBe(false);
    expect(reg.reload).toHaveBeenCalledTimes(1);
    reg.loaded = [pending.result.path];
    const updated = await service.update("project", "research-agent", input);
    expect(updated.live).toBe(true);
    reg.loaded = [];
    const removed = await service.delete("project", "research-agent");
    expect(removed).toEqual({ result: true, live: true });
    expect(reg.reload).toHaveBeenCalledTimes(3);
  });

  it("is never live without a registry that can reload", async () => {
    const root = await tempRoot();
    const service = new AgentDefinitionService({
      home: root,
      registry: { reload: async () => false, loadedPaths: () => undefined },
    });
    expect((await service.create("global", input)).live).toBe(false);
  });
});

describe("application agent registry hot-reload", () => {
  async function app(builtins: typeof BUILTIN_PLUGINS) {
    const root = await tempRoot();
    vi.stubEnv("HOME", join(root, "home"));
    vi.stubEnv("USERPROFILE", join(root, "home"));
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    await mkdir(join(root, "ws"), { recursive: true });
    const provider: ModelProvider = {
      id: "fake",
      model: "fake-model",
      async *stream() {
        yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
      },
    };
    return createApplication({
      cwd: join(root, "ws"),
      trustProject: true,
      noHerdr: true,
      db: join(root, "state", "sessions.sqlite"),
      builtins,
      provider,
    });
  }
  const mainAgentNames = (instance: Awaited<ReturnType<typeof app>>) =>
    (instance.plugins.pluginState("subagents", "mainAgents") as Array<{ name: string }>).map(
      (a) => a.name,
    );

  it("makes a saved agent selectable without a restart", async () => {
    const instance = await app(BUILTIN_PLUGINS.filter((p) => p.id === "subagents"));
    try {
      expect(mainAgentNames(instance)).not.toContain("research-agent");
      const saved = await instance.agentDefinitions.create("project", input);
      expect(saved.live).toBe(true);
      expect(mainAgentNames(instance)).toContain("research-agent");
      const record = (
        instance.plugins.pluginState("subagents", "mainAgents") as Array<Record<string, unknown>>
      ).find((a) => a.name === "research-agent");
      expect(record).toMatchObject({ model: "openai/gpt-x", effort: "medium" });
      const global = await instance.agentDefinitions.create("global", {
        ...input,
        name: "Global Helper",
      });
      expect(global.live).toBe(true);
      expect(mainAgentNames(instance)).toContain("global-helper");
      const removed = await instance.agentDefinitions.delete("project", "research-agent");
      expect(removed.live).toBe(true);
      expect(mainAgentNames(instance)).not.toContain("research-agent");
    } finally {
      await instance.close();
    }
  });

  it("reports a restart is needed when no registry can hot-reload", async () => {
    const instance = await app([]);
    try {
      const saved = await instance.agentDefinitions.create("project", input);
      expect(saved.live).toBe(false);
      expect(saved.result.id).toBe("research-agent");
    } finally {
      await instance.close();
    }
  });
});

describe("model capabilities for the agent editor", () => {
  it("offers every option when the catalog declares nothing", () => {
    const caps = agentModelCapabilities({ id: "plain" });
    expect(caps).toEqual({
      known: false,
      reasoning: true,
      effortLevels: ["low", "medium", "high"],
      summary: true,
      verbosity: true,
      textFormats: ["text", "json_object", "json_schema"],
    });
    expect(agentModelLabels(caps)).toEqual([]);
  });

  it("follows declared effort levels, modalities and explicit false flags", () => {
    const model: ModelInfo = {
      id: "smart",
      effort: {
        supportedLevels: ["minimal", "low", "medium", "high", "xhigh"],
        defaultLevel: "medium",
      },
      inputModalities: ["text", "image"],
      capabilities: { tools: true, structured_outputs: false, verbosity: false },
    };
    const caps = agentModelCapabilities(model);
    expect(caps).toMatchObject({
      known: true,
      reasoning: true,
      effortLevels: ["minimal", "low", "medium", "high", "xhigh"],
      defaultEffort: "medium",
      verbosity: false,
      textFormats: ["text", "json_object"],
      tools: true,
      vision: true,
    });
    expect(agentModelLabels(caps)).toEqual(["Reasoning", "Tools", "Vision"]);
    const noReasoning = agentModelCapabilities({ id: "x", capabilities: { reasoning: false } });
    expect(noReasoning).toMatchObject({ reasoning: false, effortLevels: [], summary: false });
  });

  it("fits settings to what the model supports", () => {
    const caps = agentModelCapabilities({
      id: "x",
      effort: { supportedLevels: ["low", "high"], defaultLevel: "low" },
      capabilities: { json_schema: false, verbosity: false },
    });
    expect(
      fitAgentSettings(
        {
          reasoning: { effort: "medium", summary: "auto" },
          text: { format: { type: "json_schema" }, verbosity: "high" },
        },
        caps,
      ),
    ).toEqual({
      reasoning: { effort: "low", summary: "auto" },
      text: { format: { type: "text" } },
    });
    expect(
      fitAgentSettings(
        { reasoning: { effort: "high", summary: "auto" } },
        agentModelCapabilities({ id: "x", capabilities: { reasoning: false } }),
      ),
    ).toEqual({});
  });

  it("builds model options marking the active model", () => {
    const options = agentModelOptions(
      [
        {
          reference: "local/a",
          provider: "openai-compatible",
          profile: "local",
          providerName: "Local",
          model: { id: "a", capabilities: { tools: true } },
        },
        {
          reference: "local/b",
          provider: "openai-compatible",
          profile: "local",
          providerName: "Local",
          model: { id: "b" },
        },
      ],
      { profile: "local", model: "b" },
    );
    expect(options.map((o) => [o.reference, o.active, o.labels])).toEqual([
      ["local/a", false, ["Reasoning", "Tools", "Structured output"]],
      ["local/b", true, []],
    ]);
  });
});

describe("assisted agent drafts", () => {
  it("parses a fenced JSON answer and drops unknown settings", () => {
    const draft = parseAgentDraft(
      'Here you go:\n```json\n{"name":"Release Notes Writer","description":"Writes release notes.","instructions":"You write release notes.","reasoning":{"effort":"ultra","summary":"concise"},"text":{"format":{"type":"text"},"verbosity":"low"}}\n```',
      "gpt-x",
    );
    expect(draft).toEqual({
      name: "Release Notes Writer",
      description: "Writes release notes.",
      instructions: "You write release notes.",
      reasoning: { summary: "concise" },
      text: { format: { type: "text" }, verbosity: "low" },
      generatedBy: "gpt-x",
      guidance: "bundled:create-agent",
    });
  });

  it("rejects answers without a JSON object or instructions", () => {
    expect(() => parseAgentDraft("I cannot do that", "m")).toThrow("did not return");
    expect(() => parseAgentDraft('{"name":"x"}', "m")).toThrow("no instructions");
  });

  it("calls the given model once, without tools", async () => {
    const calls: Array<Parameters<ModelProvider["stream"]>[0]> = [];
    const provider: ModelProvider = {
      id: "fake",
      model: "fake-model",
      async *stream(request) {
        calls.push(request);
        const text = '{"name":"Lint Fixer","instructions":"Fix lint errors."}';
        yield { type: "completed", message: { role: "assistant", text, calls: [] } };
      },
    };
    const draft = await generateAgentDraft(provider, "fixes lint errors");
    expect(draft).toMatchObject({
      name: "Lint Fixer",
      description: "Fix lint errors.",
      generatedBy: "fake-model",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tools).toEqual([]);
    expect(calls[0]?.messages[0]).toMatchObject({
      role: "user",
      text: expect.stringContaining("fixes lint errors"),
    });
    await expect(generateAgentDraft(provider, "   ")).rejects.toThrow("Describe");
  });
});

describe("agent templates", () => {
  it("have unique ids and names and complete defaults that validate", () => {
    expect(new Set(AGENT_TEMPLATES.map((t) => t.id)).size).toBe(AGENT_TEMPLATES.length);
    expect(new Set(AGENT_TEMPLATES.map((t) => t.name)).size).toBe(AGENT_TEMPLATES.length);
    expect(AGENT_TEMPLATES.length).toBeGreaterThanOrEqual(12);
    for (const template of AGENT_TEMPLATES) {
      expect(template.instructions.length).toBeGreaterThan(100);
      expect(
        validateAgentDefinitionInput({ ...template, model: "any/model" }).ok,
        template.id,
      ).toBe(true);
    }
  });
});
