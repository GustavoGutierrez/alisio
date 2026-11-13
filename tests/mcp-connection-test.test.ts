/**
 * MCP-CAT-20 to MCP-CAT-22 (specs/030 phase 4, UX-07): the connection test is an isolated
 * diagnostic session. It lists what a server announces without calling any tool, needs MCP consent,
 * cancels and expires cleanly, never touches the live connection (no duplicated tools, no
 * reactivated binding) and goes stale when the settings, the key or the version change.
 */
import { resolve } from "node:path";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serve, type TestServer } from "../fixtures/http.ts";
import { makeServer } from "../fixtures/mcp-server.ts";
import { type FakeOAuth, startFakeOAuth } from "../fixtures/oauth-server.ts";
import { configSchema, type ServerConfig } from "../packages/core/src/config.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { McpOAuth } from "../packages/core/src/mcp/auth/index.ts";
import {
  connectionFingerprint,
  McpConnectionTestError,
  runConnectionTest,
} from "../packages/core/src/mcp/connection-test.ts";
import { McpConnector } from "../packages/core/src/mcp/connector.ts";
import {
  createMcpInstaller,
  MemorySecretStore,
} from "../packages/core/src/mcp/installation/index.ts";
import { permissiveUrlGuard } from "../packages/core/src/mcp/net-guard.ts";
import { installFixture, recordingHooks, remoteEntry } from "./mcp-install-helpers.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  vi.unstubAllEnvs();
});

const httpServer = (url: string): ServerConfig =>
  configSchema.parse({ mcp: { servers: { s: { transport: "http", url } } } }).mcp.servers
    .s as ServerConfig;
const stdioServer = (): ServerConfig =>
  configSchema.parse({
    mcp: {
      servers: {
        s: {
          transport: "stdio",
          command: process.execPath,
          args: [resolve("fixtures/mcp-bin-server.mjs")],
        },
      },
    },
  }).mcp.servers.s as ServerConfig;

/** A remote MCP server that records every JSON-RPC method it receives. */
async function remote(build: () => McpServer = makeServer) {
  const methods: string[] = [];
  const http: TestServer = await serve(async (req) => {
    if (req.method === "POST") {
      const body = (await req
        .clone()
        .json()
        .catch(() => undefined)) as { method?: string } | Array<{ method?: string }> | undefined;
      for (const message of Array.isArray(body) ? body : body ? [body] : [])
        if (message.method) methods.push(message.method);
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await build().connect(transport);
    return transport.handleRequest(req);
  });
  closers.push(() => http.close());
  return { url: `http://127.0.0.1:${http.port}/mcp`, methods };
}

const base = { workspace: process.cwd(), permission: "granted" as const };

describe("MCP-CAT-20: the test lists the announced capabilities without calling anything", () => {
  it("passes with every stage and counts, and never calls a tool, reads a resource or gets a prompt", async () => {
    const { url, methods } = await remote();
    const result = await runConnectionTest({ ...base, server: httpServer(url) });
    expect(result.status).toBe("passed");
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ["prepare", "passed"],
      ["connect", "passed"],
      ["authenticate", "skipped"],
      ["discover", "passed"],
    ]);
    expect(result.capabilities).toEqual(["prompts", "resources", "tools"]);
    expect(result.counts).toEqual({ tools: 2, resources: 1, prompts: 1 });
    expect(methods).toContain("initialize");
    expect(methods).toContain("tools/list");
    for (const forbidden of ["tools/call", "resources/read", "prompts/get"])
      expect(methods).not.toContain(forbidden);
  });

  it("passes for a server that only offers resources (no tool is required)", async () => {
    const { url, methods } = await remote(() => {
      const server = new McpServer({ name: "resources-only", version: "1.0.0" });
      server.registerResource("doc", "test://doc", { mimeType: "text/plain" }, async (uri) => ({
        contents: [{ uri: uri.href, text: "hello" }],
      }));
      return server;
    });
    const result = await runConnectionTest({ ...base, server: httpServer(url) });
    expect(result.status).toBe("passed");
    expect(result.counts).toEqual({ tools: 0, resources: 1, prompts: 0 });
    expect(result.capabilities).toEqual(["resources"]);
    expect(methods).not.toContain("tools/list");
  });

  it("checks a local (stdio) server the same way", async () => {
    const result = await runConnectionTest({ ...base, server: stdioServer() });
    expect(result.status).toBe("passed");
    expect(result.counts.tools).toBeGreaterThan(0);
  });
});

