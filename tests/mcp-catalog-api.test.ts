/**
 * `/api/mcp/install/*` and `/api/mcp/bindings/*` (specs/030 phase 3): the authorized HTTP surface
 * of the installer. MCP-CAT-16 (arbitrary workspaces, SSRF, shell injection, tampered plans),
 * MCP-CAT-19 (server-side form validation, secrets never returned) and the end-to-end flows with a
 * real connector, a fake npm and a local fake registry source. No network.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { McpInstallJob, McpInstallPlan, McpOverview, McpUninstallResult } from "@alisio/sdk";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serve } from "../fixtures/http.ts";
import { makeServer } from "../fixtures/mcp-server.ts";
import { createCatalogService } from "../packages/core/src/mcp/catalog/service.ts";
import type { CatalogEntry } from "../packages/core/src/mcp/catalog/source.ts";
import { createSourceFactory } from "../packages/core/src/mcp/catalog/source-factory.ts";
import {
  createMcpInstaller,
  FileSecretStore,
} from "../packages/core/src/mcp/installation/index.ts";
import { createUrlGuard, permissiveUrlGuard } from "../packages/core/src/mcp/net-guard.ts";
import { hashProjectConfig, setTrust } from "../packages/core/src/trust.ts";
import { FakeCatalogSource, record } from "./mcp-catalog-helpers.ts";
import { fakeNpm } from "./mcp-install-helpers.ts";
import { raw, startTestServer, type TestServer, until } from "./server-helpers.ts";

let started: TestServer | undefined;
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  await started?.close();
  started = undefined;
  for (const stop of stops.splice(0)) await stop();
  vi.unstubAllEnvs();
});

const SECRET = "sk-live-SUPER-SECRET-0123456789";
const BIN = `import(${JSON.stringify(pathToFileURL(resolve("fixtures/mcp-bin-server.mjs")).href)});\n`;

interface BootOptions {
  records?: ReturnType<typeof record>[];
  readOnly?: boolean;
  granted?: boolean;
  guard?: Parameters<typeof createMcpInstaller>[0]["guard"];
  /** Rewrites an entry the installer reads (point a remote at a local fixture, add inputs). */
  tweak?: (entry: CatalogEntry) => CatalogEntry;
  binSource?: string;
}

async function boot(options: BootOptions = {}) {
  const records = options.records ?? [
    record({ name: "io.example/files", title: "Files", kind: "npm", version: "1.0.0" }),
    record({ name: "io.example/cloud", title: "Cloud", kind: "remote", version: "2.0.0" }),
    record({ name: "io.example/py", title: "Py", kind: "pypi" }),
  ];
  const source = new FakeCatalogSource({ records });
  const catalog = createCatalogService({
    dbPath: ":memory:",
    source: { source: "fake" },
    factory: createSourceFactory({ fake: () => source }),
    autoSync: false,
  });
  catalog.sync();
  await catalog.idle();
  // Everything the installer owns lives under one temporary root, never the real state home.
  const installRoot = join(tmpdir(), `alisio-api-install-${crypto.randomUUID()}`);
  const secretsRoot = join(installRoot, "secrets");
  const secrets = new FileSecretStore(secretsRoot);
  const npm = fakeNpm({ binSource: options.binSource ?? BIN });
  const installer = createMcpInstaller({
    dbPath: join(installRoot, "installations.sqlite"),
    artifactsRoot: join(installRoot, "artifacts"),
    secrets,
    entries: {
      entry: (name, version) => {
        const found = catalog.entry(name, version);
        return found && options.tweak ? options.tweak(found) : found;
      },
    },
    runNpm: npm.run,
    guard: options.guard ?? permissiveUrlGuard,
    runtime: {},
  });
  started = await startTestServer({
    mcpCatalog: catalog,
    mcpInstaller: installer,
    mcpSecrets: secrets,
    ...(options.readOnly || options.granted
      ? {
          app: {
            ...(options.readOnly ? { readOnly: true } : {}),
            ...(options.granted ? { allowMcp: true } : {}),
          },
        }
      : {}),
  });
  return { ...started, source, catalog, installer, npm, secrets, secretsRoot, installRoot };
}

