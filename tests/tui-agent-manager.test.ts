/** TUI `/agents` manager logic and `/agent:<id>` command registration (collision rule). */
import { describe, expect, it } from "vitest";
import {
  agentEditorRows,
  agentFieldChoices,
  agentPickerRows,
  applyDraft,
  decodeMultiline,
  emptyAgentForm,
  encodeMultiline,
  filterAgentRows,
  formErrors,
  formToInput,
  parseAgentsArgs,
} from "../packages/cli/src/tui/agent-manager.ts";
import {
  type ActiveAgent,
  activeAgentCatalog,
  agentCommandDescriptors,
  agentIdFromCommand,
} from "../packages/core/src/agents/active.ts";
import { agentModelCapabilities } from "../packages/core/src/agents/capabilities.ts";
import { CommandCatalog } from "../packages/core/src/commands/catalog.ts";

const roots = { workspace: "/work/app", home: "/home/me" };
const custom: ActiveAgent[] = [
  {
    id: "research-agent",
    name: "research-agent",
    description: "Investigates questions and cites sources",
    source: "user",
    path: "/work/app/.agents/agents/research-agent.md",
  },
  {
    id: "reviewer",
    name: "reviewer",
    description: "Reviews diffs for security problems",
    model: "local/qwen",
    source: "user",
    path: "/home/me/.agents/agents/reviewer.md",
  },
];

describe("/agents arguments", () => {
  it("routes manager verbs to the TUI and everything else to the subagents plugin", () => {
    expect(parseAgentsArgs("")).toEqual({ kind: "picker" });
    expect(parseAgentsArgs("new")).toEqual({ kind: "new" });
    expect(parseAgentsArgs("new reviews PRs for security")).toEqual({
      kind: "new",
      description: "reviews PRs for security",
    });
    expect(parseAgentsArgs("templates")).toEqual({ kind: "templates" });
    expect(parseAgentsArgs("manage")).toEqual({ kind: "manage" });
    expect(parseAgentsArgs("edit reviewer global")).toEqual({
      kind: "edit",
      id: "reviewer",
      scope: "global",
    });
    expect(parseAgentsArgs("delete reviewer")).toEqual({ kind: "delete", id: "reviewer" });
    expect(parseAgentsArgs("edit")).toEqual({ kind: "manage" });
    expect(parseAgentsArgs("reload")).toEqual({ kind: "plugin", args: "reload" });
    expect(parseAgentsArgs("cancel abc123")).toEqual({ kind: "plugin", args: "cancel abc123" });
  });
});

describe("agent picker", () => {
  const rows = agentPickerRows(activeAgentCatalog(custom), "reviewer", roots);

  it("shows the scope badge, the current agent and the default agent", () => {
    expect(rows.map((r) => r.label)).toEqual([
      "build [Built-in] (default)",
      "plan [Built-in] read-only",
      "research-agent [Project]",
      "reviewer [Global] (current)",
    ]);
    expect(rows[3]?.description).toBe("Reviews diffs for security problems · model: local/qwen");
  });

  it("filters by substring on name and description, every word must match", () => {
    expect(filterAgentRows(rows, "SECURITY").map((r) => r.value)).toEqual(["reviewer"]);
    expect(filterAgentRows(rows, "cites sources").map((r) => r.value)).toEqual(["research-agent"]);
    expect(filterAgentRows(rows, "global").map((r) => r.value)).toEqual(["reviewer"]);
    expect(filterAgentRows(rows, "default").map((r) => r.value)).toEqual(["build"]);
    expect(filterAgentRows(rows, "nothing-matches")).toEqual([]);
    expect(filterAgentRows(rows, "  ")).toHaveLength(rows.length);
  });
});

