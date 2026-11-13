import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { McpOverview } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApplication,
  loadConfig,
  loadConfigWithProvenance,
} from "../packages/core/src/index.ts";
import {
  McpConfigError,
  readMcpConfigRevision,
  removeMcpServer,
  setMcpServerEnabled,
  writeMcpServer,
} from "../packages/core/src/mcp/config-writer.ts";
import { createProjectOverride, previewMcpRemoval } from "../packages/core/src/mcp/scopes.ts";
import { hashProjectConfig, resolveTrust, setTrust } from "../packages/core/src/trust.ts";
import { startTestServer } from "./server-helpers.ts";

afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alisio-mcp-scopes-")));
  const global = join(root, "global");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".alisio"), { recursive: true });
  await mkdir(global, { recursive: true });
  vi.stubEnv("ALISIO_CONFIG_HOME", global);
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
  return {
    root,
    global,
    workspace,
    globalFile: join(global, "config.json"),
    projectFile: join(workspace, ".alisio", "config.json"),
  };
}

async function json(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
const read = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const stdio = (command: string, extra: Record<string, unknown> = {}) => ({
  transport: "stdio",
  command,
  ...extra,
});

/** Stores trust for the project config exactly as the web/terminal prompt would. */
async function trust(workspace: string) {
  await setTrust(workspace, true, await hashProjectConfig(workspace));
}

describe("MCP-CAT-06: global and project writes", () => {
  it("writes a global entry to the user config and a project entry to the workspace config", async () => {
    const { workspace, globalFile, projectFile } = await fixture();
    await json(projectFile, {});
    await trust(workspace);
    await writeMcpServer({ target: { scope: "global" }, name: "shared", server: stdio("node") });
    await writeMcpServer({
      target: { scope: "project", workspace },
      name: "local",
      server: stdio("node"),
    });
    expect(Object.keys((await read(globalFile)).mcp.servers)).toEqual(["shared"]);
    expect(Object.keys((await read(projectFile)).mcp.servers)).toEqual(["local"]);
    const loaded = await loadConfig(workspace, { trustProject: true });
    expect(loaded.mcpSources.shared).toMatchObject({ kind: "global", file: globalFile });
    expect(loaded.mcpSources.local).toMatchObject({ kind: "project", file: projectFile });
  });

  it("lets a project override win, announces what removing it reveals, then reveals the global", async () => {
    const { workspace, globalFile, projectFile } = await fixture();
    await json(globalFile, {
      mcpServers: {
        shared: { command: "node", args: ["a.js"], env: { TOKEN_LITERAL: "s3cret" } },
      },
    });
    await json(projectFile, {});
    await trust(workspace);

    await createProjectOverride({ workspace, name: "shared" });
    const overridden = await loadConfigWithProvenance(workspace, { trustProject: true });
    expect(overridden.config.mcpSources.shared?.kind).toBe("project");
    expect(overridden.config.mcp.servers.shared).toMatchObject({ enabled: false });
    expect(overridden.config.mcpShadowed?.shared).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({ kind: "global" }),
        enabled: true,
      }),
    ]);
    // The override is minimal: the literal env value of the global entry is never copied.
    expect(JSON.stringify(await read(projectFile))).not.toContain("s3cret");
    // The global file is untouched.
    expect((await read(globalFile)).mcpServers.shared.env.TOKEN_LITERAL).toBe("s3cret");

    const preview = await previewMcpRemoval({ workspace, name: "shared", scope: "project" });
    expect(preview).toMatchObject({ revealsGlobal: true, revealed: { enabled: true } });

    await removeMcpServer({ target: { scope: "project", workspace }, name: "shared" });
    const revealed = await loadConfig(workspace, { trustProject: true });
    expect(revealed.mcpSources.shared?.kind).toBe("global");
    expect(revealed.mcp.servers.shared?.enabled).toBe(true);
  });

  it("does not announce a reveal when no global entry exists, or when removing the global one", async () => {
    const { workspace, projectFile } = await fixture();
    await json(projectFile, { mcp: { servers: { only: stdio("node") } } });
    expect(await previewMcpRemoval({ workspace, name: "only", scope: "project" })).toMatchObject({
      revealsGlobal: false,
    });
    expect(await previewMcpRemoval({ workspace, name: "only", scope: "global" })).toMatchObject({
      revealsGlobal: false,
    });
  });
});