const planBody = (t: TestServer, over: Record<string, unknown> = {}) => ({
  workspace: t.workspace,
  name: "io.example/files",
  scope: "global",
  ...over,
});

async function plan(t: TestServer, over: Record<string, unknown> = {}) {
  const res = await t.api.post("/api/mcp/install/plans", planBody(t, over));
  if (res.status !== 200) throw new Error(`plan ${res.status} ${res.text}`);
  return res.json<McpInstallPlan>();
}

let counter = 0;
async function startJob(t: TestServer, p: McpInstallPlan, extra: Record<string, unknown> = {}) {
  return t.api.post("/api/mcp/install/jobs", {
    workspace: t.workspace,
    planId: p.planId,
    digest: p.digest,
    idempotencyKey: `api-key-${++counter}`,
    ...extra,
  });
}

async function finish(t: TestServer, id: string) {
  return (await until(async () => {
    const job = (await t.api.get(`/api/mcp/install/jobs/${id}`)).json<McpInstallJob>();
    return ["completed", "failed", "cancelled"].includes(job.state) ? job : undefined;
  }, 20_000)) as McpInstallJob;
}

describe("authorization and workspace resolution (MCP-CAT-16)", () => {
  it("needs the launch cookie and a same-origin POST like every API route", async () => {
    const t = await boot();
    expect((await raw(t.server.port, "/api/mcp/install/jobs/x")).status).toBe(401);
    const noOrigin = await raw(t.server.port, "/api/mcp/install/plans", {
      method: "POST",
      headers: { Cookie: t.cookie, "Content-Type": "application/json" },
      body: planBody(t),
    });
    expect(noOrigin.status).toBe(403);
  });

  it("rejects a workspace that is not one of the server's own, whatever the path", async () => {
    const t = await boot();
    const stranger = join(t.root, "stranger");
    await mkdir(stranger);
    for (const workspace of [
      stranger,
      "/",
      "../../etc",
      "ws_0000000000000000",
      join(t.root, "..", "x"),
    ]) {
      const res = await t.api.post("/api/mcp/install/plans", planBody(t, { workspace }));
      expect([404, 400]).toContain(res.status);
    }
    expect(existsSync(join(stranger, ".alisio"))).toBe(false);
    // The registered workspace works, by path.
    expect((await t.api.post("/api/mcp/install/plans", planBody(t))).status).toBe(200);
  });

  it("validates every field and names only the fields", async () => {
    const t = await boot();
    const bad = async (over: Record<string, unknown>, fields: string[]) => {
      const res = await t.api.post("/api/mcp/install/plans", planBody(t, over));
      expect(res.status).toBe(400);
      expect(res.json<{ error: { details: { fields: string[] } } }>().error.details.fields).toEqual(
        fields,
      );
    };
    await bad({ scope: "everywhere" }, ["scope"]);
    await bad({ name: "" }, ["name"]);
    await bad({ name: "x".repeat(400) }, ["name"]);
    await bad({ surprise: 1 }, ["surprise"]);
    await bad({ alias: "bad/alias;rm" }, ["alias"]);
    await bad({ method: "docker" }, ["method"]);
    const jobs = await t.api.post("/api/mcp/install/jobs", {
      workspace: t.workspace,
      planId: 5,
      digest: "x",
      idempotencyKey: "",
      inputs: { a: 1 },
    });
    expect(jobs.status).toBe(400);
    expect(jobs.json<{ error: { details: { fields: string[] } } }>().error.details.fields).toEqual(
      expect.arrayContaining(["planId", "idempotencyKey", "inputs"]),
    );
  });

  it("answers an unknown or unsupported entry honestly", async () => {
    const t = await boot();
    expect(
      (await t.api.post("/api/mcp/install/plans", planBody(t, { name: "io.example/none" }))).status,
    ).toBe(404);
    const py = await t.api.post("/api/mcp/install/plans", planBody(t, { name: "io.example/py" }));
    expect(py.status).toBe(422);
    expect(py.json<{ error: { code: string; details: { reason: string } } }>().error).toMatchObject(
      {
        code: "mcp_method_unsupported",
        details: { reason: "pypi" },
      },
    );
  });

  it("refuses a tampered, expired or unknown plan", async () => {
    const t = await boot();
    const p = await plan(t);
    const tampered = await t.api.post("/api/mcp/install/jobs", {
      workspace: t.workspace,
      planId: p.planId,
      digest: "f".repeat(64),
      idempotencyKey: "tamper-1",
    });
    expect(tampered.status).toBe(400);
    const unknown = await t.api.post("/api/mcp/install/jobs", {
      workspace: t.workspace,
      planId: "plan_unknown",
      digest: p.digest,
      idempotencyKey: "tamper-2",
    });
    expect(unknown.status).toBe(404);
    expect(t.npm.calls).toEqual([]);
  });

  it("refuses private, loopback, metadata and plain-HTTP addresses a catalog card names (SSRF)", async () => {
    for (const url of [
      "https://192.168.1.10/mcp",
      "https://localhost:8443/mcp",
      "https://169.254.169.254/latest/meta-data",
      "http://mcp.example.com/mcp",
      "https://user:pw@mcp.example.com/mcp",
    ]) {
      const t = await boot({
        guard: createUrlGuard(),
        tweak: (entry) => ({ ...entry, remotes: entry.remotes.map((r) => ({ ...r, url })) }),
      });
      const res = await t.api.post(
        "/api/mcp/install/plans",
        planBody(t, { name: "io.example/cloud" }),
      );
      expect(res.status).toBe(422);
      expect(res.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
        "unsafe_address",
      );
      await started?.close();
      started = undefined;
    }
  });

  it("treats shell metacharacters as data: no command is run and nothing leaks into npm", async () => {
    const t = await boot({
      records: [record({ name: "io.example/files", title: "Files", kind: "npm" })],
    });
    const p = await plan(t);
    expect(p.requiredInputs).toEqual([]);
    const injected = await t.api.post(
      "/api/mcp/install/plans",
      planBody(t, { alias: "a;touch pwned" }),
    );
    expect(injected.status).toBe(400);
    expect(existsSync(join(t.workspace, "pwned"))).toBe(false);
  });
});

