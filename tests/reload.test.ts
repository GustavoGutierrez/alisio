import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplication } from "../packages/core/src/application.ts";
import {
  formatReloadReport,
  type ReloadableApp,
  ReloadFailedError,
  ReloadRefusedError,
  reloadApplication,
  validateReloadConfig,
} from "../packages/core/src/reload.ts";

/** A structural application with the parts a reload reads. */
function fakeApp(
  overrides: {
    skills?: string[];
    prompts?: string[];
    config?: object;
    plugins?: Array<{ id: string; builtin: boolean; status?: string }>;
  } = {},
): ReloadableApp & { closed: number } {
  const app = {
    closed: 0,
    config: overrides.config ?? { limits: { maxTurns: 5 } },
    skillCatalog: () =>
      (overrides.skills ?? []).map((id) => ({
        id,
        enabled: true,
        effective: true,
        description: id,
      })),
    prompts: {
      templates: new Map((overrides.prompts ?? []).map((name) => [name, { name }])),
      diagnostics: [] as unknown[],
    },
    mcp: { list: () => [] as Array<{ name: string }> },
    pluginCatalog: () =>
      (overrides.plugins ?? []).map((plugin) => ({
        enabled: true,
        status: "active",
        ...plugin,
      })),
    plugins: { pluginState: () => undefined },
    async close() {
      app.closed++;
    },
  };
  return app;
}

describe("reloadApplication (validate, then apply)", () => {
  it("refuses while busy and changes nothing", async () => {
    const current = fakeApp();
    const create = vi.fn(async () => fakeApp());
    const swap = vi.fn();
    await expect(
      reloadApplication({ current, busy: () => "a turn is running", create, swap }),
    ).rejects.toBeInstanceOf(ReloadRefusedError);
    expect(create).not.toHaveBeenCalled();
    expect(swap).not.toHaveBeenCalled();
    expect(current.closed).toBe(0);
  });

  it("stops at a failed validation before building anything", async () => {
    const current = fakeApp();
    const create = vi.fn(async () => fakeApp());
    const swap = vi.fn();
    const error = await reloadApplication({
      current,
      validate: async () => {
        throw new ReloadFailedError("config", "limits.maxTurns must be a number");
      },
      create,
      swap,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ stage: "config", message: "limits.maxTurns must be a number" });
    expect(create).not.toHaveBeenCalled();
    expect(current.closed).toBe(0);
  });

  it("keeps the current application when the new one cannot be built", async () => {
    const current = fakeApp();
    const swap = vi.fn();
    const error = await reloadApplication({
      current,
      create: async () => {
        throw new Error("plugin exploded");
      },
      swap,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ stage: "build", message: "plugin exploded" });
    expect(swap).not.toHaveBeenCalled();
    expect(current.closed).toBe(0);
  });

  it("closes the NEW application and keeps the old one when the swap fails", async () => {
    const current = fakeApp();
    const next = fakeApp();
    const error = await reloadApplication({
      current,
      create: async () => next,
      swap: () => {
        throw new Error("could not rebind");
      },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ stage: "swap" });
    expect(next.closed).toBe(1);
    expect(current.closed).toBe(0);
  });

  it("swaps, closes the previous application and reports what changed", async () => {
    const current = fakeApp({
      skills: ["review"],
      prompts: ["fix"],
      plugins: [{ id: "memory", builtin: true }],
    });
    const next = fakeApp({
      skills: ["review", "deploy"],
      prompts: [],
      config: { limits: { maxTurns: 9 } },
      plugins: [
        { id: "memory", builtin: true },
        { id: "wayfinder", builtin: false },
      ],
    });
    const installed: ReloadableApp[] = [];
    const report = await reloadApplication({
      current,
      create: async () => next,
      swap: (app) => {
        installed.push(app);
      },
    });
    expect(installed).toEqual([next]);
    expect(current.closed).toBe(1);
    const area = (name: string) => report.refreshed.find((r) => r.area === name);
    expect(area("skills")).toMatchObject({ before: 1, after: 2, added: ["deploy"], removed: [] });
    expect(area("prompts")).toMatchObject({ before: 1, after: 0, removed: ["fix"] });
    expect(area("config")?.changed).toEqual(["limits"]);
    expect(area("plugins")).toMatchObject({ added: ["wayfinder"] });
    // Imported plugin code cannot be reloaded: it is reported, never silently skipped.
    expect(report.restartRequired.join(" ")).toContain("wayfinder");
    const text = formatReloadReport(report);
    expect(text).toContain("**Reload complete**");
    expect(text).toContain("- skills: 1 → 2 · added deploy");
    expect(text).toContain("**Needs a restart**");
    expect(text).toContain("Launch flags");
  });

  it("reports an unchanged configuration honestly", async () => {
    const current = fakeApp();
    const report = await reloadApplication({
      current,
      create: async () => fakeApp(),
      swap: () => undefined,
    });
    expect(report.restartRequired).toEqual([]);
    expect(formatReloadReport(report)).toContain("configuration: reloaded, no changes");
  });
});