describe("MCP-CAT-28: trust follows project writes", () => {
  it("keeps a trusted project trusted after an installer write and after the enable switch", async () => {
    const { workspace, projectFile } = await fixture();
    await json(projectFile, { mcp: { servers: { first: stdio("node") } } });
    await trust(workspace);
    await writeMcpServer({
      target: { scope: "project", workspace },
      name: "second",
      server: stdio("node"),
    });
    expect(await resolveTrust(workspace)).toMatchObject({ trusted: true, needsPrompt: false });

    const app = await createApplication({ cwd: workspace, trustProject: true, noHerdr: true });
    try {
      await app.setMcpEnabled("first", false);
      expect((await read(projectFile)).mcp.servers.first.enabled).toBe(false);
      expect(await resolveTrust(workspace)).toMatchObject({ trusted: true, needsPrompt: false });
    } finally {
      await app.close();
    }
  });

  it("rejects a write to an untrusted project with mcp_scope_untrusted and changes nothing", async () => {
    const { workspace, projectFile } = await fixture();
    await json(projectFile, { mcp: { servers: { first: stdio("node") } } });
    const before = await readFile(projectFile, "utf8");
    const attempt = writeMcpServer({
      target: { scope: "project", workspace },
      name: "second",
      server: stdio("node"),
    });
    await expect(attempt).rejects.toMatchObject({ code: "mcp_scope_untrusted" });
    await expect(attempt).rejects.toBeInstanceOf(McpConfigError);
    expect(await readFile(projectFile, "utf8")).toBe(before);
    // The trust state is not created as a side effect of a refused write.
    expect(await resolveTrust(workspace)).toMatchObject({ trusted: false, needsPrompt: true });
  });

  it("does not seal trust for a one-run trusted project without a stored decision", async () => {
    const { workspace, projectFile } = await fixture();
    await json(projectFile, {});
    await writeMcpServer({
      target: { scope: "project", workspace, sessionTrusted: true },
      name: "second",
      server: stdio("node"),
    });
    expect((await read(projectFile)).mcp.servers.second).toBeDefined();
    expect((await resolveTrust(workspace)).trusted).toBe(false);
  });
});

