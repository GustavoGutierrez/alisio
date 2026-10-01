/** Web Agents window state: form, capability fitting, save rules, config snippet, steps, filter. */
import type { AgentDefinitionInfo, AgentInfo, AgentModelOption } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { en } from "../packages/web/src/i18n/en.ts";
import { es } from "../packages/web/src/i18n/es.ts";
import { ApiClient } from "../packages/web/src/net/api.ts";
import {
  agentConfigSnippet,
  canSave,
  capabilitiesFor,
  emptyForm,
  filterAgents,
  fitForm,
  formFromDefinition,
  formFromDraft,
  formToInput,
  gettingStartedSteps,
  PERMISSIVE,
  presetScope,
  tokenize,
} from "../packages/web/src/store/agents.ts";

const definition: AgentDefinitionInfo = {
  id: "research-agent",
  scope: "project",
  name: "Research Agent",
  description: "Researches",
  instructions: "You research.",
  model: "local/qwen",
  reasoning: { effort: "high", summary: "auto" },
  text: { format: { type: "json_object" }, verbosity: "low" },
  path: "/w/.agents/agents/research-agent.md",
  createdAt: 1,
  updatedAt: 2,
};

describe("agent form", () => {
  it("starts as New agent and maps every field to the API body", () => {
    const form = emptyForm("project", "local/qwen");
    expect(form).toMatchObject({ name: "New agent", format: "text", scope: "project" });
    expect(formToInput(formFromDefinition(definition))).toEqual({
      name: "Research Agent",
      description: "Researches",
      instructions: "You research.",
      model: "local/qwen",
      reasoning: { effort: "high", summary: "auto" },
      text: { format: { type: "json_object" }, verbosity: "low" },
    });
  });

  it("enables save only for a valid, model-backed form with unsaved changes", () => {
    const saved = formFromDefinition(definition);
    expect(canSave(saved, saved)).toBe(false);
    expect(canSave({ ...saved, instructions: "Changed" }, saved)).toBe(true);
    expect(canSave({ ...saved, name: "  " }, saved)).toBe(false);
    expect(canSave({ ...saved, name: "!!!" }, saved)).toBe(false);
    expect(canSave({ ...emptyForm("global"), model: "" }, undefined)).toBe(false);
    expect(canSave(emptyForm("global", "m"), undefined)).toBe(true);
  });

  it("fits settings to the selected model's capabilities", () => {
    const models: AgentModelOption[] = [
      {
        reference: "local/plain",
        provider: "openai-compatible",
        profile: "local",
        providerName: "Local",
        id: "plain",
        active: true,
        capabilities: {
          known: true,
          reasoning: false,
          effortLevels: [],
          summary: false,
          verbosity: false,
          textFormats: ["text"],
        },
        labels: [],
      },
    ];
    const caps = capabilitiesFor(models, "local/plain");
    expect(fitForm(formFromDefinition(definition), caps)).toMatchObject({
      effort: "",
      summary: "",
      verbosity: "",
      format: "text",
    });
    expect(capabilitiesFor(models, "unknown/model")).toBe(PERMISSIVE);
  });

  it("applies a model draft without touching scope, id or model", () => {
    const next = formFromDraft(formFromDefinition(definition), {
      name: "Better",
      description: "d",
      instructions: "i",
      generatedBy: "m",
      guidance: "bundled:create-agent",
    });
    expect(next).toMatchObject({
      id: "research-agent",
      scope: "project",
      model: "local/qwen",
      name: "Better",
      effort: "",
      format: "text",
    });
  });
});

describe("agent config snippet", () => {
  it("shows Alisio's own POST /api/agents for a new agent, PUT for a saved one", () => {
    const snippet = agentConfigSnippet(emptyForm("project", "local/qwen"), {
      origin: "http://127.0.0.1:4096",
      workspace: "w1",
    });
    expect(snippet.split("\n")[0]).toBe("curl -X POST http://127.0.0.1:4096/api/agents \\");
    expect(snippet).toContain('-H "Origin: http://127.0.0.1:4096"');
    expect(snippet).toContain("alisio_session_4096=");
    const body = JSON.parse(snippet.slice(snippet.indexOf("'") + 1, snippet.lastIndexOf("'")));
    expect(body).toEqual({
      workspace: "w1",
      scope: "project",
      name: "New agent",
      model: "local/qwen",
      text: { format: { type: "text" } },
    });
    const saved = agentConfigSnippet(formFromDefinition(definition), {
      origin: "http://localhost:9000",
    });
    expect(saved).toContain("-X PUT http://localhost:9000/api/agents/research-agent");
    expect(saved).toContain('"effort": "high"');
    expect(saved).toContain('"verbosity": "low"');
  });

  it("escapes single quotes for the shell", () => {
    const snippet = agentConfigSnippet(
      { ...emptyForm("global", "m"), instructions: "Don't guess" },
      { origin: "http://127.0.0.1:1" },
    );
    expect(snippet).toContain("Don'\\''t guess");
  });

  it("tokenizes JSON keys, strings and curl words for highlighting", () => {
    expect(tokenize('  "name": "x",')).toEqual([
      { kind: "plain", text: "  " },
      { kind: "key", text: '"name"' },
      { kind: "punct", text: ":" },
      { kind: "plain", text: " " },
      { kind: "string", text: '"x"' },
      { kind: "punct", text: "," },
    ]);
    expect(tokenize("curl -X POST").map((t) => t.kind)).toEqual([
      "command",
      "plain",
      "command",
      "plain",
    ]);
  });
});

