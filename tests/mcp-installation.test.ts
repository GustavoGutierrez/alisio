import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../packages/core/src/index.ts";
import { mcpIdentity } from "../packages/core/src/mcp/alias.ts";
import {
  type BindingRecord,
  type ConnectResult,
  clampInstallTimeout,
  createMcpInstaller,
  DEFAULT_INSTALL_TIMEOUT_MS,
  MAX_INSTALL_TIMEOUT_MS,
  type McpInstallerOptions,
  MemorySecretStore,
  readInstallTimeoutMs,
} from "../packages/core/src/mcp/installation/index.ts";
import { createUrlGuard, permissiveUrlGuard } from "../packages/core/src/mcp/net-guard.ts";
import { isProcessAlive, runProcess } from "../packages/core/src/runtime/process.ts";
import { resolveTrust } from "../packages/core/src/trust.ts";
import {
  entryIndex,
  failedConnect,
  fakeNpm,
  type InstallFixture,
  installFixture,
  npmEntry,
  recordingHooks,
  remoteEntry,
  trustWorkspace,
} from "./mcp-install-helpers.ts";
import { until } from "./server-helpers.ts";

const validAlias = (alias: string) =>
  configSchema.parse({ mcp: { servers: { [alias]: { command: "node" } } } }).mcp.servers;