describe("install over HTTP with a real connector (MCP-CAT-10, O9)", () => {
  it("plans, consents in the same flow, installs, connects and lists the integration, then uninstalls", async () => {
    const t = await boot();
    const p = await plan(t);
    expect(p).toMatchObject({ method: "npm", execution: "local", requiresConsent: true });
    // Without consent the job waits, and nothing is written or downloaded yet.
    const waiting = await startJob(t, p);
    expect(waiting.status).toBe(202);
    const job = waiting.json<McpInstallJob>();
    await until(
      async () =>
        (await t.api.get(`/api/mcp/install/jobs/${job.id}`)).json<McpInstallJob>().state ===
        "awaiting-consent",
    );
    expect(t.npm.calls).toEqual([]);
    expect(
      (await t.api.get(`/api/mcp?workspace=${encodeURIComponent(t.workspace)}`)).json<McpOverview>()
        .servers,
    ).toEqual([]);
    // Granting is explicit and per run unless the user asks to remember it.
    const consent = await t.api.post(`/api/mcp/install/jobs/${job.id}/consent`, {
      workspace: t.workspace,
      confirmed: true,
    });
    expect(consent.status).toBe(200);
    const done = await finish(t, job.id);
    expect(done).toMatchObject({ state: "completed", result: { connected: true } });
    const overview = (
      await t.api.get(`/api/mcp?workspace=${encodeURIComponent(t.workspace)}`)
    ).json<McpOverview>();
    expect(overview.persisted).toBe(false);
    expect(overview.permission).toBe("granted");
    const server = overview.servers.find((s) => s.name === p.alias);
    expect(server).toMatchObject({
      status: "connected",
      execution: "local",
      counts: { tools: 2, resources: 1, prompts: 0 },
      binding: {
        scope: "global",
        registryName: "io.example/files",
        method: "npm",
        execution: "local",
        hasSavedKeys: false,
        lastTest: { status: "passed" },
      },
    });
    // Nothing that reveals the machine or a credential reaches the wire.
    const wire = JSON.stringify(overview);
    expect(wire).not.toContain(t.root);
    expect(wire).not.toContain("node_modules");
    // Uninstall: scope explicit, config entry gone, artifact deleted.
    const bindingId = server?.binding?.id as string;
    const removed = await t.api.delete(
      `/api/mcp/bindings/${bindingId}?workspace=${encodeURIComponent(t.workspace)}&scope=global&removeSecrets=true`,
    );
    expect(removed.status).toBe(200);
    expect(removed.json<McpUninstallResult>()).toMatchObject({
      removedConfig: true,
      artifact: "deleted",
    });
    expect(
      (await t.api.get(`/api/mcp?workspace=${encodeURIComponent(t.workspace)}`)).json<McpOverview>()
        .servers,
    ).toEqual([]);
    expect((await readdir(t.installer.artifactsRoot)).filter((n) => !n.startsWith("."))).toEqual(
      [],
    );
  });

  it("with consent in the same request one call installs and connects", async () => {
    const t = await boot();
    const p = await plan(t);
    const res = await startJob(t, p, { consent: { confirmed: true } });
    expect(res.status).toBe(202);
    const done = await finish(t, res.json<McpInstallJob>().id);
    expect(done).toMatchObject({ state: "completed", result: { connected: true } });
    // Permanent consent is a separate, explicit choice that was not made.
    expect(
      (await t.api.get(`/api/mcp?workspace=${encodeURIComponent(t.workspace)}`)).json<McpOverview>()
        .persisted,
    ).toBe(false);
  });

  it("answers a double click with the same job", async () => {
    const t = await boot({ granted: true });
    const p = await plan(t);
    const body = {
      workspace: t.workspace,
      planId: p.planId,
      digest: p.digest,
      idempotencyKey: "double-click-key",
    };
    const [a, b] = await Promise.all([
      t.api.post("/api/mcp/install/jobs", body),
      t.api.post("/api/mcp/install/jobs", body),
    ]);
    expect(a.json<McpInstallJob>().id).toBe(b.json<McpInstallJob>().id);
    await finish(t, a.json<McpInstallJob>().id);
    expect(t.npm.calls).toHaveLength(1);
  });

  it("cancels a job and reports it", async () => {
    const t = await boot();
    const p = await plan(t);
    const job = (await startJob(t, p)).json<McpInstallJob>();
    await until(
      async () =>
        (await t.api.get(`/api/mcp/install/jobs/${job.id}`)).json<McpInstallJob>().state ===
        "awaiting-consent",
    );
    const cancelled = await t.api.post(`/api/mcp/install/jobs/${job.id}/cancel`, {
      workspace: t.workspace,
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json<McpInstallJob>().state).toBe("cancelled");
    expect(
      (
        await t.api.post(`/api/mcp/install/jobs/${job.id}/cancel`, { workspace: t.workspace })
      ).json<McpInstallJob>().state,
    ).toBe("cancelled");
    expect((await t.api.get("/api/mcp/install/jobs/job_missing")).status).toBe(404);
  });

  it("keeps the installation and says so when the connection fails", async () => {
    const t = await boot({ granted: true, binSource: "process.exit(1);\n" });
    const p = await plan(t);
    const done = await finish(t, (await startJob(t, p)).json<McpInstallJob>().id);
    expect(done).toMatchObject({ state: "completed", result: { connected: false } });
    const server = (await t.api.get(`/api/mcp?workspace=${encodeURIComponent(t.workspace)}`))
      .json<McpOverview>()
      .servers.find((s) => s.name === p.alias);
    expect(server).toMatchObject({ status: "failed", binding: { lastTest: { status: "failed" } } });
    // The test can be repeated from the list.
    const again = await t.api.post(`/api/mcp/bindings/${server?.binding?.id}/test`, {
      workspace: t.workspace,
    });
    expect(again.status).toBe(200);
    expect(
      again.json<{ binding: { lastTest: { status: string } } }>().binding.lastTest.status,
    ).toBe("failed");
  });
});

describe("global changes reach every open workspace (MCP-CAT-14 for installs)", () => {
  it("shows a global install in another open workspace and drops it again on removal", async () => {
    const t = await boot({ granted: true });
    const other = join(t.root, "other");
    await mkdir(other);
    const second = (await t.api.post("/api/workspaces", { path: other })).json<{ id: string }>().id;
    // The second workspace is open before anything is installed.
    expect((await t.api.get(`/api/mcp?workspace=${second}`)).json<McpOverview>().servers).toEqual(
      [],
    );
    const p = await plan(t);
    const done = await finish(t, (await startJob(t, p)).json<McpInstallJob>().id);
    expect(done.state).toBe("completed");
    const seen = await until(async () => {
      const servers = (await t.api.get(`/api/mcp?workspace=${second}`)).json<McpOverview>().servers;
      return servers.find((s) => s.name === p.alias);
    });
    // Same integration, but this workspace has its own connection (nothing is shared but the files).
    expect(seen?.binding).toMatchObject({ scope: "global" });
    const first = (
      await t.api.get(`/api/mcp?workspace=${encodeURIComponent(t.workspace)}`)
    ).json<McpOverview>();
    const bindingId = first.servers.find((s) => s.name === p.alias)?.binding?.id as string;
    await t.api.delete(
      `/api/mcp/bindings/${bindingId}?workspace=${encodeURIComponent(t.workspace)}&scope=global&removeSecrets=false`,
    );
    await until(
      async () =>
        (await t.api.get(`/api/mcp?workspace=${second}`)).json<McpOverview>().servers.length === 0,
    );
  });

  it("does not remove a global binding when asked as a project one, nor the reverse", async () => {
    const t = await boot({ granted: true });
    const p = await plan(t);
    await finish(t, (await startJob(t, p)).json<McpInstallJob>().id);
    const servers = (
      await t.api.get(`/api/mcp?workspace=${encodeURIComponent(t.workspace)}`)
    ).json<McpOverview>().servers;
    const bindingId = servers[0]?.binding?.id as string;
    const wrong = await t.api.delete(
      `/api/mcp/bindings/${bindingId}?workspace=${encodeURIComponent(t.workspace)}&scope=project&removeSecrets=false`,
    );
    expect(wrong.status).toBe(400);
    const bad = await t.api.delete(
      `/api/mcp/bindings/${bindingId}?workspace=${encodeURIComponent(t.workspace)}&scope=x`,
    );
    expect(bad.status).toBe(400);
    expect(
      (await t.api.get(`/api/mcp?workspace=${encodeURIComponent(t.workspace)}`)).json<McpOverview>()
        .servers,
    ).toHaveLength(1);
  });
});

describe("remote services with a saved key (MCP-CAT-09, MCP-CAT-29)", () => {
  async function remoteBoot() {
    const seen: Array<string | null> = [];
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await makeServer().connect(transport);
    const http = await serve((req) => {
      seen.push(req.headers.get("x-api-key"));
      return transport.handleRequest(req);
    });
    stops.push(() => http.close());
    const t = await boot({
      granted: true,
      tweak: (entry) =>
        entry.remotes.length
          ? {
              ...entry,
              remotes: [
                {
                  transport: "streamable-http",
                  url: `http://127.0.0.1:${http.port}/mcp`,
                  inputs: [{ name: "X-Api-Key", kind: "header", isRequired: true, isSecret: true }],
                },
              ],
            }
          : entry,
    });
    return { t, seen };
  }

  it("asks for the key, stores it protected, sends it only to its service and never returns it", async () => {
    const { t, seen } = await remoteBoot();
    const p = await plan(t, { name: "io.example/cloud" });
    expect(p.requiredInputs).toEqual([
      expect.objectContaining({ id: "header.X-Api-Key", secret: true, required: true }),
    ]);
    // Server-side validation: a missing key, a key with a line break, an unknown field.
    const missing = await startJob(t, p);
    expect(missing.status).toBe(422);
    expect(
      missing.json<{ error: { details: { fields: string[] } } }>().error.details.fields,
    ).toEqual(["header.X-Api-Key"]);
    const newline = await startJob(t, p, {
      inputs: { "header.X-Api-Key": `${SECRET}\nX-Evil: 1` },
    });
    expect(newline.status).toBe(422);
    expect(newline.text).not.toContain(SECRET);
    const res = await startJob(t, p, { inputs: { "header.X-Api-Key": SECRET } });
    expect(res.status).toBe(202);
    const done = await finish(t, res.json<McpInstallJob>().id);
    expect(done).toMatchObject({ state: "completed", result: { connected: true } });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((value) => value === SECRET)).toBe(true);
    // Not in the configuration, the wire, the job, the plan or the installer database.
    const home = process.env.ALISIO_CONFIG_HOME as string;
    expect(await readFile(join(home, "config.json"), "utf8")).not.toContain(SECRET);
    const overview = await t.api.get(`/api/mcp?workspace=${encodeURIComponent(t.workspace)}`);
    expect(overview.text).not.toContain(SECRET);
    // Only the origin of the service is shown, never a path that could carry a token.
    expect(overview.text).not.toContain('/mcp"');
    expect(JSON.stringify([p, done])).not.toContain(SECRET);
    expect((await readFile(join(t.installRoot, "installations.sqlite"))).includes(SECRET)).toBe(
      false,
    );
    // It is only in the protected file, readable by the owner alone.
    const stored = await readFile(join(t.secretsRoot, "mcp-secrets.json"), "utf8");
    expect(stored).toContain(SECRET);
    // Another workspace sees the global server, but nothing of the key.
    const other = join(t.root, "other");
    await mkdir(other);
    const added = (await t.api.post("/api/workspaces", { path: other })).json<{ id: string }>();
    const second = await t.api.get(`/api/mcp?workspace=${added.id}`);
    expect(second.status).toBe(200);
    expect(second.text).not.toContain(SECRET);
    expect(second.json<McpOverview>().servers.map((s) => s.name)).toContain(p.alias);
  });
});