describe("getting started steps", () => {
  it("completes steps from real state only", () => {
    const done = (state: Parameters<typeof gettingStartedSteps>[0]) =>
      gettingStartedSteps(state).map((s) => s.done);
    expect(done({ saved: false, workspace: true, sessions: [] })).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect(done({ saved: true, workspace: true, sessions: [{}] })).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(done({ saved: true, workspace: true, sessions: [{ title: "hi" }] })).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});

describe("agent picker filter", () => {
  const agents: AgentInfo[] = [
    {
      id: "build",
      name: "build",
      description: "Default full-power agent",
      source: "builtin",
      default: true,
    },
    {
      id: "research-agent",
      name: "research-agent",
      description: "Cites sources",
      source: "user",
      default: false,
    },
    {
      id: "reviewer",
      name: "reviewer",
      description: "Security review",
      source: "user",
      default: false,
    },
  ];

  it("matches every word against id, name and description, case-insensitively", () => {
    expect(filterAgents(agents, "SECURITY").map((a) => a.id)).toEqual(["reviewer"]);
    expect(filterAgents(agents, "cites sources").map((a) => a.id)).toEqual(["research-agent"]);
    expect(filterAgents(agents, "agent").map((a) => a.id)).toEqual(["build", "research-agent"]);
    expect(filterAgents(agents, "")).toHaveLength(3);
    expect(filterAgents(agents, "zzz")).toEqual([]);
  });

  it("badges user agents by their definition scope (project wins)", () => {
    const global = { ...definition, scope: "global" as const };
    expect(presetScope(agents[1] as AgentInfo, [global, definition])).toBe("project");
    expect(presetScope(agents[1] as AgentInfo, [global])).toBe("global");
    expect(presetScope(agents[0] as AgentInfo, [definition])).toBeUndefined();
  });
});

describe("agents API client", () => {
  it("sends scope and workspace with writes and aborts drafts", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new ApiClient({
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (init.signal?.aborted) throw new Error("aborted");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    await client.createAgent({ workspace: "w1", scope: "project", name: "A", model: "m" });
    await client.deleteAgent("a", "global", "w1");
    await client.agentSessions("a");
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["POST", "/api/agents"],
      ["DELETE", "/api/agents/a?scope=global&workspace=w1"],
      ["GET", "/api/sessions?agent=a&archived=all&limit=50"],
    ]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.draftAgent({ workspace: "w1", description: "x" }, controller.signal),
    ).rejects.toMatchObject({ code: "network" });
  });
});

describe("agents i18n", () => {
  it("has every new key in both locales", () => {
    const keys = Object.keys(en).filter(
      (k) => k.startsWith("agentsWin.") || k === "sidebar.agents",
    );
    expect(keys.length).toBeGreaterThan(80);
    for (const key of keys) expect(es[key as keyof typeof es], key).toBeTruthy();
  });
});

describe("scope paths", () => {
  it("shortens long paths from the left and keeps short ones", async () => {
    const { scopeDirLabel, shortPath } = await import("../packages/web/src/store/agents.ts");
    expect(shortPath("/w/.agents/agents")).toBe("/w/.agents/agents");
    const long = "/home/someone/Documents/Projects/Personal/very-long-project/.agents/agents";
    const short = shortPath(long);
    expect(short.startsWith("…/")).toBe(true);
    expect(short.endsWith("very-long-project/.agents/agents")).toBe(true);
    expect(short.length).toBeLessThanOrEqual(36);
    expect(shortPath(`/${"x".repeat(80)}`, 20)).toHaveLength(20);
    expect(scopeDirLabel("global", "/home/someone/.agents/agents")).toBe("~/.agents/agents");
    expect(scopeDirLabel("global", "C:\\Users\\me\\.agents\\agents")).toBe("~\\.agents\\agents");
    expect(scopeDirLabel("project", long)).toBe(short);
  });
});