describe("MCP-CAT-05: registry identity versus internal alias", () => {
  it("gives two upstream names with the same slug separate identities and valid aliases", () => {
    const a = mcpIdentity("io.github.acme/files", { title: "Files" });
    const b = mcpIdentity("io.github.other/files", { title: "Files" });
    expect(a.registryName).toBe("io.github.acme/files");
    expect(b.registryName).toBe("io.github.other/files");
    expect(a.alias).not.toBe(b.alias);
    for (const identity of [a, b])
      expect(Object.keys(validAlias(identity.alias))).toEqual([identity.alias]);
    // The slash of the registry name never reaches the alias, and the slug stays readable.
    expect(a.alias).toMatch(/^files-[0-9a-f]{6}$/);
  });

  it("is stable for the same name and falls back when the title has no usable characters", () => {
    expect(mcpIdentity("io.github.acme/files", { title: "Files" }).alias).toBe(
      mcpIdentity("io.github.acme/files", { title: "Files" }).alias,
    );
    const fallback = mcpIdentity("io.github.acme/日本語", { title: "日本語" });
    expect(Object.keys(validAlias(fallback.alias))).toEqual([fallback.alias]);
  });

  it("never reuses an alias that already exists, without renaming the existing entry", () => {
    const first = mcpIdentity("io.github.acme/files", { title: "Files" });
    const second = mcpIdentity("io.github.acme/files", { title: "Files", taken: [first.alias] });
    expect(second.alias).not.toBe(first.alias);
    expect(second.alias.startsWith(`${first.alias.split("-")[0]}-`)).toBe(true);
    expect(second.registryName).toBe(first.registryName);
  });

  it("keeps a valid manual alias and rejects an invalid or colliding one", () => {
    expect(mcpIdentity("io.github.acme/files", { alias: "my-files" }).alias).toBe("my-files");
    expect(() => mcpIdentity("io.github.acme/files", { alias: "bad/alias" })).toThrow(/alias/i);
    expect(() => mcpIdentity("io.github.acme/files", { alias: "mine", taken: ["mine"] })).toThrow(
      /already/i,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Phase 3: planner, npm installer, jobs, uninstall and recovery (MCP-CAT-08/12/13/15/31).
// ---------------------------------------------------------------------------------------------

afterEach(() => vi.unstubAllEnvs());

const SECRET = "sk-live-SUPER-SECRET-0123456789";

async function boot(
  fx: InstallFixture,
  entries: ReturnType<typeof entryIndex>,
  over: Partial<McpInstallerOptions> = {},
) {
  const npm = fakeNpm();
  const secrets = new MemorySecretStore();
  const installer = createMcpInstaller({
    dbPath: fx.dbPath,
    artifactsRoot: fx.artifacts,
    secrets,
    entries,
    runNpm: npm.run,
    guard: permissiveUrlGuard,
    runtime: {},
    ...over,
  });
  return { installer, npm, secrets };
}

const globalRequest = (name = "io.example/files") => ({
  name,
  scope: "global" as const,
  runtimePermission: "granted" as const,
});
let key = 0;
const idem = () => `key-${++key}`;

async function install(
  installer: ReturnType<typeof createMcpInstaller>,
  hooks: ReturnType<typeof recordingHooks>,
  request: Parameters<typeof installer.plan>[0],
  inputs: Record<string, string> = {},
) {
  const plan = await installer.plan(request);
  const job = await installer.start({
    planId: plan.planId,
    digest: plan.digest,
    idempotencyKey: idem(),
    inputs,
    hooks,
  });
  await installer.idle();
  return { plan, job: installer.job(job.id) as NonNullable<ReturnType<typeof installer.job>> };
}

const readJsonFile = async (file: string) => JSON.parse(await readFile(file, "utf8"));

describe("MCP-CAT-08: npm install, private and pinned", () => {
  it("installs the exact version privately, resolves the bin and writes a node command", async () => {
    const fx = await installFixture();
    const { installer, npm } = await boot(fx, entryIndex(npmEntry()));
    const hooks = recordingHooks();
    const { plan, job } = await install(installer, hooks, globalRequest());
    expect(plan).toMatchObject({
      kind: "install",
      method: "npm",
      execution: "local",
      package: { identifier: "@example/mcp-files", version: "1.0.0" },
      requiredInputs: [],
      requiresConsent: false,
    });
    expect(plan.alias).toMatch(/^files-[0-9a-f]{6}$/);
    expect(job).toMatchObject({ state: "completed", result: { connected: true } });
    // One npm call: private prefix, exact version, no scripts, never global, never npx.
    expect(npm.calls).toHaveLength(1);
    const args = npm.calls[0]?.args ?? [];
    expect(args).toEqual(
      expect.arrayContaining([
        "install",
        "--ignore-scripts",
        "--save-exact",
        "--package-lock=true",
      ]),
    );
    expect(args).toContain("@example/mcp-files@1.0.0");
    expect(args).not.toContain("-g");
    expect(args).not.toContain("--global");
    expect(npm.calls[0]?.command).toBe("npm");
    expect(args[args.indexOf("--prefix") + 1]?.startsWith(fx.artifacts)).toBe(true);
    // The configuration entry is a portable `node <script>` pair inside the artifact.
    const config = await readJsonFile(fx.globalFile);
    const entry = config.mcp.servers[plan.alias];
    expect(entry).toMatchObject({ transport: "stdio", command: "node", enabled: true });
    expect(entry.args).toHaveLength(1);
    expect(entry.args[0].startsWith(fx.artifacts)).toBe(true);
    expect(entry.args[0].endsWith(join("@example", "mcp-files", "dist", "server.js"))).toBe(true);
    await expect(readFile(entry.args[0], "utf8")).resolves.toContain("fake server");
    expect(installer.bindings()).toHaveLength(1);
    expect(installer.bindings()[0]).toMatchObject({
      alias: plan.alias,
      registryName: "io.example/files",
      registryVersion: "1.0.0",
      scope: "global",
      method: "npm",
    });
    expect(hooks.attached.map((a) => a.name)).toEqual([plan.alias]);
    expect(hooks.connects).toEqual([plan.alias]);
  });

  it("explains a missing npm and writes nothing", async () => {
    const fx = await installFixture();
    const { installer, npm } = await boot(fx, entryIndex(npmEntry()), {
      runtime: { env: { PATH: "" }, isExecutable: () => false },
    });
    await expect(installer.plan(globalRequest())).rejects.toMatchObject({
      code: "mcp_runtime_missing",
      extra: { reason: "npm_missing" },
    });
    expect(npm.calls).toEqual([]);
    await expect(readFile(fx.globalFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses unsupported methods with an honest reason before anything starts", async () => {
    const fx = await installFixture();
    const pypi = npmEntry({ name: "io.example/py" });
    (pypi.packages[0] as { method: string }).method = "pypi";
    const sse = remoteEntry({ name: "io.example/sse", transport: "sse" });
    const index = entryIndex(pypi, sse);
    const { installer } = await boot(fx, index);
    await expect(installer.plan(globalRequest("io.example/py"))).rejects.toMatchObject({
      code: "mcp_method_unsupported",
      extra: { reason: "pypi" },
    });
    await expect(installer.plan(globalRequest("io.example/sse"))).rejects.toMatchObject({
      code: "mcp_method_unsupported",
      extra: { reason: "sse" },
    });
    const old = npmEntry({ name: "io.example/old", status: "deprecated" });
    index.add(old);
    await expect(installer.plan(globalRequest("io.example/old"))).rejects.toMatchObject({
      code: "mcp_method_unsupported",
      extra: { reason: "deprecated" },
    });
  });

  it("never runs a command a catalog card supplies", async () => {
    const fx = await installFixture();
    const hostile = npmEntry({
      name: "io.example/hostile",
      identifier: "evil; rm -rf /",
      runtimeHint: "npx",
    });
    const { installer, npm } = await boot(fx, entryIndex(hostile));
    await expect(installer.plan(globalRequest("io.example/hostile"))).rejects.toMatchObject({
      code: "mcp_method_unsupported",
    });
    expect(npm.calls).toEqual([]);
  });

  it("asks only for required inputs without a safe default and stores secrets as references", async () => {
    const fx = await installFixture();
    const entry = npmEntry({
      inputs: [
        { name: "API_KEY", kind: "env", isRequired: true, isSecret: true },
        { name: "ROOT", kind: "env", isRequired: true, isSecret: false },
        { name: "REGION", kind: "env", isRequired: true, isSecret: false, default: "eu" },
        { name: "MODE", kind: "env", isRequired: false, isSecret: false, choices: ["a", "b"] },
        { name: "FIXED", kind: "env", isRequired: true, isSecret: false, value: "yes" },
      ],
    });
    const { installer, secrets } = await boot(fx, entryIndex(entry));
    const plan = await installer.plan(globalRequest());
    expect(plan.requiredInputs.map((i) => [i.id, i.secret])).toEqual([
      ["env.API_KEY", true],
      ["env.ROOT", false],
    ]);
    expect(plan.optionalInputs.map((i) => i.id).sort()).toEqual(["env.MODE", "env.REGION"]);
    const hooks = recordingHooks();
    await expect(
      installer.start({
        planId: plan.planId,
        digest: plan.digest,
        idempotencyKey: idem(),
        inputs: {},
        hooks,
      }),
    ).rejects.toMatchObject({
      code: "mcp_input_required",
      extra: { fields: ["env.API_KEY", "env.ROOT"] },
    });
    const done = await install(installer, hooks, globalRequest(), {
      "env.API_KEY": SECRET,
      "env.ROOT": "/data",
    });
    expect(done.job.state).toBe("completed");
    const config = await readJsonFile(fx.globalFile);
    const entryJson = config.mcp.servers[done.plan.alias];
    expect(entryJson.env).toEqual({ ROOT: "/data", REGION: "eu", FIXED: "yes" });
    expect(entryJson.secretEnv.API_KEY.secret).toMatch(/^mcp:/);
    expect(JSON.stringify(config)).not.toContain(SECRET);
    expect(await secrets.get(entryJson.secretEnv.API_KEY.secret)).toBe(SECRET);
  });

  it("validates answers on the server and never echoes a value", async () => {
    const fx = await installFixture();
    const entry = npmEntry({
      inputs: [
        { name: "API_KEY", kind: "env", isRequired: true, isSecret: true },
        { name: "MODE", kind: "env", isRequired: true, isSecret: false, choices: ["a", "b"] },
      ],
    });
    const { installer } = await boot(fx, entryIndex(entry));
    const plan = await installer.plan(globalRequest());
    const attempt = (inputs: Record<string, unknown>) =>
      installer
        .start({
          planId: plan.planId,
          digest: plan.digest,
          idempotencyKey: idem(),
          inputs,
          hooks: recordingHooks(),
        })
        .catch((e) => e);
    const badChoice = await attempt({ "env.API_KEY": SECRET, "env.MODE": "z" });
    expect(badChoice.extra.fields).toEqual(["env.MODE"]);
    const newline = await attempt({ "env.API_KEY": `${SECRET}\nX: 1`, "env.MODE": "a" });
    expect(newline.extra.fields).toEqual(["env.API_KEY"]);
    const unknown = await attempt({ "env.API_KEY": SECRET, "env.MODE": "a", "env.EXTRA": "x" });
    expect(unknown.extra.fields).toEqual(["env.EXTRA"]);
    const spaces = await attempt({ "env.API_KEY": ` ${SECRET}`, "env.MODE": "a" });
    expect(spaces.extra.fields).toEqual(["env.API_KEY"]);
    for (const error of [badChoice, newline, unknown, spaces])
      expect(`${error.message}${JSON.stringify(error.extra)}`).not.toContain(SECRET);
  });
});

describe("MCP-CAT-31: what is never installed automatically", () => {
  it("refuses a package without an exact version", async () => {
    const fx = await installFixture();
    const { installer, npm } = await boot(
      fx,
      entryIndex(
        npmEntry({ name: "io.example/none", pkgVersion: null }),
        npmEntry({ name: "io.example/range", pkgVersion: "^1.2.0" }),
      ),
    );
    for (const name of ["io.example/none", "io.example/range"])
      await expect(installer.plan(globalRequest(name))).rejects.toMatchObject({
        code: "mcp_method_unsupported",
        extra: { reason: "unversioned" },
      });
    expect(npm.calls).toEqual([]);
  });

  it("refuses a registry other than npm", async () => {
    const fx = await installFixture();
    const { installer } = await boot(
      fx,
      entryIndex(npmEntry({ registryBaseUrl: "https://npm.evil.example" })),
    );
    await expect(installer.plan(globalRequest())).rejects.toMatchObject({
      extra: { reason: "registry" },
    });
  });

  it("removes the download and explains when the lockfile shows install scripts", async () => {
    const fx = await installFixture();
    const npm = fakeNpm({ installScripts: true });
    const { installer } = await boot(fx, entryIndex(npmEntry()), { runNpm: npm.run });
    const hooks = recordingHooks();
    const { job } = await install(installer, hooks, globalRequest());
    expect(job).toMatchObject({ state: "failed", error: { code: "mcp_method_unsupported" } });
    expect(job.error?.message).toMatch(/install scripts/i);
    expect(installer.bindings()).toEqual([]);
    expect(hooks.attached).toEqual([]);
    await expect(readFile(fx.globalFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(fx.artifacts)).filter((n) => !n.startsWith("."))).toEqual([]);
    expect((await readdir(fx.artifacts)).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
  });

  it("does not guess among several executables, and installs once one is chosen", async () => {
    const fx = await installFixture();
    const npm = fakeNpm({ bin: { alpha: "dist/a.js", beta: "dist/b.js" } });
    const { installer } = await boot(fx, entryIndex(npmEntry()), { runNpm: npm.run });
    const first = await install(installer, recordingHooks(), globalRequest());
    expect(first.job).toMatchObject({ state: "failed", error: { code: "mcp_method_unsupported" } });
    expect(first.job.error?.message).toMatch(/several programs/i);
    expect(installer.bindings()).toEqual([]);
    const chosen = await install(installer, recordingHooks(), { ...globalRequest(), bin: "beta" });
    expect(chosen.job.state).toBe("completed");
    const config = await readJsonFile(fx.globalFile);
    expect(config.mcp.servers[chosen.plan.alias].args[0].endsWith(join("dist", "b.js"))).toBe(true);
  });

  it("picks the executable named like the package when several exist", async () => {
    const fx = await installFixture();
    const npm = fakeNpm({ bin: { "mcp-files": "dist/main.js", other: "dist/o.js" } });
    const { installer } = await boot(fx, entryIndex(npmEntry()), { runNpm: npm.run });
    const done = await install(installer, recordingHooks(), globalRequest());
    expect(done.job.state).toBe("completed");
  });
});

describe("remote services (public or referenced HTTP)", () => {
  const headerEntry = () =>
    remoteEntry({
      inputs: [
        { name: "X-Api-Key", kind: "header", isRequired: true, isSecret: true },
        { name: "Authorization", kind: "header", isRequired: false, isSecret: true },
      ],
    });

  it("stores a header value as a protected reference and keeps it out of every shareable place", async () => {
    const fx = await installFixture();
    const { installer, secrets } = await boot(fx, entryIndex(headerEntry()));
    const hooks = recordingHooks();
    const { plan, job } = await install(installer, hooks, globalRequest("io.example/cloud"), {
      "header.X-Api-Key": SECRET,
    });
    expect(plan).toMatchObject({
      method: "remote",
      execution: "remote",
      origin: "https://mcp.example.com",
    });
    expect(job.state).toBe("completed");
    const configText = await readFile(fx.globalFile, "utf8");
    expect(configText).not.toContain(SECRET);
    const entry = JSON.parse(configText).mcp.servers[plan.alias];
    expect(entry).toMatchObject({
      transport: "http",
      url: "https://mcp.example.com/v1",
      enabled: true,
    });
    const id = entry.headers["X-Api-Key"].secret as string;
    expect(await secrets.get(id)).toBe(SECRET);
    expect(installer.bindings()[0]?.secretIds).toContain(id);
    // Not in the installer database, the job, the binding or the plan either.
    const database = await readFile(fx.dbPath);
    expect(database.includes(SECRET)).toBe(false);
    expect(JSON.stringify([plan, job, installer.bindings()])).not.toContain(SECRET);
    expect(hooks.attached.some((a) => JSON.stringify(a.entry).includes(SECRET))).toBe(false);
  });

  it("sends a bare Authorization token as a bearer token", async () => {
    const fx = await installFixture();
    const { installer, secrets } = await boot(fx, entryIndex(headerEntry()));
    const { plan } = await install(installer, recordingHooks(), globalRequest("io.example/cloud"), {
      "header.X-Api-Key": SECRET,
      "header.Authorization": "tok123",
    });
    const entry = (await readJsonFile(fx.globalFile)).mcp.servers[plan.alias];
    expect(await secrets.get(entry.headers.Authorization.secret)).toBe("Bearer tok123");
  });

  it("refuses private, plain-HTTP and credentialed addresses from a catalog card", async () => {
    const fx = await installFixture();
    const index = entryIndex(
      remoteEntry({ name: "io.example/lan", url: "https://192.168.1.10/mcp" }),
      remoteEntry({ name: "io.example/loop", url: "https://localhost:8443/mcp" }),
      remoteEntry({ name: "io.example/plain", url: "http://mcp.example.com/mcp" }),
      remoteEntry({ name: "io.example/cred", url: "https://user:pw@mcp.example.com/mcp" }),
      remoteEntry({ name: "io.example/meta", url: "https://169.254.169.254/latest" }),
    );
    const { installer } = await boot(fx, index, { guard: createUrlGuard() });
    for (const name of ["lan", "loop", "plain", "cred", "meta"])
      await expect(installer.plan(globalRequest(`io.example/${name}`))).rejects.toMatchObject({
        code: "mcp_method_unsupported",
        extra: { reason: "unsafe_address" },
      });
  });

  it("refuses a host that resolves to a private address", async () => {
    const fx = await installFixture();
    const { installer } = await boot(fx, entryIndex(remoteEntry()), {
      guard: createUrlGuard({ resolve: async () => ["93.184.216.34", "10.0.0.5"] }),
    });
    await expect(installer.plan(globalRequest("io.example/cloud"))).rejects.toMatchObject({
      extra: { reason: "unsafe_address" },
    });
  });

  it("fills a URL variable from a validated answer and checks the final address", async () => {
    const fx = await installFixture();
    const entry = remoteEntry({
      url: "https://{api_host}/mcp",
      inputs: [
        {
          name: "api_host",
          kind: "variable",
          isRequired: true,
          isSecret: false,
          choices: ["eu.example.com", "us.example.com"],
        },
      ],
    });
    const { installer } = await boot(fx, entryIndex(entry), {
      guard: createUrlGuard({
        resolve: async (host) => (host === "eu.example.com" ? ["93.184.216.34"] : ["10.0.0.1"]),
      }),
    });
    const ok = await install(installer, recordingHooks(), globalRequest("io.example/cloud"), {
      "variable.api_host": "eu.example.com",
    });
    expect(ok.job.state).toBe("completed");
    expect((await readJsonFile(fx.globalFile)).mcp.servers[ok.plan.alias].url).toBe(
      "https://eu.example.com/mcp",
    );
    const bad = await install(
      installer,
      recordingHooks(),
      { ...globalRequest("io.example/cloud"), alias: "second" },
      { "variable.api_host": "us.example.com" },
    );
    expect(bad.job).toMatchObject({ state: "failed", error: { code: "mcp_method_unsupported" } });
    expect(installer.bindings()).toHaveLength(1);
  });

  it("says a service that needs sign-in is coming soon, instead of failing", async () => {
    const fx = await installFixture();
    const { installer } = await boot(fx, entryIndex(remoteEntry()));
    const hooks = recordingHooks({ connect: failedConnect("needs-authentication") });
    const { job } = await install(installer, hooks, globalRequest("io.example/cloud"));
    expect(job).toMatchObject({
      state: "completed",
      result: { connected: false, status: "needs-authentication", signIn: "available" },
    });
    expect(installer.bindings()).toHaveLength(1);
  });
});

describe("consent stays a separate decision (D5)", () => {
  it("downloads and writes nothing until the caller has obtained MCP consent", async () => {
    const fx = await installFixture();
    const { installer, npm } = await boot(fx, entryIndex(npmEntry()));
    const hooks = recordingHooks({ permission: "not-granted" });
    const plan = await installer.plan({ ...globalRequest(), runtimePermission: "not-granted" });
    expect(plan.requiresConsent).toBe(true);
    const job = await installer.start({
      planId: plan.planId,
      digest: plan.digest,
      idempotencyKey: idem(),
      inputs: {},
      hooks,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(installer.job(job.id)?.state).toBe("awaiting-consent");
    expect(npm.calls).toEqual([]);
    await expect(readFile(fx.globalFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    // Consent that was not really granted does not release the job.
    expect(() => installer.provideConsent(job.id)).toThrowError(/not been granted/);
    hooks.permission = "granted";
    installer.provideConsent(job.id);
    await installer.idle();
    expect(installer.job(job.id)?.state).toBe("completed");
  });

  it("cancelling while it waits leaves nothing behind", async () => {
    const fx = await installFixture();
    const { installer } = await boot(fx, entryIndex(npmEntry()));
    const hooks = recordingHooks({ permission: "not-granted" });
    const plan = await installer.plan({ ...globalRequest(), runtimePermission: "not-granted" });
    const job = await installer.start({
      planId: plan.planId,
      digest: plan.digest,
      idempotencyKey: idem(),
      inputs: {},
      hooks,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect((await installer.cancel(job.id))?.state).toBe("cancelled");
    expect(installer.bindings()).toEqual([]);
  });

  it("refuses to plan under --read-only", async () => {
    const fx = await installFixture();
    const { installer } = await boot(fx, entryIndex(npmEntry()));
    await expect(
      installer.plan({ ...globalRequest(), runtimePermission: "read-only" }),
    ).rejects.toMatchObject({
      code: "mcp_not_permitted",
    });
  });
});

describe("plans are validated, short-lived and tamper-evident", () => {
  it("expires after ten minutes", async () => {
    const fx = await installFixture();
    let now = Date.parse("2026-11-12T10:00:00Z");
    const { installer } = await boot(fx, entryIndex(npmEntry()), { now: () => new Date(now) });
    const plan = await installer.plan(globalRequest());
    expect(Date.parse(plan.expiresAt) - now).toBe(10 * 60_000);
    now += 10 * 60_000 + 1;
    await expect(
      installer.start({
        planId: plan.planId,
        digest: plan.digest,
        idempotencyKey: idem(),
        inputs: {},
        hooks: recordingHooks(),
      }),
    ).rejects.toMatchObject({ code: "mcp_plan_expired" });
  });

  it("rejects a plan whose digest does not match and an unknown plan", async () => {
    const fx = await installFixture();
    const { installer } = await boot(fx, entryIndex(npmEntry()));
    const plan = await installer.plan(globalRequest());
    await expect(
      installer.start({
        planId: plan.planId,
        digest: "0".repeat(64),
        idempotencyKey: idem(),
        inputs: {},
        hooks: recordingHooks(),
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      installer.start({
        planId: "plan_nope",
        digest: plan.digest,
        idempotencyKey: idem(),
        inputs: {},
        hooks: recordingHooks(),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("is invalidated with a conflict when the catalog entry changed", async () => {
    const fx = await installFixture();
    const index = entryIndex(npmEntry());
    const { installer, npm } = await boot(fx, index);
    const plan = await installer.plan(globalRequest());
    index.add({
      ...npmEntry({ title: "Renamed files" }),
      provenance: { ...npmEntry().provenance, rawDigest: "changed" },
    });
    await expect(
      installer.start({
        planId: plan.planId,
        digest: plan.digest,
        idempotencyKey: idem(),
        inputs: {},
        hooks: recordingHooks(),
      }),
    ).rejects.toMatchObject({ code: "mcp_config_conflict" });
    expect(npm.calls).toEqual([]);
  });

  it("separates identities: two upstream names with the same slug get distinct aliases", async () => {
    const fx = await installFixture();
    const a = npmEntry({ name: "io.github.acme/files", identifier: "@acme/files" });
    const b = npmEntry({ name: "io.github.other/files", identifier: "@other/files" });
    const { installer } = await boot(fx, entryIndex(a, b));
    const one = await install(installer, recordingHooks(), globalRequest("io.github.acme/files"));
    const two = await install(installer, recordingHooks(), globalRequest("io.github.other/files"));
    expect(one.job).toMatchObject({ state: "completed" });
    expect(two.job).toMatchObject({ state: "completed" });
    expect(one.plan.alias).not.toBe(two.plan.alias);
    expect(
      installer
        .bindings()
        .map((x) => x.registryName)
        .sort(),
    ).toEqual(["io.github.acme/files", "io.github.other/files"]);
  });
});

describe("scope: project installs keep trust and global stays global", () => {
  it("writes a project entry to the workspace and keeps the project trusted", async () => {
    const fx = await installFixture();
    await trustWorkspace(fx.workspace);
    const { installer } = await boot(fx, entryIndex(npmEntry()));
    const { plan, job } = await install(installer, recordingHooks(), {
      ...globalRequest(),
      scope: "project",
      workspace: { path: fx.workspace },
    });
    expect(job.state).toBe("completed");
    const project = await readJsonFile(fx.projectFile);
    expect(Object.keys(project.mcp.servers)).toEqual([plan.alias]);
    await expect(readFile(fx.globalFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await resolveTrust(fx.workspace)).trusted).toBe(true);
    expect(installer.bindings()[0]).toMatchObject({
      scope: "project",
      workspacePath: fx.workspace,
    });
  });

  it("refuses an untrusted project before planning anything", async () => {
    const fx = await installFixture();
    const { installer, npm } = await boot(fx, entryIndex(npmEntry()));
    await expect(
      installer.plan({ ...globalRequest(), scope: "project", workspace: { path: fx.workspace } }),
    ).rejects.toMatchObject({ code: "mcp_scope_untrusted" });
    expect(npm.calls).toEqual([]);
  });
});

describe("MCP-CAT-12: removing a binding releases only what it owns", () => {
  async function twoBindings() {
    const fx = await installFixture();
    await trustWorkspace(fx.workspace);
    const entry = npmEntry({
      inputs: [{ name: "API_KEY", kind: "env", isRequired: true, isSecret: true }],
    });
    const { installer, secrets, npm } = await boot(fx, entryIndex(entry));
    const globalDone = await install(installer, recordingHooks(), globalRequest(), {
      "env.API_KEY": "g-secret-0001",
    });
    const projectDone = await install(
      installer,
      recordingHooks(),
      { ...globalRequest(), scope: "project", workspace: { path: fx.workspace } },
      { "env.API_KEY": "p-secret-0002" },
    );
    return { fx, installer, secrets, npm, globalDone, projectDone };
  }

  it("shares one artifact between scopes and deletes it only with the last binding", async () => {
    const { fx, installer, secrets, npm, globalDone, projectDone } = await twoBindings();
    // The second install reused the first download.
    expect(npm.calls).toHaveLength(1);
    expect(installer.store.artifacts()).toHaveLength(1);
    const artifactId = installer.store.artifacts()[0]?.id as string;
    const manual = join(fx.root, "manual-tool.js");
    await writeFile(manual, "// the user's own program\n");
    const notOurs = join(fx.artifacts, "not-managed-by-alisio");
    await mkdir(notOurs, { recursive: true });
    const projectBinding = installer.bindings().find((b) => b.scope === "project") as BindingRecord;
    const globalBinding = installer.bindings().find((b) => b.scope === "global") as BindingRecord;
    // Removing the project binding keeps the shared artifact and the global entry.
    const first = await installer.uninstall({
      bindingId: projectBinding.id,
      scope: "project",
      workspacePath: fx.workspace,
      removeSecrets: true,
      hooks: recordingHooks(),
    });
    expect(first).toMatchObject({ removedConfig: true, artifact: "kept", secretsRemoved: true });
    expect(existsSync(join(fx.artifacts, artifactId))).toBe(true);
    expect((await readJsonFile(fx.projectFile)).mcp.servers).toEqual({});
    expect((await readJsonFile(fx.globalFile)).mcp.servers[globalDone.plan.alias]).toBeDefined();
    for (const id of projectBinding.secretIds) expect(await secrets.has(id)).toBe(false);
    for (const id of globalBinding.secretIds) expect(await secrets.has(id)).toBe(true);
    expect(projectDone.job.state).toBe("completed");
    expect(globalDone.job.state).toBe("completed");
    // Removing the last one releases only the managed artifact.
    const last = await installer.uninstall({
      bindingId: globalBinding.id,
      scope: "global",
      removeSecrets: false,
      hooks: recordingHooks(),
    });
    expect(last).toMatchObject({ artifact: "deleted", secretsRemoved: false });
    expect(existsSync(join(fx.artifacts, artifactId))).toBe(false);
    expect(installer.store.artifacts()).toEqual([]);
    expect(existsSync(manual)).toBe(true);
    expect(existsSync(notOurs)).toBe(true);
    // Keys are only deleted on explicit request.
    for (const id of globalBinding.secretIds) expect(await secrets.has(id)).toBe(true);
  });

  it("removes only in the scope asked for and refuses another workspace's binding", async () => {
    const { fx, installer } = await twoBindings();
    const projectBinding = installer.bindings().find((b) => b.scope === "project") as BindingRecord;
    await expect(
      installer.uninstall({
        bindingId: projectBinding.id,
        scope: "global",
        removeSecrets: false,
        hooks: recordingHooks(),
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      installer.uninstall({
        bindingId: projectBinding.id,
        scope: "project",
        workspacePath: join(fx.root, "elsewhere"),
        removeSecrets: false,
        hooks: recordingHooks(),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(installer.bindings()).toHaveLength(2);
  });

  it("keeps an artifact it cannot prove is its own (a symlink out of the root)", async () => {
    const fx = await installFixture();
    const { installer } = await boot(fx, entryIndex(npmEntry()));
    const { plan } = await install(installer, recordingHooks(), globalRequest());
    const id = installer.store.artifacts()[0]?.id as string;
    const outside = join(fx.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "mine");
    await rm(join(fx.artifacts, id), { recursive: true });
    await symlink(outside, join(fx.artifacts, id));
    const binding = installer.bindings()[0] as BindingRecord;
    const result = await installer.uninstall({
      bindingId: binding.id,
      scope: "global",
      removeSecrets: false,
      hooks: recordingHooks(),
    });
    expect(result.artifact).toBe("orphaned");
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(plan.alias).toBeTruthy();
  });
});

describe("MCP-CAT-13: cancellation, deadline, concurrency and crashes", () => {
  it("cancelling a download stops the whole process tree and leaves nothing behind", async () => {
    if (process.platform === "win32") return;
    const fx = await installFixture();
    const pidFile = join(fx.root, "pids.json");
    const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));
      setInterval(() => {}, 1000);
    `;
    const npm = fakeNpm({
      run: (_command, _args, opts) =>
        runProcess(process.execPath, ["-e", script], {
          cwd: opts.cwd,
          signal: opts.signal,
          timeoutMs: 60_000,
          killGraceMs: 200,
        }),
    });
    const { installer } = await boot(fx, entryIndex(npmEntry()), { runNpm: npm.run });
    const plan = await installer.plan(globalRequest());
    const job = await installer.start({
      planId: plan.planId,
      digest: plan.digest,
      idempotencyKey: idem(),
      inputs: {},
      hooks: recordingHooks(),
    });
    const pids: number[] = await until(async () => {
      try {
        return JSON.parse(await readFile(pidFile, "utf8"));
      } catch {
        return undefined;
      }
    });
    for (const pid of pids) expect(isProcessAlive(pid)).toBe(true);
    const cancelled = await installer.cancel(job.id);
    expect(cancelled?.state).toBe("cancelled");
    await until(() => pids.every((pid) => !isProcessAlive(pid)), 5000);
    expect(installer.bindings()).toEqual([]);
    expect((await readdir(fx.artifacts)).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
    await expect(readFile(fx.globalFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    // Cancelling again is harmless.
    expect((await installer.cancel(job.id))?.state).toBe("cancelled");
  });

  it("stops a download that exceeds the deadline", async () => {
    const fx = await installFixture();
    const npm = fakeNpm({ hang: true });
    const { installer } = await boot(fx, entryIndex(npmEntry()), {
      runNpm: npm.run,
      deadlineMs: () => 150,
    });
    const { job } = await install(installer, recordingHooks(), globalRequest());
    expect(job).toMatchObject({ state: "failed", error: { code: "mcp_install_failed" } });
    expect(job.error?.message).toMatch(/too long/i);
    expect((await readdir(fx.artifacts)).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
  });

  it("bounds the configurable deadline to 600 seconds and defaults to 180", async () => {
    const fx = await installFixture();
    expect(readInstallTimeoutMs()).toBe(DEFAULT_INSTALL_TIMEOUT_MS);
    expect(DEFAULT_INSTALL_TIMEOUT_MS).toBe(180_000);
    await writeFile(fx.globalFile, JSON.stringify({ mcp: { install: { timeoutSeconds: 450 } } }));
    expect(readInstallTimeoutMs()).toBe(450_000);
    expect(configSchema.safeParse({ mcp: { install: { timeoutSeconds: 900 } } }).success).toBe(
      false,
    );
    expect(configSchema.safeParse({ mcp: { install: { timeoutSeconds: 450 } } }).success).toBe(
      true,
    );
    expect(clampInstallTimeout(9_999_999)).toBe(MAX_INSTALL_TIMEOUT_MS);
  });

  it("answers the same idempotency key with the same job and never installs twice", async () => {
    const fx = await installFixture();
    const { installer, npm } = await boot(fx, entryIndex(npmEntry()));
    const plan = await installer.plan(globalRequest());
    const request = {
      planId: plan.planId,
      digest: plan.digest,
      idempotencyKey: "double-click",
      inputs: {},
      hooks: recordingHooks(),
    };
    const [a, b] = await Promise.all([installer.start(request), installer.start(request)]);
    expect(a.id).toBe(b.id);
    await installer.idle();
    expect((await installer.start(request)).id).toBe(a.id);
    expect(npm.calls).toHaveLength(1);
    expect(installer.bindings()).toHaveLength(1);
  });

  it("two requests for the same integration leave one binding and a valid configuration", async () => {
    const fx = await installFixture();
    const { installer } = await boot(fx, entryIndex(npmEntry()));
    const planA = await installer.plan(globalRequest());
    const planB = await installer.plan(globalRequest());
    expect(planA.alias).toBe(planB.alias);
    const jobs = await Promise.allSettled([
      installer.start({
        planId: planA.planId,
        digest: planA.digest,
        idempotencyKey: idem(),
        inputs: {},
        hooks: recordingHooks(),
      }),
      installer.start({
        planId: planB.planId,
        digest: planB.digest,
        idempotencyKey: idem(),
        inputs: {},
        hooks: recordingHooks(),
      }),
    ]);
    await installer.idle();
    const views = jobs.flatMap((j) =>
      j.status === "fulfilled" ? [installer.job(j.value.id)] : [],
    );
    expect(views.filter((v) => v?.state === "completed")).toHaveLength(1);
    expect(installer.bindings()).toHaveLength(1);
    const config = await readJsonFile(fx.globalFile);
    expect(Object.keys(config.mcp.servers)).toEqual([planA.alias]);
    expect(configSchema.safeParse(config).success).toBe(true);
  });

  it("undoes a job that a crash interrupted, from its journal, on the next start", async () => {
    const fx = await installFixture();
    const entry = npmEntry({
      inputs: [{ name: "API_KEY", kind: "env", isRequired: true, isSecret: true }],
    });
    const secrets = new MemorySecretStore();
    const first = await boot(fx, entryIndex(entry), { secrets });
    const never = new Promise<ConnectResult>(() => {});
    const hooks = recordingHooks({ connect: () => never });
    const plan = await first.installer.plan(globalRequest());
    const job = await first.installer.start({
      planId: plan.planId,
      digest: plan.digest,
      idempotencyKey: idem(),
      inputs: { "env.API_KEY": SECRET },
      hooks,
    });
    await until(() => first.installer.job(job.id)?.state === "connecting");
    // The process "dies" here: configuration written, binding recorded, key stored, job unfinished.
    expect((await readJsonFile(fx.globalFile)).mcp.servers[plan.alias]).toBeDefined();
    expect(first.installer.bindings()).toHaveLength(1);
    const restarted = await boot(fx, entryIndex(entry), { secrets });
    const report = await restarted.installer.reconcile();
    expect(report.interruptedJobs).toEqual([job.id]);
    expect(restarted.installer.job(job.id)).toMatchObject({
      state: "failed",
      error: { code: "mcp_install_failed" },
    });
    expect(restarted.installer.bindings()).toEqual([]);
    expect((await readJsonFile(fx.globalFile)).mcp.servers).toEqual({});
    expect((await readdir(fx.artifacts)).filter((n) => !n.startsWith("."))).toEqual([]);
    for (const id of first.installer.store.bindings().flatMap((b) => b.secretIds))
      expect(await secrets.has(id)).toBe(false);
    first.installer.store.close();
    await restarted.installer.close();
  });

  it("reconcile leaves a manual entry with the same name alone and cleans stray temporary directories", async () => {
    const fx = await installFixture();
    const { installer } = await boot(fx, entryIndex(npmEntry()));
    // A database exists once anything was installed or planned to be.
    expect(installer.store.bindings()).toEqual([]);
    await mkdir(join(fx.artifacts, ".tmp-job_dead"), { recursive: true });
    await mkdir(join(fx.artifacts, "files-1.0.0-deadbeef"), { recursive: true });
    await writeFile(
      fx.globalFile,
      JSON.stringify({ mcp: { servers: { handmade: { command: "node" } } } }),
    );
    const report = await installer.reconcile();
    expect(report.removedTemporary).toEqual([".tmp-job_dead"]);
    expect(report.orphanArtifacts).toEqual(["files-1.0.0-deadbeef"]);
    expect(existsSync(join(fx.artifacts, "files-1.0.0-deadbeef"))).toBe(true);
    expect(JSON.parse(await readFile(fx.globalFile, "utf8")).mcp.servers.handmade).toBeDefined();
    expect(await installer.cleanupOrphans()).toEqual(["files-1.0.0-deadbeef"]);
    expect(existsSync(join(fx.artifacts, "files-1.0.0-deadbeef"))).toBe(false);
  });

  it("drops a binding whose configuration entry was removed by hand, without touching other entries", async () => {
    const fx = await installFixture();
    const { installer } = await boot(fx, entryIndex(npmEntry()));
    const { plan } = await install(installer, recordingHooks(), globalRequest());
    const config = await readJsonFile(fx.globalFile);
    delete config.mcp.servers[plan.alias];
    config.mcp.servers.handmade = { command: "node" };
    await writeFile(fx.globalFile, JSON.stringify(config));
    const report = await installer.reconcile();
    expect(report.droppedBindings).toHaveLength(1);
    expect(installer.bindings()).toEqual([]);
    expect(JSON.parse(await readFile(fx.globalFile, "utf8")).mcp.servers.handmade).toBeDefined();
  });
});

describe("MCP-CAT-15: external edits and failed updates", () => {
  it("returns a conflict, writing nothing, when the file changed after the plan", async () => {
    const fx = await installFixture();
    const { installer, npm } = await boot(fx, entryIndex(npmEntry()));
    const plan = await installer.plan(globalRequest());
    await writeFile(
      fx.globalFile,
      JSON.stringify({ mcp: { servers: { manual: { command: "node" } } } }),
    );
    await expect(
      installer.start({
        planId: plan.planId,
        digest: plan.digest,
        idempotencyKey: idem(),
        inputs: {},
        hooks: recordingHooks(),
      }),
    ).rejects.toMatchObject({ code: "mcp_config_conflict" });
    expect(npm.calls).toEqual([]);
    expect(JSON.parse(await readFile(fx.globalFile, "utf8")).mcp.servers.manual).toBeDefined();
  });

  it("an edit that lands while the job runs is never reverted: the job fails and keeps the edit", async () => {
    const fx = await installFixture();
    const npm = fakeNpm({
      run: async (command, args, opts, limits) => {
        const result = await fakeNpm().run(command, args, opts, limits);
        await writeFile(
          fx.globalFile,
          JSON.stringify({ mcp: { servers: { manual: { command: "node" } } } }),
        );
        return result;
      },
    });
    const { installer } = await boot(fx, entryIndex(npmEntry()), { runNpm: npm.run });
    const { job } = await install(installer, recordingHooks(), globalRequest());
    expect(job).toMatchObject({ state: "failed", error: { code: "mcp_config_conflict" } });
    expect(JSON.parse(await readFile(fx.globalFile, "utf8")).mcp.servers.manual).toBeDefined();
    expect(installer.bindings()).toEqual([]);
  });

  async function installed() {
    const fx = await installFixture();
    const v1 = npmEntry({ version: "1.0.0" });
    const v2 = npmEntry({ version: "2.0.0" });
    const index = entryIndex(v1, v2);
    const booted = await boot(fx, index);
    // v1 is not the latest: the install pins the version it asks for.
    (v1 as { isLatest: boolean }).isLatest = false;
    const done = await install(booted.installer, recordingHooks(), {
      ...globalRequest(),
      version: "1.0.0",
    });
    expect(done.job.state).toBe("completed");
    return { fx, ...booted, alias: done.plan.alias };
  }

  it("updates to a newer version in parallel and releases the old artifact", async () => {
    const { fx, installer, alias } = await installed();
    const before = (await readJsonFile(fx.globalFile)).mcp.servers[alias];
    const binding = installer.bindings()[0] as BindingRecord;
    const oldArtifact = binding.artifactId as string;
    const plan = await installer.planUpdate(binding.id, { runtimePermission: "granted" });
    expect(plan).toMatchObject({
      kind: "update",
      fromVersion: "1.0.0",
      registryVersion: "2.0.0",
      alias,
      bindingId: binding.id,
    });
    const hooks = recordingHooks();
    const job = await installer.start({
      planId: plan.planId,
      digest: plan.digest,
      idempotencyKey: idem(),
      inputs: {},
      hooks,
    });
    await installer.idle();
    expect(installer.job(job.id)).toMatchObject({
      state: "completed",
      kind: "update",
      result: { connected: true },
    });
    const after = (await readJsonFile(fx.globalFile)).mcp.servers[alias];
    expect(after.args[0]).not.toBe(before.args[0]);
    expect(installer.bindings()).toHaveLength(1);
    expect(installer.bindings()[0]).toMatchObject({ id: binding.id, registryVersion: "2.0.0" });
    expect(existsSync(join(fx.artifacts, oldArtifact))).toBe(false);
    expect(existsSync(after.args[0])).toBe(true);
  });

  it("restores the previous version when the new one does not connect", async () => {
    const { fx, installer, alias } = await installed();
    const before = (await readJsonFile(fx.globalFile)).mcp.servers[alias];
    const binding = installer.bindings()[0] as BindingRecord;
    const plan = await installer.planUpdate(binding.id, { runtimePermission: "granted" });
    const hooks = recordingHooks({ connect: failedConnect() });
    const job = await installer.start({
      planId: plan.planId,
      digest: plan.digest,
      idempotencyKey: idem(),
      inputs: {},
      hooks,
    });
    await installer.idle();
    expect(installer.job(job.id)).toMatchObject({
      state: "failed",
      error: { code: "mcp_install_failed" },
    });
    expect(installer.job(job.id)?.error?.message).toMatch(/previous version was restored/i);
    expect((await readJsonFile(fx.globalFile)).mcp.servers[alias]).toEqual(before);
    expect(installer.bindings()[0]).toMatchObject({
      registryVersion: "1.0.0",
      artifactId: binding.artifactId,
    });
    expect(existsSync(before.args[0])).toBe(true);
    // The failed new artifact is gone; the previous one is the only one left.
    expect(installer.store.artifacts().map((a) => a.id)).toEqual([binding.artifactId]);
    expect(hooks.attached.at(-1)?.entry).toEqual(before);
  });

  it("an update plan conflicts when the file was edited in between", async () => {
    const { fx, installer, alias } = await installed();
    const binding = installer.bindings()[0] as BindingRecord;
    const plan = await installer.planUpdate(binding.id, { runtimePermission: "granted" });
    const config = await readJsonFile(fx.globalFile);
    config.mcp.servers.manual = { command: "node" };
    await writeFile(fx.globalFile, JSON.stringify(config));
    await expect(
      installer.start({
        planId: plan.planId,
        digest: plan.digest,
        idempotencyKey: idem(),
        inputs: {},
        hooks: recordingHooks(),
      }),
    ).rejects.toMatchObject({ code: "mcp_config_conflict" });
    expect(installer.bindings()[0]?.registryVersion).toBe("1.0.0");
    expect(alias).toBeTruthy();
  });

  it("keeps an installed integration when only its connection fails (INST-06)", async () => {
    const fx = await installFixture();
    const { installer } = await boot(fx, entryIndex(npmEntry()));
    const hooks = recordingHooks({ connect: failedConnect() });
    const { plan, job } = await install(installer, hooks, globalRequest());
    expect(job).toMatchObject({
      state: "completed",
      result: { connected: false, status: "failed" },
    });
    expect((await readJsonFile(fx.globalFile)).mcp.servers[plan.alias]).toBeDefined();
    expect(installer.bindings()[0]?.lastTest).toMatchObject({ status: "failed" });
  });
});

describe("the installer database stays absent until something is installed", () => {
  it("reading bindings or reconciling creates no file for a user who never installed", async () => {
    const fx = await installFixture();
    const { installer } = await boot(fx, entryIndex(npmEntry()));
    expect(installer.bindings()).toEqual([]);
    expect(installer.job("job_none")).toBeUndefined();
    expect(await installer.reconcile()).toEqual({
      interruptedJobs: [],
      droppedBindings: [],
      orphanArtifacts: [],
      removedTemporary: [],
    });
    expect(existsSync(fx.dbPath)).toBe(false);
    await installer.plan(globalRequest());
    expect(existsSync(fx.dbPath)).toBe(false);
  });
});

describe("SSRF guard (D20) and runtime resolution (O9)", () => {
  it("classifies loopback, private, link-local, mapped and unique-local addresses as not public", async () => {
    const { isPrivateAddress } = await import("../packages/core/src/mcp/net-guard.ts");
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.10",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "[::1]",
    ])
      expect(isPrivateAddress(address), address).toBe(true);
    for (const address of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"])
      expect(isPrivateAddress(address), address).toBe(false);
  });

  it("prefers the system Node and falls back to the runtime Alisio runs on (Electron as Node)", async () => {
    const { resolveNodeRuntime, npmAvailable } = await import(
      "../packages/core/src/mcp/runtime.ts"
    );
    const found = resolveNodeRuntime({
      env: { PATH: "/usr/bin:/opt/node/bin" },
      platform: "linux",
      isExecutable: (path) => path === "/opt/node/bin/node",
    });
    expect(found).toEqual({ kind: "system", command: "/opt/node/bin/node", env: {} });
    const electron = resolveNodeRuntime({
      env: { PATH: "/usr/bin" },
      platform: "linux",
      isExecutable: () => false,
      versions: { electron: "33.0.0" },
      execPath: "/opt/Alisio/alisio",
    });
    expect(electron).toEqual({
      kind: "bundled",
      command: "/opt/Alisio/alisio",
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(
      resolveNodeRuntime({
        env: { PATH: "" },
        isExecutable: () => false,
        versions: {},
        execPath: "/usr/local/bin/node",
      }),
    ).toEqual({ kind: "bundled", command: "/usr/local/bin/node", env: {} });
    // npm: Alisio's bundled copy counts, a system one counts, nothing does not.
    expect(
      npmAvailable({
        env: { ALISIO_NPM_CLI: "/app/npm-cli.js", PATH: "" },
        isExecutable: (p) => p === "/app/npm-cli.js",
      }),
    ).toBe(true);
    expect(
      npmAvailable({
        env: { PATH: "/bin" },
        platform: "linux",
        isExecutable: (p) => p === "/bin/npm",
      }),
    ).toBe(true);
    expect(
      npmAvailable({ env: { PATH: "/bin" }, platform: "linux", isExecutable: () => false }),
    ).toBe(false);
  });

  it("resolves a bin path only inside the package and never an escaping or absolute one", async () => {
    const { resolveBin, readLockfile } = await import(
      "../packages/core/src/mcp/installation/bin-resolver.ts"
    );
    expect(resolveBin({ bin: "dist/cli.js" }, "@scope/tool")).toEqual({
      ok: true,
      name: "tool",
      path: join("dist", "cli.js"),
    });
    expect(resolveBin({ bin: "../../../etc/passwd" }, "tool")).toMatchObject({
      ok: false,
      reason: "unsafe_bin",
    });
    expect(resolveBin({ bin: "/etc/passwd" }, "tool")).toMatchObject({
      ok: false,
      reason: "unsafe_bin",
    });
    expect(resolveBin({}, "tool")).toMatchObject({ ok: false, reason: "no_bin" });
    expect(resolveBin({ bin: { a: "a.js", b: "b.js" } }, "tool", "zzz")).toMatchObject({
      ok: false,
      reason: "unknown_bin",
    });
    expect(
      readLockfile(
        {
          packages: {
            "": {},
            "node_modules/a": { hasInstallScript: true },
            "node_modules/x/node_modules/b": { hasInstallScript: true },
            "node_modules/tool": { integrity: "sha512-abc" },
          },
        },
        "tool",
      ),
    ).toEqual({ installScripts: ["a", "b"], integrity: "sha512-abc" });
  });
});