describe("read-only and project scope", () => {
  it("refuses every install operation under --read-only", async () => {
    const t = await boot({ readOnly: true });
    const res = await t.api.post("/api/mcp/install/plans", planBody(t));
    expect(res.status).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("mcp_not_permitted");
    expect(
      (
        await t.api.delete(
          `/api/mcp/bindings/b1?workspace=${encodeURIComponent(t.workspace)}&scope=global`,
        )
      ).status,
    ).toBe(403);
  });

  it("refuses a project install in an untrusted project and installs once it is trusted", async () => {
    const t = await boot({ granted: true });
    const denied = await t.api.post("/api/mcp/install/plans", planBody(t, { scope: "project" }));
    expect(denied.status).toBe(403);
    expect(denied.json<{ error: { code: string } }>().error.code).toBe("mcp_scope_untrusted");
    await mkdir(join(t.workspace, ".alisio"), { recursive: true });
    await setTrust(t.workspace, true, await hashProjectConfig(t.workspace));
    const p = await plan(t, { scope: "project" });
    const job = (await startJob(t, p)).json<McpInstallJob>();
    const done = await finish(t, job.id);
    expect(done?.state).toBe("completed");
    const file = JSON.parse(await readFile(join(t.workspace, ".alisio", "config.json"), "utf8"));
    expect(Object.keys(file.mcp.servers)).toEqual([p.alias]);
  });
});
