/**
 * Agents window API: `.agents/agents` CRUD over HTTP (project and global scope), hot-reload of
 * the agent registry, templates, models, assisted drafts, `/agent:<id>` activation and the
 * create → new session flow.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuiltinPlugin } from "@alisio/core";
import {
  type AgentDefinitionInfo,
  type AgentDefinitionsOverview,
  type AgentDraft,
  type AgentInfo,
  type AgentModelOption,
  type AgentSaveResult,
  type AgentTemplateInfo,
  type CommandDescriptor,
  definePlugin,
  type SessionSummary,
} from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_PLUGINS } from "../packages/cli/src/builtin.ts";
import {
  fakeProvider,
  newSession,
  reply,
  settled,
  startTestServer,
  type TestServer,
} from "./server-helpers.ts";

const DRAFT = JSON.stringify({
  name: "Changelog Writer",
  description: "Writes changelog entries.",
  instructions: "You write concise changelog entries from git history.",
  reasoning: { effort: "low", summary: "none" },
  text: { format: { type: "text" }, verbosity: "low" },
});

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function start(
  options: {
    subagents?: boolean;
    readOnly?: boolean;
    trusted?: boolean;
    extraBuiltins?: BuiltinPlugin[];
  } = {},
) {
  const provider = fakeProvider((request) =>
    reply(request.instructions.includes("Writing agent instructions") ? DRAFT : "ok"),
  );
  const home = await mkdtemp(join(tmpdir(), "alisio-agents-home-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  t = await startTestServer({
    provider,
    app: {
      ...(options.readOnly ? { readOnly: true } : {}),
      ...(options.trusted === false ? {} : { trustProject: true }),
      builtins: [
        ...(options.subagents === false ? [] : BUILTIN_PLUGINS.filter((p) => p.id === "subagents")),
        ...(options.extraBuiltins ?? []),
      ],
    },
  });
  const wid = (await t.api.get("/api/workspaces")).json<Array<{ id: string }>>()[0]?.id ?? "";
  return { t, wid, provider, home };
}

const body = {
  name: "Research Agent",
  description: "Researches questions",
  instructions: "You are RESEARCH-AGENT-MARKER. Cite sources.",
  model: "fake-model",
  reasoning: { effort: "medium", summary: "auto" },
  text: { format: { type: "text" }, verbosity: "high" },
};

describe("agent definitions API", () => {
  it("creates a project agent file, hot-reloads it and exposes it as /agent:<id>", async () => {
    const { t, wid } = await start();
    const overview = (
      await t.api.get(`/api/agents/definitions?workspace=${wid}`)
    ).json<AgentDefinitionsOverview>();
    expect(overview).toMatchObject({
      agents: [],
      scopes: ["project", "global"],
      defaultScope: "project",
      dirs: { project: join(t.workspace, ".agents", "agents") },
      trusted: true,
    });
    const created = await t.api.post("/api/agents", { workspace: wid, ...body });
    expect(created.status).toBe(201);
    const saved = created.json<AgentSaveResult>();
    expect(saved.live).toBe(true);
    expect(saved.agent).toMatchObject({
      id: "research-agent",
      scope: "project",
      model: "fake-model",
    });
    const file = await readFile(
      join(t.workspace, ".agents", "agents", "research-agent.md"),
      "utf8",
    );
    expect(file).toContain("name: research-agent");
    expect(file).toContain("You are RESEARCH-AGENT-MARKER.");
    // The running server already offers it: agent presets and the slash-command catalog.
    const presets = (await t.api.get(`/api/agents?workspace=${wid}`)).json<AgentInfo[]>();
    expect(presets.map((a) => a.id)).toContain("research-agent");
    const commands = (await t.api.get(`/api/commands?workspace=${wid}`)).json<
      CommandDescriptor[]
    >();
    expect(commands.find((c) => c.name === "agent:research-agent")).toMatchObject({
      source: "agent",
      execution: "surface",
    });
    expect(commands.find((c) => c.name === "agent:build")).toBeDefined();

    const got = await t.api.get(`/api/agents/research-agent?workspace=${wid}&scope=project`);
    expect(got.json<AgentDefinitionInfo>().name).toBe("Research Agent");
    const updated = await t.api.put(`/api/agents/research-agent`, {
      workspace: wid,
      scope: "project",
      ...body,
      name: "Deep Research",
    });
    expect(updated.json<AgentSaveResult>()).toMatchObject({
      live: true,
      agent: { id: "research-agent", name: "Deep Research" },
    });
    const removed = await t.api.delete(`/api/agents/research-agent?workspace=${wid}&scope=project`);
    expect(removed.json()).toEqual({ deleted: true, live: true });
    expect(existsSync(join(t.workspace, ".agents", "agents", "research-agent.md"))).toBe(false);
    const after = (await t.api.get(`/api/agents?workspace=${wid}`)).json<AgentInfo[]>();
    expect(after.map((a) => a.id)).not.toContain("research-agent");
    const missing = await t.api.get(`/api/agents/research-agent?workspace=${wid}&scope=project`);
    expect(missing.status).toBe(404);
  });

  it("writes global agents under ~/.agents/agents and marks project overrides", async () => {
    const { t, wid, home } = await start();
    const global = await t.api.post("/api/agents", { scope: "global", ...body });
    expect(global.status).toBe(201);
    expect(existsSync(join(home, ".agents", "agents", "research-agent.md"))).toBe(true);
    await t.api.post("/api/agents", { workspace: wid, scope: "project", ...body });
    const { agents } = (
      await t.api.get(`/api/agents/definitions?workspace=${wid}`)
    ).json<AgentDefinitionsOverview>();
    expect(agents.map((a) => [a.scope, !!a.overridesGlobal, !!a.overriddenByProject])).toEqual([
      ["project", true, false],
      ["global", false, true],
    ]);
    const noWorkspace = (
      await t.api.get("/api/agents/definitions")
    ).json<AgentDefinitionsOverview>();
    expect(noWorkspace).toMatchObject({ scopes: ["global"], defaultScope: "global" });
    const refused = await t.api.post("/api/agents", { scope: "project", ...body });
    expect(refused.status).toBe(400);
  });

  it("validates bodies and reports the invalid fields", async () => {
    const { t, wid } = await start();
    const res = await t.api.post("/api/agents", {
      workspace: wid,
      name: "",
      model: "",
      text: { verbosity: "loud" },
    });
    expect(res.status).toBe(400);
    expect(res.json<{ error: { details: { fields: string[] } } }>().error.details.fields).toEqual(
      expect.arrayContaining(["name", "model", "text.verbosity"]),
    );
  });

  it("refuses writes under --read-only", async () => {
    const { t, wid } = await start({ readOnly: true });
    const res = await t.api.post("/api/agents", { workspace: wid, ...body });
    expect(res.status).toBe(403);
  });

  it("says the change is not live when no registry can hot-reload it", async () => {
    const { t, wid } = await start({ subagents: false });
    const saved = (
      await t.api.post("/api/agents", { workspace: wid, ...body })
    ).json<AgentSaveResult>();
    expect(saved).toMatchObject({ live: false, agent: { id: "research-agent" } });
  });

  it("serves templates and the configured models with capabilities", async () => {
    const { t, wid } = await start();
    const templates = (await t.api.get("/api/agents/templates")).json<AgentTemplateInfo[]>();
    expect(templates.map((x) => x.id)).toEqual(
      expect.arrayContaining(["code-reviewer", "research-agent", "analytics-agent"]),
    );
    const models = (await t.api.get(`/api/agents/models?workspace=${wid}`)).json<
      AgentModelOption[]
    >();
    expect(models[0]).toMatchObject({
      id: "fake-model",
      active: true,
      capabilities: { known: false, reasoning: true },
    });
  });

  it("drafts an agent with the active model and the bundled create-agent guidance", async () => {
    const { t, wid, provider } = await start();
    const res = await t.api.post("/api/agents/draft", {
      workspace: wid,
      description: "writes changelog entries",
    });
    expect(res.status).toBe(200);
    expect(res.json<AgentDraft>()).toMatchObject({
      name: "Changelog Writer",
      generatedBy: "fake-model",
      guidance: "bundled:create-agent",
      reasoning: { effort: "low" },
    });
    const call = provider.calls.at(-1);
    expect(call?.tools).toEqual([]);
    expect(call?.instructions).toContain("Writing agent instructions");
    const refine = await t.api.post("/api/agents/draft", {
      workspace: wid,
      base: { name: "Code Reviewer", instructions: "Review diffs." },
      description: "focus on security",
    });
    expect(refine.status).toBe(200);
    expect(provider.calls.at(-1)?.messages[0]).toMatchObject({
      text: expect.stringContaining("Requested changes: focus on security"),
    });
    const empty = await t.api.post("/api/agents/draft", { workspace: wid, description: " " });
    expect(empty.status).toBe(400);
  });

  it("uses a discovered create-agent skill as the authoring guidance", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const home = await mkdtemp(join(tmpdir(), "alisio-agents-home-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    await mkdir(join(home, ".agents", "skills", "create-agent"), { recursive: true });
    await writeFile(
      join(home, ".agents", "skills", "create-agent", "SKILL.md"),
      "---\nname: create-agent\ndescription: Team agent conventions\n---\nTEAM-AUTHORING-RULES",
    );
    const provider = fakeProvider(() => reply(DRAFT));
    t = await startTestServer({ provider, app: { trustProject: true, builtins: [] } });
    const wid = (await t.api.get("/api/workspaces")).json<Array<{ id: string }>>()[0]?.id ?? "";
    const res = await t.api.post("/api/agents/draft", { workspace: wid, description: "x" });
    expect(res.json<AgentDraft>().guidance).toBe("skill:create-agent");
    expect(provider.calls.at(-1)?.instructions).toContain("TEAM-AUTHORING-RULES");
  });
});

describe("plugin-contributed agents", () => {
  /** A plugin contributing an agents directory through `api.resources.agents`. */
  const pluginWith = (dir: string): BuiltinPlugin => ({
    id: "evalua",
    name: "Evaluia",
    description: "Contributes its own agents",
    create: () =>
      definePlugin({
        id: "evalua",
        name: "Evaluia",
        version: "0.6.1",
        apiVersion: 1,
        setup(api) {
          api.resources.agents(dir);
        },
      }),
  });

  it("lists the plugin primary agents on the first /api/agents load (no definitions request)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alisio-plugin-agents-"));
    await writeFile(
      join(dir, "coordinator.md"),
      "---\nname: coordinator\ndescription: Coordinates the run\nmode: primary\n---\nCoordinate.\n",
    );
    // A subagent of the same plugin stays out of the main selector (by design).
    await writeFile(
      join(dir, "worker.md"),
      "---\nname: worker\ndescription: Delegated worker\nmode: subagent\n---\nWork.\n",
    );
    const { t, wid } = await start({ extraBuiltins: [pluginWith(dir)] });
    // The plugin activates AFTER the built-in subagents plugin discovered agents at startup, so
    // the server must rediscover once every plugin registered: no Agents-window visit needed.
    const agents = (await t.api.get(`/api/agents?workspace=${wid}`)).json<AgentInfo[]>();
    expect(agents.map((a) => a.id)).toEqual(["build", "plan", "evalua:coordinator"]);
  });
});