describe("agent editor form", () => {
  const caps = agentModelCapabilities({ id: "m", capabilities: { reasoning: false } });

  it("starts as New agent and marks unsupported settings by capability", () => {
    const form = emptyAgentForm("project", "local/m");
    expect(form.name).toBe("New agent");
    const rows = agentEditorRows(form, caps, {
      creating: true,
      scopes: ["project", "global"],
      dirty: true,
    });
    expect(rows.map((r) => r.value)).toEqual([
      "scope",
      "name",
      "description",
      "instructions",
      "model",
      "effort",
      "summary",
      "verbosity",
      "format",
      "refine",
      "save",
      "cancel",
    ]);
    expect(rows.find((r) => r.value === "effort")?.description).toBe("not supported by this model");
    expect(rows.find((r) => r.value === "verbosity")?.description).toBeUndefined();
    const editing = agentEditorRows({ ...form, id: "x" }, caps, {
      creating: false,
      scopes: ["project", "global"],
      dirty: false,
    });
    expect(editing.map((r) => r.value)).not.toContain("scope");
    expect(editing.find((r) => r.value === "save")?.description).toBe("No unsaved changes");
  });

  it("offers only the model's effort levels and formats", () => {
    const smart = agentModelCapabilities({
      id: "s",
      effort: { supportedLevels: ["low", "high"], defaultLevel: "high" },
      capabilities: { json_schema: false },
    });
    expect(agentFieldChoices("effort", smart).map((c) => c.value)).toEqual([
      "low",
      "high",
      "!clear",
    ]);
    expect(agentFieldChoices("format", smart).map((c) => c.label)).toEqual(["Text", "JSON"]);
  });

  it("fits saved settings to the capabilities and validates the form", () => {
    const form = applyDraft(emptyAgentForm("global", "local/m"), {
      name: "Release Notes",
      description: "Writes release notes",
      instructions: "You write release notes.",
      reasoning: { effort: "high", summary: "auto" },
      text: { verbosity: "low" },
      generatedBy: "m",
      guidance: "bundled:create-agent",
    });
    expect(formToInput(form, caps)).toEqual({
      name: "Release Notes",
      description: "Writes release notes",
      instructions: "You write release notes.",
      model: "local/m",
      text: { verbosity: "low" },
    });
    expect(formErrors(form)).toEqual([]);
    expect(formErrors({ ...form, model: "" })).toEqual(["Model is required"]);
  });

  it("edits multi-line instructions on one line", () => {
    const text = "Line one\nLine two with \\n literal";
    expect(encodeMultiline(text)).toBe("Line one\\nLine two with \\\\n literal");
    expect(decodeMultiline(encodeMultiline(text))).toBe(text);
  });
});

describe("agent slash commands", () => {
  it("registers /agent:<id> for every loaded agent and skips names already taken", () => {
    const descriptors = agentCommandDescriptors(
      activeAgentCatalog(custom),
      new Set(["agent:plan"]),
    );
    expect(descriptors.map((d) => d.name)).toEqual([
      "agent:build",
      "agent:research-agent",
      "agent:reviewer",
    ]);
    expect(descriptors[0]).toMatchObject({ source: "agent", execution: "surface" });
    expect(agentIdFromCommand("agent:reviewer")).toBe("reviewer");
    expect(agentIdFromCommand("agents")).toBeUndefined();
    expect(agentIdFromCommand("agent:bad id")).toBeUndefined();
  });

  it("lists agent commands after built-ins, plugin commands, prompts and skills", () => {
    const state = custom.map((a) => ({
      name: a.id,
      description: a.description,
      prompt: "x",
      source: "user",
    }));
    const handler = async () => "";
    const catalog = new CommandCatalog({
      workspace: "/w",
      store: {} as never,
      runner: {} as never,
      registry: { list: () => [] },
      provider: { id: "p" },
      plugins: {
        // A plugin with id `agent` owning `agent:reviewer` wins over the agent command.
        commands: new Map([["agent:reviewer", handler]]),
        commandInfo: new Map([["agent:reviewer", { plugin: "agent", description: "plugin cmd" }]]),
        pluginState: () => state,
      },
    });
    const names = catalog.list("web").map((c) => [c.name, c.source]);
    expect(names).toContainEqual(["agent:research-agent", "agent"]);
    expect(names).toContainEqual(["agent:reviewer", "plugin"]);
    expect(names.filter(([n]) => n === "agent:reviewer")).toHaveLength(1);
    // Built-in commands keep their names; no agent ever shadows them.
    expect(catalog.resolve("agents")?.source).toBe("builtin");
  });
});