describe("MCP-CAT-07: no execution without consent, trust or write access", () => {
  it("enabling and listing never starts a server; read-only blocks every change", async () => {
    const { root, workspace, globalFile } = await fixture();
    const marker = join(root, "started");
    await json(globalFile, {
      mcp: {
        servers: {
          probe: stdio(process.execPath, {
            args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`],
            enabled: false,
          }),
        },
      },
    });
    const app = await createApplication({ cwd: workspace, noHerdr: true });
    try {
      expect(app.mcpRuntimePermission()).toBe("not-granted");
      expect(app.mcp.list().map((s) => s.name)).toEqual(["probe"]);
      // Persisting the switch without consent never spawns the command, even when asked to connect.
      await app.setMcpEnabled("probe", true, true);
      expect(app.mcp.info("probe").status).not.toBe("connected");
      await new Promise((r) => setTimeout(r, 200));
      await expect(readFile(marker)).rejects.toThrow();
    } finally {
      await app.close();
    }
    const readOnly = await createApplication({ cwd: workspace, readOnly: true, noHerdr: true });
    try {
      await expect(readOnly.setMcpEnabled("probe", false)).rejects.toThrow("--read-only");
      expect((await read(globalFile)).mcp.servers.probe.enabled).toBe(true);
    } finally {
      await readOnly.close();
    }
  });

  it("a project layer can never grant mcp.allow", async () => {
    const { workspace, projectFile } = await fixture();
    await json(projectFile, { mcp: { allow: true, servers: {} } });
    expect((await loadConfig(workspace, { trustProject: true })).mcp.allow).not.toBe(true);
  });
});

describe("shared config writer (D16)", () => {
  it("preserves unrelated fields and the alias or canonical form of existing entries", async () => {
    const { globalFile } = await fixture();
    await json(globalFile, {
      skills: ["./keep"],
      mcpServers: { manual: { command: "node", env: { KEEP: "1" } } },
    });
    await writeMcpServer({ target: { scope: "global" }, name: "added", server: stdio("node") });
    const raw = await read(globalFile);
    expect(raw.skills).toEqual(["./keep"]);
    expect(raw.mcpServers.manual).toEqual({ command: "node", env: { KEEP: "1" } });
    // A file that uses the alias form keeps receiving entries in that form.
    expect(raw.mcpServers.added).toMatchObject({ transport: "stdio", command: "node" });
    expect(raw.mcp).toBeUndefined();
  });

  it("returns mcp_config_conflict instead of overwriting an external edit", async () => {
    const { globalFile } = await fixture();
    await json(globalFile, { mcp: { servers: { a: stdio("node") } } });
    const revision = await readMcpConfigRevision({ scope: "global" });
    await json(globalFile, { mcp: { servers: { a: stdio("node"), manual: stdio("node") } } });
    await expect(
      writeMcpServer({
        target: { scope: "global" },
        name: "b",
        server: stdio("node"),
        expectedRevision: revision,
      }),
    ).rejects.toMatchObject({ code: "mcp_config_conflict" });
    expect(Object.keys((await read(globalFile)).mcp.servers)).toEqual(["a", "manual"]);
    // Without an expected revision the write merges onto the latest content, never the old one.
    await writeMcpServer({ target: { scope: "global" }, name: "b", server: stdio("node") });
    expect(Object.keys((await read(globalFile)).mcp.servers)).toEqual(["a", "manual", "b"]);
  });

  it("serializes concurrent writes so no entry is lost", async () => {
    const { globalFile } = await fixture();
    await json(globalFile, {});
    const names = ["a", "b", "c", "d", "e", "f"];
    await Promise.all(
      names.map((name) =>
        writeMcpServer({ target: { scope: "global" }, name, server: stdio("node") }),
      ),
    );
    expect(Object.keys((await read(globalFile)).mcp.servers).sort()).toEqual(names);
  });

  it("rejects an invalid server definition and an invalid name without touching the file", async () => {
    const { globalFile } = await fixture();
    await json(globalFile, {});
    const before = await readFile(globalFile, "utf8");
    await expect(
      writeMcpServer({ target: { scope: "global" }, name: "x", server: { transport: "stdio" } }),
    ).rejects.toMatchObject({ code: "mcp_config_invalid" });
    await expect(
      writeMcpServer({ target: { scope: "global" }, name: "io.x/bad", server: stdio("node") }),
    ).rejects.toMatchObject({ code: "mcp_config_invalid" });
    expect(await readFile(globalFile, "utf8")).toBe(before);
  });

  it("keeps the legacy toggle behaviour of setMcpServerEnabled", async () => {
    const { workspace, globalFile } = await fixture();
    await json(globalFile, { mcpServers: { local: { command: "node", env: { A: "b" } } } });
    const loaded = await loadConfig(workspace);
    await setMcpServerEnabled({ source: loaded.mcpSources.local!, name: "local", enabled: false });
    expect((await read(globalFile)).mcpServers.local).toEqual({
      command: "node",
      env: { A: "b" },
      enabled: false,
    });
  });

  it("refuses to write a plugin-managed entry", async () => {
    await expect(
      setMcpServerEnabled({
        source: { kind: "plugin", form: "canonical" },
        name: "p",
        enabled: false,
      }),
    ).rejects.toThrow(/plugin/);
  });
});

describe("MCP-CAT-14: a global change reaches every workspace, with separate cwd", () => {
  it("reconciles two open workspaces when a global entry is switched", async () => {
    const t = await startTestServer({ app: { trustProject: true } });
    try {
      await json(join(t.root, "config", "config.json"), {
        mcp: { servers: { shared: stdio("alisio-missing-mcp-bin") } },
      });
      const second = join(t.root, "ws2");
      await mkdir(second);
      const a = (await t.api.get("/api/workspaces")).json<Array<{ id: string }>>()[0]?.id as string;
      const b = (await t.api.post("/api/workspaces", { path: second })).json<{ id: string }>().id;
      const enabledIn = async (id: string) =>
        (await t.api.get(`/api/mcp?workspace=${id}`)).json<McpOverview>().servers[0];
      expect(await enabledIn(a)).toMatchObject({ enabled: true, source: "global" });
      expect(await enabledIn(b)).toMatchObject({ enabled: true, source: "global" });

      const off = await t.api.patch(`/api/mcp/shared?workspace=${a}`, { enabled: false });
      expect(off.status).toBe(200);
      expect(await enabledIn(b)).toMatchObject({ enabled: false, status: "disabled" });
    } finally {
      await t.close();
    }
  });

  it("shows both layers on the wire: the effective entry and the global one it hides", async () => {
    const t = await startTestServer({ app: { trustProject: true } });
    try {
      await json(join(t.root, "config", "config.json"), {
        mcp: {
          servers: {
            shared: stdio("alisio-missing-mcp-bin", { args: ["--token", "WIRE-SECRET"] }),
          },
        },
      });
      await json(join(t.workspace, ".alisio", "config.json"), {
        mcp: { servers: { shared: stdio("other-bin", { enabled: false }) } },
      });
      const wid = (await t.api.get("/api/workspaces")).json<Array<{ id: string }>>()[0]?.id;
      const res = await t.api.get(`/api/mcp?workspace=${wid}`);
      expect(res.text).not.toContain("WIRE-SECRET");
      expect(res.text).not.toContain("other-bin");
      expect(res.json<McpOverview>().servers[0]).toMatchObject({
        name: "shared",
        source: "project",
        effective: true,
        editable: true,
        shadows: [{ source: "global", enabled: true, transport: "stdio" }],
      });
    } finally {
      await t.close();
    }
  });

  it("keeps one connection and one cwd per workspace for the same global integration", async () => {
    const { root, global } = await fixture();
    const one = join(root, "one");
    const two = join(root, "two");
    await mkdir(one);
    await mkdir(two);
    await json(join(global, "config.json"), {
      mcp: {
        servers: {
          cwdsrv: stdio(process.execPath, {
            args: [
              ...(process.versions.bun
                ? []
                : ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"]),
              resolve("fixtures/mcp-cwd-server.ts"),
            ],
          }),
        },
      },
    });
    const apps = await Promise.all(
      [one, two].map((cwd) => createApplication({ cwd, allowMcp: true, noHerdr: true })),
    );
    try {
      const seen: string[] = [];
      for (const [index, app] of apps.entries()) {
        await app.mcp.connect("cwdsrv", AbortSignal.timeout(15_000));
        const result = await app.registry.get("mcp_cwdsrv_cwd").execute(
          {},
          {
            signal: AbortSignal.timeout(10_000),
            workspace: [one, two][index] as string,
            emit() {},
          },
        );
        seen.push(await realpath(JSON.stringify(result).match(/"text":"([^"]+)"/)?.[1] as string));
      }
      expect(seen).toEqual([one, two]);
      // Disconnecting one workspace leaves the other connected.
      await apps[0]?.mcp.disconnect("cwdsrv");
      expect(apps[1]?.mcp.info("cwdsrv").status).toBe("connected");
    } finally {
      await Promise.all(apps.map((app) => app.close()));
    }
  }, 40_000);
});