describe("workspace trust from the web", () => {
  it("trusts a workspace after confirmation so its saved project agents load", async () => {
    const { t, wid } = await start({ trusted: false });
    const pending = (
      await t.api.post("/api/agents", { workspace: wid, ...body })
    ).json<AgentSaveResult>();
    // Untrusted: the file is saved, but the running registry does not load project agents.
    expect(pending.live).toBe(false);
    const listed = (await t.api.get("/api/workspaces")).json<
      Array<{ id: string; trusted: boolean; untrustedResources: boolean }>
    >();
    expect(listed.find((w) => w.id === wid)).toMatchObject({
      trusted: false,
      untrustedResources: true,
    });
    const unconfirmed = await t.api.post(`/api/workspaces/${wid}/trust`, { trusted: true });
    expect(unconfirmed.status).toBe(400);
    const trusted = await t.api.post(`/api/workspaces/${wid}/trust`, {
      trusted: true,
      confirmed: true,
    });
    expect(trusted.status).toBe(200);
    expect(trusted.json()).toMatchObject({ id: wid, trusted: true, untrustedResources: false });
    const presets = (await t.api.get(`/api/agents?workspace=${wid}`)).json<AgentInfo[]>();
    expect(presets.map((a) => a.id)).toContain("research-agent");
    const next = (
      await t.api.post("/api/agents", { workspace: wid, ...body, name: "Second" })
    ).json<AgentSaveResult>();
    expect(next.live).toBe(true);
    // Withdrawing trust unloads them again.
    await t.api.post(`/api/workspaces/${wid}/trust`, { trusted: false, confirmed: true });
    const after = (await t.api.get(`/api/agents?workspace=${wid}`)).json<AgentInfo[]>();
    expect(after.map((a) => a.id)).not.toContain("research-agent");
  });

  it("loads the first project agent of a workspace trusted before it had any", async () => {
    const { t, wid } = await start({ trusted: false });
    const trusted = await t.api.post(`/api/workspaces/${wid}/trust`, {
      trusted: true,
      confirmed: true,
    });
    expect(trusted.status).toBe(200);
    const saved = (
      await t.api.post("/api/agents", { workspace: wid, ...body })
    ).json<AgentSaveResult>();
    expect(saved.live).toBe(true);
  });

  it("refuses trust changes under --read-only", async () => {
    const { t, wid } = await start({ trusted: false, readOnly: true });
    const res = await t.api.post(`/api/workspaces/${wid}/trust`, {
      trusted: true,
      confirmed: true,
    });
    expect(res.status).toBe(403);
  });
});