describe("reload with a real application", () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function workspace() {
    const root = await mkdtemp(join(tmpdir(), "alisio-reload-"));
    roots.push(root);
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    await mkdir(join(root, "ws", ".alisio"), { recursive: true });
    await writeFile(
      join(root, "ws", ".alisio", "config.json"),
      JSON.stringify({ schemaVersion: 1, limits: { maxTurns: 7 } }),
    );
    return { root, ws: join(root, "ws") };
  }

  it("a broken config leaves the running application and its session intact", async () => {
    const { ws } = await workspace();
    const options = { cwd: ws, trustProject: true, noHerdr: true };
    const app = await createApplication(options);
    try {
      const session = app.store.create(ws, app.provider.id, app.provider.model).id;
      await writeFile(join(ws, ".alisio", "config.json"), "{ this is not json");
      const swap = vi.fn();
      const error = await reloadApplication({
        current: app,
        validate: () => validateReloadConfig(options),
        create: () => createApplication(options),
        swap,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ReloadFailedError);
      expect((error as ReloadFailedError).stage).toBe("config");
      expect(swap).not.toHaveBeenCalled();
      // The session is still readable and writable through the untouched application.
      expect(app.store.get(session).id).toBe(session);
      app.store.append(session, { role: "user", text: "still here" });
      expect(app.store.messages(session).at(-1)).toMatchObject({ text: "still here" });
    } finally {
      await app.close();
    }
  });

  it("applies a fixed config and a new prompt template, then closes the old application", async () => {
    const { root, ws } = await workspace();
    const options = { cwd: ws, trustProject: true, noHerdr: true };
    const first = await createApplication(options);
    let current = first;
    const session = first.store.create(ws, first.provider.id, first.provider.model).id;
    try {
      await mkdir(join(ws, ".alisio", "prompts"), { recursive: true });
      await writeFile(
        join(ws, ".alisio", "prompts", "ship.md"),
        "---\ndescription: Ship it\n---\nShip the change.\n",
      );
      await writeFile(
        join(ws, ".alisio", "config.json"),
        JSON.stringify({ schemaVersion: 1, limits: { maxTurns: 11 } }),
      );
      const report = await reloadApplication({
        current,
        validate: () => validateReloadConfig(options),
        create: () => createApplication(options),
        swap: (next) => {
          current = next;
        },
      });
      expect(current).not.toBe(first);
      expect(current.config.limits.maxTurns).toBe(11);
      expect(current.prompts.templates.has("ship")).toBe(true);
      expect(report.refreshed.find((r) => r.area === "prompts")?.added).toEqual(["ship"]);
      expect(report.refreshed.find((r) => r.area === "config")?.changed).toContain("limits");
      // The persisted session survives the swap: the new application reads the same database.
      expect(current.store.get(session).id).toBe(session);
      expect(root).toBeTruthy();
    } finally {
      await current.close();
      if (current !== first) await first.close().catch(() => undefined);
    }
  });
});
