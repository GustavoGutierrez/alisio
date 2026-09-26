import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelProvider, ToolDefinition } from "@alisio/sdk";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serve } from "../fixtures/http.ts";
import { makeServer } from "../fixtures/mcp-server.ts";
import { createApplication } from "../packages/core/src/application.ts";
import { semanticMcpToolNames } from "../packages/core/src/mcp/connector.ts";

afterEach(() => vi.unstubAllEnvs());

describe("MCP runtime permission", () => {
  it("makes a fake connected tool visible and executable on the next turn without recreating the app", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-mcp-consent-"));
    const configHome = join(root, "config");
    await mkdir(configHome, { recursive: true });
    vi.stubEnv("ALISIO_CONFIG_HOME", configHome);
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    const server = makeServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await server.connect(transport);
    const http = await serve((request) => transport.handleRequest(request));
    const secondServer = makeServer();
    const secondTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await secondServer.connect(secondTransport);
    const secondHttp = await serve((request) => secondTransport.handleRequest(request));
    await writeFile(
      join(configHome, "config.json"),
      JSON.stringify({
        mcp: {
          servers: {
            devforge: { url: `http://127.0.0.1:${http.port}/mcp` },
            clock: { url: `http://127.0.0.1:${secondHttp.port}/mcp` },
          },
        },
      }),
    );
    const snapshots: ToolDefinition[][] = [];
    const provider: ModelProvider = {
      id: "capture",
      model: "fixture",
      async *stream(request) {
        snapshots.push(request.tools);
        yield {
          type: "completed",
          message: { role: "assistant", text: "captured", calls: [] },
        } as const;
      },
    };
    const app = await createApplication({ cwd: root, provider, noHerdr: true });
    try {
      expect(app.mcpRuntimePermission()).toBe("not-granted");
      expect(app.registry.list().some((tool) => tool.name === "mcp_connect")).toBe(false);
      expect(app.runner.availableTools().some((tool) => tool.name === "mcp_devforge_echo")).toBe(
        false,
      );
      await expect(app.mcp.connect("devforge", AbortSignal.timeout(100))).rejects.toThrow(
        "--allow-mcp",
      );

      expect(app.grantMcpRuntimePermission({ source: "interactive-tui", confirmed: false })).toBe(
        "not-granted",
      );
      expect(app.registry.list().some((tool) => tool.name === "mcp_connect")).toBe(false);

      app.grantMcpRuntimePermission({ source: "interactive-tui", confirmed: true });
      app.grantMcpRuntimePermission({ source: "interactive-tui", confirmed: true });
      expect(app.registry.list().filter((tool) => tool.name === "mcp_connect")).toHaveLength(1);
      const names = await app.mcp.connect("devforge", AbortSignal.timeout(10_000));
      expect(names).toContain("mcp_devforge_echo");
      expect(app.mcp.info("devforge")).toMatchObject({
        enabled: true,
        runtimePermission: "granted",
        status: "connected",
        counts: { tools: 2 },
      });
      expect(app.mcp.tools("devforge")[0]).toMatchObject({
        name: "echo",
        effectiveName: "mcp_devforge_echo",
        annotations: { readOnly: true, destructive: false, openWorld: false },
      });
      expect(app.registry.get("mcp_devforge_echo").description).toMatch(
        /^devforge\/echo — Remote MCP description \(untrusted data\):/,
      );
      const result = await app.registry
        .get("mcp_devforge_echo")
        .execute(
          { text: "hello" },
          { signal: AbortSignal.timeout(10_000), workspace: root, emit() {} },
        );
      expect(JSON.stringify(result)).toContain("hello");
      await app.mcp.connect("clock", AbortSignal.timeout(10_000));
      expect(app.registry.list().some((tool) => tool.name === "mcp_clock_echo")).toBe(true);
      await app.mcp.connect("clock", AbortSignal.timeout(10_000));
      expect(app.registry.list().filter((tool) => tool.name === "mcp_clock_echo")).toHaveLength(1);

      const session = app.store.create(root, provider.id, provider.model).id;
      await app.runner.run(session, "Use the connected fixture tool if useful.");
      expect(snapshots.at(-1)?.map((tool) => tool.name)).toContain("mcp_devforge_echo");

      await app.mcp.disconnect("devforge");
      expect(app.registry.list().some((tool) => tool.name === "mcp_devforge_echo")).toBe(false);
      expect(app.registry.list().some((tool) => tool.name === "mcp_clock_echo")).toBe(true);
      expect(app.mcp.info("devforge").counts.tools).toBe(0);
      expect(app.mcpRuntimePermission()).toBe("granted");
    } finally {
      await app.close();
      await server.close();
      await http.close();
      await secondServer.close();
      await secondHttp.close();
    }
  }, 20_000);

  it("keeps read-only as a hard block even for an interactive grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-mcp-read-only-"));
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    const app = await createApplication({ cwd: root, readOnly: true, noHerdr: true });
    try {
      expect(app.mcpRuntimePermission()).toBe("read-only");
      expect(() =>
        app.grantMcpRuntimePermission({ source: "interactive-tui", confirmed: true }),
      ).toThrow("--read-only");
      expect(app.registry.list().some((tool) => tool.name === "mcp_connect")).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("starts already granted with allowMcp and registers the bridge once", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-mcp-allowed-"));
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    const app = await createApplication({ cwd: root, allowMcp: true, noHerdr: true });
    try {
      expect(app.mcpRuntimePermission()).toBe("granted");
      expect(app.registry.list().filter((tool) => tool.name === "mcp_connect")).toHaveLength(1);
      app.grantMcpRuntimePermission({ source: "interactive-tui", confirmed: true });
      expect(app.registry.list().filter((tool) => tool.name === "mcp_connect")).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

describe("persistent global MCP consent (mcp.allow)", () => {
  async function httpServer() {
    const server = makeServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await server.connect(transport);
    const http = await serve((request) => transport.handleRequest(request));
    return {
      server,
      http,
      close: async () => {
        await server.close();
        await http.close();
      },
    };
  }
  async function home(prefix: string) {
    const root = await mkdtemp(join(tmpdir(), prefix));
    const configHome = join(root, "config");
    await mkdir(configHome, { recursive: true });
    vi.stubEnv("ALISIO_CONFIG_HOME", configHome);
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    return { root, configHome, file: join(configHome, "config.json") };
  }

  /** Absolute stdio fixture command that runs the shared fake MCP server under this runtime. */
  function stdioCommand() {
    const fixture = join(resolve(import.meta.dirname ?? ".", "..", "fixtures"), "mcp-server.ts");
    return {
      command: process.execPath,
      args: [
        ...(process.versions.bun
          ? []
          : ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"]),
        fixture,
      ],
    };
  }

  it("auto-connects EVERY enabled stdio server at startup from mcp.allow alone (no /mcp interaction)", async () => {
    const { configHome, file } = await home("alisio-mcp-stdio-");
    const spawn = (enabled: boolean) => ({
      transport: "stdio" as const,
      ...stdioCommand(),
      ...(enabled ? {} : { enabled: false }),
    });
    await writeFile(
      file,
      JSON.stringify({
        mcp: {
          allow: true,
          servers: {
            enabled: spawn(true),
            disabled: spawn(false),
          },
        },
      }),
    );
    const app = await createApplication({ cwd: configHome, noHerdr: true });
    try {
      expect(app.mcpRuntimePermission()).toBe("granted");
      expect(app.mcpAllowPersisted()).toBe(true);
      expect(app.mcp.info("enabled").status).toBe("connected");
      expect(app.mcp.info("enabled").counts.tools).toBe(2);
      expect(app.mcp.info("disabled").status).toBe("disabled");
      expect(app.registry.list().some((tool) => tool.name === "mcp_enabled_echo")).toBe(true);
      expect(app.registry.list().some((tool) => tool.name === "mcp_disabled_echo")).toBe(false);
      expect(app.mcpStartupFailures()).toEqual([]);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("auto-connects servers defined in a TRUSTED PROJECT .alisio/config.json when global mcp.allow grants", async () => {
    const { root, configHome, file } = await home("alisio-mcp-project-stdio-");
    const spawn = (enabled: boolean) => ({
      transport: "stdio" as const,
      ...stdioCommand(),
      ...(enabled ? {} : { enabled: false }),
    });
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".alisio"), { recursive: true });
    // Global layer grants consent only; the servers live in the trusted project config.
    await writeFile(file, JSON.stringify({ mcp: { allow: true } }));
    await writeFile(
      join(workspace, ".alisio", "config.json"),
      JSON.stringify({
        mcp: {
          servers: {
            projectstd: spawn(true),
            projectoff: spawn(false),
          },
        },
      }),
    );
    const app = await createApplication({
      cwd: workspace,
      trustProject: true,
      noHerdr: true,
    });
    try {
      expect(app.mcpRuntimePermission()).toBe("granted");
      expect(app.mcp.info("projectstd").source.kind).toBe("project");
      expect(app.mcp.info("projectstd").status).toBe("connected");
      expect(app.mcp.info("projectstd").counts.tools).toBe(2);
      expect(app.mcp.info("projectoff").status).toBe("disabled");
      expect(app.registry.list().some((tool) => tool.name === "mcp_projectstd_echo")).toBe(true);
      expect(app.registry.list().some((tool) => tool.name === "mcp_projectoff_echo")).toBe(false);
      expect(app.mcpStartupFailures()).toEqual([]);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("starts granted, shows mcp:on, and auto-connects only enabled servers when mcp.allow is true", async () => {
    const { configHome, file } = await home("alisio-mcp-allow-");
    const enabled = await httpServer();
    const disabledServer = await httpServer();
    try {
      await writeFile(
        file,
        JSON.stringify({
          mcp: {
            allow: true,
            servers: {
              enabled: { url: `http://127.0.0.1:${enabled.http.port}/mcp` },
              disabled: {
                url: `http://127.0.0.1:${disabledServer.http.port}/mcp`,
                enabled: false,
              },
            },
          },
        }),
      );
      const app = await createApplication({ cwd: configHome, noHerdr: true });
      try {
        expect(app.mcpRuntimePermission()).toBe("granted");
        expect(app.mcpAllowPersisted()).toBe(true);
        expect(app.registry.list().filter((tool) => tool.name === "mcp_connect")).toHaveLength(1);
        expect(app.mcp.info("enabled").status).toBe("connected");
        expect(app.mcp.info("enabled").counts.tools).toBe(2);
        expect(app.mcp.info("disabled").status).toBe("disabled");
        expect(app.registry.list().some((tool) => tool.name === "mcp_enabled_echo")).toBe(true);
        expect(app.registry.list().some((tool) => tool.name === "mcp_disabled_echo")).toBe(false);
        expect(app.mcpStartupFailures()).toEqual([]);
        // The header indicator derives from the effective runtime permission.
        expect(app.mcpRuntimePermission() === "granted").toBe(true);
      } finally {
        await app.close();
      }
    } finally {
      await enabled.close();
      await disabledServer.close();
    }
  }, 20_000);

  it("keeps absent and explicit false as the old not-granted behavior", async () => {
    const { configHome, file } = await home("alisio-mcp-absent-");
    const app = await createApplication({ cwd: configHome, noHerdr: true });
    try {
      expect(app.mcpRuntimePermission()).toBe("not-granted");
      expect(app.mcpAllowPersisted()).toBe(false);
      await expect(app.mcp.connect("nope", AbortSignal.timeout(100))).rejects.toThrow(
        "--allow-mcp",
      );
    } finally {
      await app.close();
    }
    await writeFile(file, JSON.stringify({ mcp: { allow: false } }));
    const falsy = await createApplication({ cwd: configHome, noHerdr: true });
    try {
      expect(falsy.mcpRuntimePermission()).toBe("not-granted");
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ mcp: { allow: false } });
    } finally {
      await falsy.close();
    }
  });

  it("persists remember atomically preserving unrelated fields, while session-only does not persist", async () => {
    const { configHome, file } = await home("alisio-mcp-remember-");
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        plugins: ["./keep"],
        provider: { model: "keep-model" },
      }),
    );
    const session = await createApplication({ cwd: configHome, noHerdr: true });
    try {
      session.grantMcpRuntimePermission({ source: "interactive-tui", confirmed: true });
      expect(session.mcpRuntimePermission()).toBe("granted");
      const afterSession = JSON.parse(await readFile(file, "utf8"));
      expect(afterSession.mcp).toBeUndefined();
      expect(afterSession.plugins).toEqual(["./keep"]);
    } finally {
      await session.close();
    }
    const remembered = await createApplication({ cwd: configHome, noHerdr: true });
    try {
      await remembered.rememberGlobalMcpConsent();
      expect(remembered.mcpRuntimePermission()).toBe("granted");
      expect(remembered.mcpAllowPersisted()).toBe(true);
      const raw = JSON.parse(await readFile(file, "utf8"));
      expect(raw.mcp).toEqual({ allow: true });
      expect(raw.plugins).toEqual(["./keep"]);
      expect(raw.provider.model).toBe("keep-model");
      expect(raw.schemaVersion).toBe(1);
    } finally {
      await remembered.close();
    }
    const fresh = await createApplication({ cwd: configHome, noHerdr: true });
    try {
      expect(fresh.mcpRuntimePermission()).toBe("granted");
      expect(fresh.mcpAllowPersisted()).toBe(true);
    } finally {
      await fresh.close();
    }
  });

  it("revokes consent: clears allow, drops permission and disconnects servers", async () => {
    const { configHome, file } = await home("alisio-mcp-revoke-");
    const remote = await httpServer();
    try {
      await writeFile(
        file,
        JSON.stringify({
          mcp: {
            allow: true,
            servers: { srv: { url: `http://127.0.0.1:${remote.http.port}/mcp` } },
          },
        }),
      );
      const app = await createApplication({ cwd: configHome, noHerdr: true });
      try {
        expect(app.mcp.info("srv").status).toBe("connected");
        expect(app.registry.list().some((tool) => tool.name === "mcp_srv_echo")).toBe(true);
        await app.revokeGlobalMcpConsent();
        expect(app.mcpAllowPersisted()).toBe(false);
        expect(app.mcpRuntimePermission()).toBe("not-granted");
        expect(app.mcp.info("srv").status).toBe("disconnected");
        expect(app.registry.list().some((tool) => tool.name === "mcp_connect")).toBe(false);
        expect(app.registry.list().some((tool) => tool.name === "mcp_srv_echo")).toBe(false);
        await expect(app.mcp.connect("srv", AbortSignal.timeout(100))).rejects.toThrow(
          "--allow-mcp",
        );
        const raw = JSON.parse(await readFile(file, "utf8"));
        expect(raw.mcp?.allow).toBeUndefined();
        // A fresh start no longer auto-grants.
        app.grantMcpRuntimePermission({ source: "interactive-tui", confirmed: true });
        expect(app.mcpRuntimePermission()).toBe("granted");
      } finally {
        await app.close();
      }
      const after = await createApplication({ cwd: configHome, noHerdr: true });
      try {
        expect(after.mcpRuntimePermission()).toBe("not-granted");
        expect(after.mcpAllowPersisted()).toBe(false);
      } finally {
        await after.close();
      }
    } finally {
      await remote.close();
    }
  }, 20_000);

  it("keeps read-only a hard block for grant, remember, revoke and auto-connect", async () => {
    const { configHome, file } = await home("alisio-mcp-ro-");
    await writeFile(file, JSON.stringify({ mcp: { allow: true } }));
    const app = await createApplication({ cwd: configHome, readOnly: true, noHerdr: true });
    try {
      expect(app.mcpRuntimePermission()).toBe("read-only");
      expect(() =>
        app.grantMcpRuntimePermission({ source: "interactive-tui", confirmed: true }),
      ).toThrow("--read-only");
      await expect(app.rememberGlobalMcpConsent()).rejects.toThrow("--read-only");
      await expect(app.revokeGlobalMcpConsent()).rejects.toThrow("--read-only");
      expect(app.registry.list().some((tool) => tool.name === "mcp_connect")).toBe(false);
      // No grant flow touched the persisted preference.
      const raw = JSON.parse(await readFile(file, "utf8"));
      expect(raw.mcp?.allow).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("reads mcp.allow from the global layer only and keeps --allow-mcp working", async () => {
    const { root, configHome } = await home("alisio-mcp-layer-");
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".alisio"), { recursive: true });
    const projectFile = join(workspace, ".alisio", "config.json");
    // A project layer's mcp.allow must never grant consent.
    await writeFile(projectFile, JSON.stringify({ mcp: { allow: true } }));
    const projectOnly = await createApplication({
      cwd: workspace,
      trustProject: true,
      noHerdr: true,
    });
    try {
      expect(projectOnly.mcpRuntimePermission()).toBe("not-granted");
      expect(projectOnly.mcpAllowPersisted()).toBe(false);
    } finally {
      await projectOnly.close();
    }
    // --allow-mcp elevates regardless of the project layer declaring allow:false.
    const flagged = await createApplication({
      cwd: workspace,
      trustProject: true,
      allowMcp: true,
      noHerdr: true,
    });
    try {
      expect(flagged.mcpRuntimePermission()).toBe("granted");
    } finally {
      await flagged.close();
    }
    // Global allow:true survives the merge even when the project says false; global wins.
    await writeFile(join(configHome, "config.json"), JSON.stringify({ mcp: { allow: true } }));
    await writeFile(projectFile, JSON.stringify({ mcp: { allow: false } }));
    const globalWins = await createApplication({
      cwd: workspace,
      trustProject: true,
      noHerdr: true,
    });
    try {
      expect(globalWins.mcpRuntimePermission()).toBe("granted");
      expect(globalWins.mcpAllowPersisted()).toBe(true);
    } finally {
      await globalWins.close();
    }
  });

  it("isolates per-server auto-connect failures with sanitized diagnostics", async () => {
    const { configHome, file } = await home("alisio-mcp-isolation-");
    const remote = await httpServer();
    try {
      await writeFile(
        file,
        JSON.stringify({
          mcp: {
            allow: true,
            servers: {
              ok: { url: `http://127.0.0.1:${remote.http.port}/mcp` },
              broken: { command: "/nonexistent/fixture/mcp-command" },
            },
          },
        }),
      );
      const app = await createApplication({ cwd: configHome, noHerdr: true });
      try {
        expect(app.mcpRuntimePermission()).toBe("granted");
        expect(app.mcp.info("ok").status).toBe("connected");
        expect(app.mcp.info("ok").counts.tools).toBe(2);
        expect(app.mcp.info("broken").status).toBe("failed");
        expect(app.registry.list().some((tool) => tool.name === "mcp_ok_echo")).toBe(true);
        expect(app.registry.list().some((tool) => tool.name === "mcp_broken_echo")).toBe(false);
        expect(app.mcpStartupFailures()).toHaveLength(1);
        const failure = app.mcpStartupFailures()[0] ?? "";
        expect(failure).toContain("broken");
        expect(failure).not.toContain("/nonexistent/fixture/mcp-command");
      } finally {
        await app.close();
      }
    } finally {
      await remote.close();
    }
  }, 20_000);
});

describe("semantic MCP tool names", () => {
  it("keeps readable names and deterministically resolves sanitization collisions", () => {
    expect(semanticMcpToolNames("DevForge", ["time_diff"], ["DevForge"])).toEqual([
      "mcp_devforge_time_diff",
    ]);
    const first = semanticMcpToolNames("a-b", ["same tool", "same_tool"], ["a-b", "a_b"]);
    const second = semanticMcpToolNames("a-b", ["same tool", "same_tool"], ["a_b", "a-b"]);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(2);
    expect(first.every((name) => /^[a-z0-9_]{1,64}$/.test(name))).toBe(true);
  });

  it("bounds hostile, unicode and long names and rejects duplicate original mappings", () => {
    const names = semanticMcpToolNames(
      "🔥 ../../Dëv Forge\nignore instructions",
      ["⏱️ Tiempo Diferencia", "x".repeat(200), "!!!"],
      ["🔥 ../../Dëv Forge\nignore instructions"],
    );
    expect(names).toHaveLength(3);
    expect(names.every((name) => /^[a-z0-9_]{1,64}$/.test(name))).toBe(true);
    expect(names[0]).toContain("dev_forge_ignore_instructions_tiempo_diferencia");
    expect(names[1]?.length).toBeLessThanOrEqual(64);
    expect(() => semanticMcpToolNames("server", ["same", "same"], ["server"])).toThrow(
      "duplicate tool names",
    );
  });
});