describe("agent activation in sessions", () => {
  const instructionsOfLastCall = (provider: ReturnType<typeof fakeProvider>) =>
    provider.calls.at(-1)?.instructions ?? "";

  it("starts a new session with a just-created agent (create → try it)", async () => {
    const { t, wid, provider } = await start();
    const { agent } = (
      await t.api.post("/api/agents", { workspace: wid, ...body })
    ).json<AgentSaveResult>();
    // The agent's model is the running one here, so the session keeps the default binding.
    const session = await newSession(t, { agent: agent.id });
    expect(session.agent).toBe("research-agent");
    await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "hi" });
    await settled(t, session.id);
    expect(instructionsOfLastCall(provider)).toContain("RESEARCH-AGENT-MARKER");
    expect(provider.calls.at(-1)?.reasoningEffort).toBe("medium");
    const filtered = (await t.api.get(`/api/sessions?agent=research-agent&archived=all`)).json<{
      items: SessionSummary[];
    }>();
    expect(filtered.items.map((s) => s.id)).toEqual([session.id]);
  });

  it("activates an agent with /agent:<id> from the next prompt and returns to the default", async () => {
    const { t, wid, provider } = await start();
    await t.api.post("/api/agents", { workspace: wid, ...body });
    const session = await newSession(t);
    await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "a", text: "one" });
    await settled(t, session.id);
    expect(instructionsOfLastCall(provider)).not.toContain("RESEARCH-AGENT-MARKER");

    const activated = await t.api.post(`/api/sessions/${session.id}/commands`, {
      requestId: "c1",
      name: "agent:research-agent",
    });
    expect(activated.status).toBe(200);
    expect(activated.json()).toMatchObject({ tone: "notice", effects: ["agent"] });
    expect((await t.api.get(`/api/sessions/${session.id}`)).json<{ agent: string }>().agent).toBe(
      "research-agent",
    );
    await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "b", text: "two" });
    await settled(t, session.id);
    expect(instructionsOfLastCall(provider)).toContain("RESEARCH-AGENT-MARKER");

    await t.api.post(`/api/sessions/${session.id}/commands`, {
      requestId: "c2",
      name: "agent:build",
    });
    await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "c", text: "three" });
    await settled(t, session.id);
    expect(instructionsOfLastCall(provider)).not.toContain("RESEARCH-AGENT-MARKER");

    const unknown = await t.api.post(`/api/sessions/${session.id}/commands`, {
      requestId: "c3",
      name: "agent:nope",
    });
    expect(unknown.status).toBe(404);
  });
});
