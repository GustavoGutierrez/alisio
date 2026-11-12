import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeAgentCatalog,
  agentCommandDescriptors,
  agentRunOptions,
  createApplication,
  cycleableAgents,
  PLUGIN_CREATOR_AGENT_ID,
  PLUGIN_CREATOR_SKILL_NAME,
  PluginCreatorProjects,
  resolveActiveAgent,
} from "../packages/core/src/index.ts";
import { fakeProvider, reply } from "./server-helpers.ts";

const apps: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllEnvs();
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "alisio-creator-app-"));
  const home = join(root, "config");
  vi.stubEnv("ALISIO_CONFIG_HOME", home);
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
  const projects = new PluginCreatorProjects({ home, sdkRange: "^0.11.0" });
  const project = await projects.create({ request: "Count words in a text" });
  const open = async (cwd: string) => {
    const app = await createApplication({
      cwd,
      db: join(root, "state", "sessions.sqlite"),
      noHerdr: true,
      home: root,
      provider: fakeProvider(() => reply("ok")),
    });
    apps.push(app);
    return app;
  };
  return { root, home, projects, project, open };
}

const context = (workspace: string): ToolContext =>
  ({ workspace, signal: new AbortController().signal }) as ToolContext;

describe("plugin creator agent", () => {
  it("resolves by id with creator instructions, but is never listed, cycled or a command", () => {
    const agent = resolveActiveAgent(activeAgentCatalog([]), PLUGIN_CREATOR_AGENT_ID);
    expect(agent.id).toBe(PLUGIN_CREATOR_AGENT_ID);
    const options = agentRunOptions(agent);
    expect(options.instructions).toContain(PLUGIN_CREATOR_SKILL_NAME);
    expect(options.instructions).toMatch(/never install/i);
    expect(options.policy).toBeUndefined();
    expect(activeAgentCatalog([]).some((a) => a.id === PLUGIN_CREATOR_AGENT_ID)).toBe(false);
    expect(cycleableAgents(activeAgentCatalog([])).map((a) => a.id)).not.toContain(
      PLUGIN_CREATOR_AGENT_ID,
    );
    expect(
      agentCommandDescriptors(activeAgentCatalog([])).some((c) => c.name.includes("creator")),
    ).toBe(false);
  });
});

describe("creator workspace wiring", () => {
  it("adds the creator skill and project tools only inside a creator project", async () => {
    const { root, projects, project, open } = await setup();
    const app = await open(projects.dir(project.id));
    expect(app.skills.items.get(PLUGIN_CREATOR_SKILL_NAME)).toBeDefined();
    const names = app.registry.list().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["plugin_project", "plugin_project_run"]));
    expect(app.registry.get("plugin_project")?.effect).toBe("internal");
    expect(app.registry.get("plugin_project_run")?.effect).toBe("process");

    const elsewhere = join(root, "other");
    await mkdir(elsewhere);
    const other = await open(elsewhere);
    expect(other.skills.items.get(PLUGIN_CREATOR_SKILL_NAME)).toBeUndefined();
    expect(other.registry.list().some((t) => t.name.startsWith("plugin_project"))).toBe(false);
  });

  it("plugin_project validates, reports stats and records progress steps", async () => {
    const { projects, project, open } = await setup();
    const dir = projects.dir(project.id);
    const app = await open(dir);
    const tool = app.registry.get("plugin_project");
    const validate = await tool?.execute({ action: "validate" }, context(dir));
    expect(
      JSON.parse(validate?.content[0]?.type === "text" ? validate.content[0].text : ""),
    ).toMatchObject({ ok: true });
    const stats = await tool?.execute({ action: "stats" }, context(dir));
    expect(stats?.content[0]).toMatchObject({ type: "text" });
    await tool?.execute(
      { action: "progress", step: "tests", status: "running", note: "Writing tests" },
      context(dir),
    );
    expect((await projects.get(project.id)).progress?.steps[1]).toMatchObject({
      id: "tests",
      status: "running",
      note: "Writing tests",
    });
    const bad = await tool?.execute(
      { action: "progress", step: "deploy", status: "done" },
      context(dir),
    );
    expect(bad?.isError).toBe(true);
  });

  it("plugin_project_run builds the package", async () => {
    const { projects, project, open } = await setup();
    const dir = projects.dir(project.id);
    const app = await open(dir);
    const result = await app.registry
      .get("plugin_project_run")
      ?.execute({ action: "build" }, context(dir));
    const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
    expect(JSON.parse(text)).toMatchObject({ ok: true });
    expect(await projects.packagePath(project.id)).toBeDefined();
  });
});
