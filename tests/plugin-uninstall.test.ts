import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type InstallRunner,
  installedGlobalPlugins,
  installPlugin,
  uninstallPlugin,
} from "../packages/core/src/index.ts";

async function home() {
  const root = await mkdtemp(join(tmpdir(), "alisio-uninstall-"));
  const dir = join(root, "config");
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Fake npm: install writes the package; uninstall deletes its directory. */
function fakeNpm(calls: string[][], fail?: string): InstallRunner {
  return async (_command, args) => {
    calls.push(args);
    if (fail) return { stdout: "", stderr: fail, exitCode: 1, truncated: false };
    const prefix = args[args.indexOf("--prefix") + 1] as string;
    const name = args.at(-1) as string;
    const dir = join(prefix, "node_modules", name);
    if (args[0] === "uninstall") {
      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });
    } else {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
    }
    return { stdout: "ok", stderr: "", exitCode: 0, truncated: false };
  };
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const readConfig = async (h: string) =>
  JSON.parse(await readFile(join(h, "config.json"), "utf8")) as Record<string, unknown>;

describe("uninstallPlugin", () => {
  it("runs npm uninstall --prefix and removes the name from the global config", async () => {
    const h = await home();
    const calls: string[][] = [];
    const runner = fakeNpm(calls);
    await installPlugin({ spec: "npm:@scope/plugin-a", configHome: h, runner });
    await installPlugin({ spec: "npm:plugin-b", configHome: h, runner });
    await writeFile(
      join(h, "config.json"),
      `${JSON.stringify({ ...(await readConfig(h)), skills: ["./keep"] })}\n`,
    );
    calls.length = 0;
    const result = await uninstallPlugin({ packageName: "@scope/plugin-a", configHome: h, runner });
    expect(calls).toEqual([["uninstall", "--prefix", join(h, "plugins"), "@scope/plugin-a"]]);
    expect(result).toMatchObject({ packageName: "@scope/plugin-a", removed: true });
    expect(await exists(join(h, "plugins", "node_modules", "@scope", "plugin-a"))).toBe(false);
    const config = await readConfig(h);
    expect(config.plugins).toEqual(["plugin-b"]);
    expect(config.skills).toEqual(["./keep"]);
  });

  it("is idempotent: a package that is not installed is a no-op without npm", async () => {
    const h = await home();
    const calls: string[][] = [];
    const result = await uninstallPlugin({
      packageName: "plugin-gone",
      configHome: h,
      runner: fakeNpm(calls),
    });
    expect(calls).toEqual([]);
    expect(result.removed).toBe(false);
  });

  it("drops a stale config entry even when the package directory is gone", async () => {
    const h = await home();
    await writeFile(join(h, "config.json"), JSON.stringify({ plugins: ["stale", "keep"] }));
    const calls: string[][] = [];
    const result = await uninstallPlugin({
      packageName: "stale",
      configHome: h,
      runner: fakeNpm(calls),
    });
    expect(calls).toEqual([]);
    expect(result.removed).toBe(true);
    expect((await readConfig(h)).plugins).toEqual(["keep"]);
  });

  it("keeps the config entry when npm fails", async () => {
    const h = await home();
    const runner = fakeNpm([]);
    await installPlugin({ spec: "plugin-a", configHome: h, runner });
    await expect(
      uninstallPlugin({ packageName: "plugin-a", configHome: h, runner: fakeNpm([], "EBUSY") }),
    ).rejects.toThrow(/npm uninstall failed/);
    expect((await readConfig(h)).plugins).toEqual(["plugin-a"]);
  });

  it.each(["", "../evil", "a;b", "git:x/y", "plugin-a@1.0.0", "/abs"])(
    "refuses the invalid package name %j",
    async (name) => {
      await expect(
        uninstallPlugin({ packageName: name, configHome: await home(), runner: fakeNpm([]) }),
      ).rejects.toThrow();
    },
  );

  it("refuses under --read-only", async () => {
    await expect(
      uninstallPlugin({
        packageName: "plugin-a",
        configHome: await home(),
        readOnly: true,
        runner: fakeNpm([]),
      }),
    ).rejects.toThrow(/read-only/);
  });
});

describe("installedGlobalPlugins", () => {
  it("lists configured, really installed packages with their versions", async () => {
    const h = await home();
    const runner = fakeNpm([]);
    await installPlugin({ spec: "plugin-a", configHome: h, runner });
    await installPlugin({ spec: "@s/plugin-b", configHome: h, runner });
    expect(await installedGlobalPlugins(h)).toEqual([
      { name: "plugin-a", version: "1.0.0" },
      { name: "@s/plugin-b", version: "1.0.0" },
    ]);
  });
});