describe("MCP-CAT-21: consent, cancellation, expiry and isolation", () => {
  it("refuses to run without MCP consent (a test executes code or makes requests)", async () => {
    await expect(
      runConnectionTest({ ...base, permission: "not-granted", server: stdioServer() }),
    ).rejects.toMatchObject({ code: "mcp_not_permitted" });
    await expect(
      runConnectionTest({ ...base, permission: "read-only", server: stdioServer() }),
    ).rejects.toBeInstanceOf(McpConnectionTestError);
  });

  it("reports a cancelled test and leaves no connection behind", async () => {
    const hang: TestServer = await serve(() => new Promise<Response>(() => {}));
    closers.push(() => hang.close());
    const controller = new AbortController();
    const running = runConnectionTest({
      ...base,
      server: httpServer(`http://127.0.0.1:${hang.port}/mcp`),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(result.safeMessage).toMatch(/cancel/i);
    expect(result.steps.find((step) => step.id === "connect")?.status).toBe("failed");
  });

  it("ends with a timeout result and a way to retry", async () => {
    const hang: TestServer = await serve(() => new Promise<Response>(() => {}));
    closers.push(() => hang.close());
    const result = await runConnectionTest({
      ...base,
      server: httpServer(`http://127.0.0.1:${hang.port}/mcp`),
      timeoutMs: 200,
    });
    expect(result.status).toBe("failed");
    expect(result.safeMessage).toMatch(/too long|timed out/i);
    expect(result.recoveryAction).toBe("retry");
  });

  it("never touches a live connection: same tools, still connected", async () => {
    const { url } = await remote();
    const config = httpServer(url);
    const registry = new ToolRegistry();
    const connector = new McpConnector({ live: config }, registry, process.cwd(), "allowed");
    closers.push(() => connector.close());
    await connector.connect("live", AbortSignal.timeout(15_000));
    const before = registry
      .list()
      .map((tool) => tool.name)
      .sort();
    const result = await runConnectionTest({ ...base, server: config });
    expect(result.status).toBe("passed");
    expect(
      registry
        .list()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(before);
    expect(connector.info("live").status).toBe("connected");
  });

  it("does not turn a disabled server on", async () => {
    const { url } = await remote();
    const config = { ...httpServer(url), enabled: false } as ServerConfig;
    const registry = new ToolRegistry();
    const connector = new McpConnector({ off: config }, registry, process.cwd(), "allowed");
    closers.push(() => connector.close());
    const before = registry.list().length;
    expect((await runConnectionTest({ ...base, server: config })).status).toBe("passed");
    expect(connector.info("off")).toMatchObject({ enabled: false, status: "disabled" });
    expect(registry.list()).toHaveLength(before);
  });

  it("explains a missing key and offers to change it, without starting anything", async () => {
    const server = configSchema.parse({
      mcp: {
        servers: {
          s: {
            transport: "http",
            url: "http://127.0.0.1:9/mcp",
            headers: { Authorization: { secret: "mcp:x:header.authorization" } },
          },
        },
      },
    }).mcp.servers.s as ServerConfig;
    const result = await runConnectionTest({
      ...base,
      server,
      secrets: async () => undefined,
    });
    expect(result.status).toBe("failed");
    expect(result.recoveryAction).toBe("change-key");
    expect(result.steps.find((step) => step.id === "prepare")?.status).toBe("failed");
    expect(result.steps.find((step) => step.id === "connect")?.status).toBe("skipped");
  });

  it("asks to sign in when a remote service refuses without credentials, and passes once signed in", async () => {
    const fake: FakeOAuth = await startFakeOAuth();
    closers.push(() => fake.close());
    const store = new MemorySecretStore();
    const oauth = new McpOAuth({ store, guard: permissiveUrlGuard });
    closers.push(() => oauth.close());
    const key = { scope: "global" as const, alias: "cloud" };
    const server = httpServer(fake.resourceUrl);
    const refused = await runConnectionTest({ ...base, server, oauth, oauthKey: key });
    expect(refused.status).toBe("failed");
    expect(refused.recoveryAction).toBe("sign-in");
    expect(refused.steps.find((step) => step.id === "authenticate")?.status).toBe("failed");

    const flow = await oauth.start({ key, serverUrl: fake.resourceUrl });
    const redirected = await fetch(flow.authorizationUrl as string, { redirect: "manual" });
    await fetch(redirected.headers.get("location") as string);
    await oauth.wait(flow.id);
    const accepted = await runConnectionTest({ ...base, server, oauth, oauthKey: key });
    expect(accepted.status).toBe("passed");
    expect(accepted.steps.find((step) => step.id === "authenticate")?.status).toBe("passed");
    expect(JSON.stringify(accepted)).not.toMatch(/at-|rt-|Bearer/);
  });

  it("says the runtime is missing when the command cannot start", async () => {
    const server = configSchema.parse({
      mcp: { servers: { s: { transport: "stdio", command: "alisio-no-such-command-xyz" } } },
    }).mcp.servers.s as ServerConfig;
    const result = await runConnectionTest({ ...base, server });
    expect(result.status).toBe("failed");
    expect(result.recoveryAction).toBe("install-runtime");
  });
});

describe("MCP-CAT-22: a result goes stale and a later failure keeps the history", () => {
  const entry = { transport: "http", url: "https://mcp.example.com/v1", enabled: true } as const;

  it("changes the fingerprint when the settings, the version or the credentials change, not when switched off", () => {
    const parse = (raw: object) =>
      configSchema.parse({ mcp: { servers: { s: raw } } }).mcp.servers.s as ServerConfig;
    const reference = connectionFingerprint({
      server: parse(entry),
      version: "1.0.0",
      credentialRevision: 0,
    });
    expect(
      connectionFingerprint({ server: parse(entry), version: "1.0.0", credentialRevision: 0 }),
    ).toBe(reference);
    expect(
      connectionFingerprint({
        server: parse({ ...entry, enabled: false }),
        version: "1.0.0",
        credentialRevision: 0,
      }),
    ).toBe(reference);
    expect(
      connectionFingerprint({
        server: parse({ ...entry, url: "https://mcp.example.com/v2" }),
        version: "1.0.0",
        credentialRevision: 0,
      }),
    ).not.toBe(reference);
    expect(
      connectionFingerprint({ server: parse(entry), version: "1.1.0", credentialRevision: 0 }),
    ).not.toBe(reference);
    expect(
      connectionFingerprint({ server: parse(entry), version: "1.0.0", credentialRevision: 1 }),
    ).not.toBe(reference);
  });

  async function installed() {
    const fixture = await installFixture();
    const installer = createMcpInstaller({
      dbPath: fixture.dbPath,
      artifactsRoot: fixture.artifacts,
      secrets: new MemorySecretStore(),
      entries: { entry: () => remoteEntry() },
      guard: permissiveUrlGuard,
      runtime: {},
    });
    closers.push(() => installer.close());
    return installer;
  }

  async function bindingOf(installer: Awaited<ReturnType<typeof installed>>) {
    const plan = await installer.plan({
      name: "io.example/cloud",
      scope: "global",
      runtimePermission: "granted",
    });
    await installer.start({
      planId: plan.planId,
      digest: plan.digest,
      idempotencyKey: "k1",
      inputs: {},
      hooks: recordingHooks(),
    });
    await installer.idle();
    const binding = installer.bindings()[0];
    if (!binding) throw new Error("no binding");
    return binding;
  }

  it("keeps the date of the last pass when a later test fails, with a recovery action", async () => {
    const installer = await installed();
    const binding = await bindingOf(installer);
    installer.recordTest(binding.id, {
      status: "passed",
      at: "2026-11-12T10:00:00.000Z",
      fingerprint: "a",
      steps: [{ id: "connect", status: "passed" }],
      counts: { tools: 1, resources: 0, prompts: 0 },
      capabilities: ["tools"],
    });
    installer.recordTest(binding.id, {
      status: "failed",
      at: "2026-11-12T11:00:00.000Z",
      fingerprint: "a",
      diagnostic: "The service is not reachable",
      recoveryAction: "retry",
    });
    const last = installer.binding(binding.id)?.lastTest;
    expect(last).toMatchObject({
      status: "failed",
      recoveryAction: "retry",
      lastPassedAt: "2026-11-12T10:00:00.000Z",
    });
  });

  it("keeps at most 20 results per binding", async () => {
    const installer = await installed();
    const binding = await bindingOf(installer);
    for (let index = 0; index < 25; index++)
      installer.recordTest(binding.id, {
        status: "passed",
        at: new Date(Date.UTC(2026, 10, 12, 10, index)).toISOString(),
        fingerprint: "a",
      });
    expect(installer.testHistory(binding.id)).toHaveLength(20);
    expect(installer.testHistory(binding.id)[0]?.at).toBe(
      new Date(Date.UTC(2026, 10, 12, 10, 24)).toISOString(),
    );
  });
});
