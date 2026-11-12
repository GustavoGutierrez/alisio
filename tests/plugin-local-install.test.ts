import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type InstallRunner,
  inspectPluginTarball,
  installLocalPluginTarball,
  uninstallPlugin,
} from "../packages/core/src/index.ts";
import { pluginTarball } from "./tarball-helpers.ts";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "alisio-local-install-"));
  const home = join(root, "config");
  await mkdir(home, { recursive: true });
  const original = async (over: Record<string, unknown> = {}, name = "ica.tgz") => {
    const path = join(root, name);
    await writeFile(path, pluginTarball(over));
    return path;
  };
  return { root, home, original, plugins: join(home, "plugins") };
}

interface Fake {
  calls: string[][];
  fail?: "before" | "partial";
  runner: InstallRunner;
}

/** A fake npm that extracts nothing but records the file: spec exactly as npm would. */
function fakeNpm(): Fake {
  const state: Fake = {
    calls: [],
    runner: async (_c, args) => {
      state.calls.push(args);
      const prefix = args[args.indexOf("--prefix") + 1] as string;
      const target = args.at(-1) as string;
      const manifestPath = join(prefix, "package.json");
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8").catch(() => '{"dependencies":{}}'),
      );
      if (args[0] === "uninstall") {
        const dir = join(prefix, "node_modules", target);
        await rm(dir, { recursive: true, force: true });
        delete manifest.dependencies[target];
        await writeFile(manifestPath, JSON.stringify(manifest));
        return { stdout: "", stderr: "", exitCode: 0, truncated: false };
      }
      const info = await inspectPluginTarball(target);
      const name = info.name as string;
      if (state.fail === "before")
        return { stdout: "", stderr: "npm ERR! network down", exitCode: 1, truncated: false };
      const dir = join(prefix, "node_modules", name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: info.version }));
      manifest.dependencies ??= {};
      manifest.dependencies[name] = `file:${relative(prefix, target).split("\\").join("/")}`;
      await writeFile(manifestPath, JSON.stringify(manifest));
      if (state.fail === "partial")
        return { stdout: "", stderr: "npm ERR! postinstall failed", exitCode: 1, truncated: false };
      return { stdout: "added 1 package", stderr: "", exitCode: 0, truncated: false };
    },
  };
  return state;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const config = async (home: string) =>
  JSON.parse(await readFile(join(home, "config.json"), "utf8")) as { plugins?: string[] };
const stored = async (plugins: string) =>
  (await readdir(join(plugins, "local-packages")).catch(() => [])).sort();

describe("installLocalPluginTarball", () => {
  it("copies the tarball into a stable store and installs from that path", async () => {
    const { home, original, plugins } = await setup();
    const source = await original();
    const npm = fakeNpm();
    const phases: string[] = [];
    const result = await installLocalPluginTarball({
      tarballPath: source,
      configHome: home,
      runner: npm.runner,
      onPhase: (phase) => phases.push(phase),
    });
    const storedPath = join(plugins, "local-packages", "alisio-plugin-ica-0.1.0.tgz");
    expect(phases).toEqual(["validating", "copying", "installing", "registering"]);
    expect(npm.calls).toEqual([["install", "--prefix", plugins, storedPath]]);
    expect(result).toMatchObject({
      packageName: "@alisio/plugin-ica",
      installedVersion: "0.1.0",
      alreadyInstalled: false,
      updated: false,
      storedPath,
      spec: "file:local-packages/alisio-plugin-ica-0.1.0.tgz",
    });
    const deps = JSON.parse(await readFile(join(plugins, "package.json"), "utf8")).dependencies;
    expect(deps["@alisio/plugin-ica"]).toBe("file:local-packages/alisio-plugin-ica-0.1.0.tgz");
    expect((await config(home)).plugins).toEqual(["@alisio/plugin-ica"]);
    // The original is only read, never moved.
    expect(await exists(source)).toBe(true);
  });

  it("refuses a file that is not an Alisio plugin and copies nothing", async () => {
    const { home, original, plugins } = await setup();
    const source = await original({ keywords: ["other"] });
    const npm = fakeNpm();
    await expect(
      installLocalPluginTarball({ tarballPath: source, configHome: home, runner: npm.runner }),
    ).rejects.toThrow(/not a valid Alisio plugin[\s\S]*alisio-plugin/);
    expect(npm.calls).toEqual([]);
    expect(await stored(plugins)).toEqual([]);
  });

  it("rolls back a failed npm install: no stored copy, no package, config untouched", async () => {
    const { home, original, plugins } = await setup();
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ plugins: ["keep"], schemaVersion: 1 }),
    );
    const npm = fakeNpm();
    npm.fail = "before";
    await expect(
      installLocalPluginTarball({
        tarballPath: await original(),
        configHome: home,
        runner: npm.runner,
      }),
    ).rejects.toThrow(/npm install failed[\s\S]*network down/);
    expect(await stored(plugins)).toEqual([]);
    expect(await exists(join(plugins, "node_modules", "@alisio", "plugin-ica"))).toBe(false);
    expect((await config(home)).plugins).toEqual(["keep"]);
  });

  it("rolls back a partial install with npm uninstall and keeps the failing output tail", async () => {
    const { home, original, plugins } = await setup();
    const npm = fakeNpm();
    npm.fail = "partial";
    const error = await installLocalPluginTarball({
      tarballPath: await original(),
      configHome: home,
      runner: npm.runner,
    }).catch((e) => e as Error & { logTail?: string });
    expect((error as Error).message).toMatch(/postinstall failed/);
    expect((error as { logTail?: string }).logTail).toMatch(/postinstall failed/);
    expect(npm.calls.map((c) => c[0])).toEqual(["install", "uninstall"]);
    expect(await stored(plugins)).toEqual([]);
    expect(await exists(join(plugins, "node_modules", "@alisio", "plugin-ica"))).toBe(false);
    expect(await exists(join(home, "config.json"))).toBe(false);
  });

  it("an update replaces the stored tarball of the old version", async () => {
    const { home, original, plugins } = await setup();
    const npm = fakeNpm();
    await installLocalPluginTarball({
      tarballPath: await original(),
      configHome: home,
      runner: npm.runner,
    });
    const result = await installLocalPluginTarball({
      tarballPath: await original({ version: "0.2.0" }, "ica2.tgz"),
      configHome: home,
      runner: npm.runner,
    });
    expect(result).toMatchObject({
      alreadyInstalled: true,
      updated: true,
      previousVersion: "0.1.0",
      installedVersion: "0.2.0",
    });
    expect(await stored(plugins)).toEqual(["alisio-plugin-ica-0.2.0.tgz"]);
    expect((await config(home)).plugins).toEqual(["@alisio/plugin-ica"]);
  });

  it("a failed update keeps the old stored tarball", async () => {
    const { home, original, plugins } = await setup();
    const npm = fakeNpm();
    await installLocalPluginTarball({
      tarballPath: await original(),
      configHome: home,
      runner: npm.runner,
    });
    npm.fail = "before";
    await expect(
      installLocalPluginTarball({
        tarballPath: await original({ version: "0.2.0" }, "ica2.tgz"),
        configHome: home,
        runner: npm.runner,
      }),
    ).rejects.toThrow();
    expect(await stored(plugins)).toEqual(["alisio-plugin-ica-0.1.0.tgz"]);
    expect((await config(home)).plugins).toEqual(["@alisio/plugin-ica"]);
  });

  it("restores the previous copy when reinstalling the same version fails", async () => {
    const { home, original, plugins } = await setup();
    const npm = fakeNpm();
    await installLocalPluginTarball({
      tarballPath: await original(),
      configHome: home,
      runner: npm.runner,
    });
    const before = await readFile(join(plugins, "local-packages", "alisio-plugin-ica-0.1.0.tgz"));
    npm.fail = "before";
    await expect(
      installLocalPluginTarball({
        tarballPath: await original({ description: "changed" }, "ica-b.tgz"),
        configHome: home,
        runner: npm.runner,
      }),
    ).rejects.toThrow();
    expect(await stored(plugins)).toEqual(["alisio-plugin-ica-0.1.0.tgz"]);
    expect(await readFile(join(plugins, "local-packages", "alisio-plugin-ica-0.1.0.tgz"))).toEqual(
      before,
    );
  });

  it("a half-way failed update restores the previous version and its file: spec", async () => {
    const { home, original, plugins } = await setup();
    const npm = fakeNpm();
    await installLocalPluginTarball({
      tarballPath: await original(),
      configHome: home,
      runner: npm.runner,
    });
    npm.fail = "partial";
    await expect(
      installLocalPluginTarball({
        tarballPath: await original({ version: "0.2.0" }, "ica2.tgz"),
        configHome: home,
        runner: npm.runner,
      }),
    ).rejects.toThrow(/postinstall failed/);
    const installed = JSON.parse(
      await readFile(
        join(plugins, "node_modules", "@alisio", "plugin-ica", "package.json"),
        "utf8",
      ),
    );
    expect(installed.version).toBe("0.1.0");
    const deps = JSON.parse(await readFile(join(plugins, "package.json"), "utf8")).dependencies;
    expect(deps["@alisio/plugin-ica"]).toBe("file:local-packages/alisio-plugin-ica-0.1.0.tgz");
    expect(await stored(plugins)).toEqual(["alisio-plugin-ica-0.1.0.tgz"]);
    expect((await config(home)).plugins).toEqual(["@alisio/plugin-ica"]);
  });

  it("rolls a first install back completely when the installed plugin does not start", async () => {
    const { home, original, plugins } = await setup();
    const npm = fakeNpm();
    const verified: string[] = [];
    await expect(
      installLocalPluginTarball({
        tarballPath: await original(),
        configHome: home,
        runner: npm.runner,
        verify: async (result) => {
          verified.push(result.installedVersion);
          throw new Error("Activation failed: bad schema");
        },
      }),
    ).rejects.toThrow(/bad schema/);
    expect(verified).toEqual(["0.1.0"]);
    expect(await exists(join(plugins, "node_modules", "@alisio", "plugin-ica"))).toBe(false);
    expect(await stored(plugins)).toEqual([]);
    expect((await config(home).catch(() => ({ plugins: [] }))).plugins ?? []).toEqual([]);
  });

  it("puts the previous version back when an updated plugin does not start", async () => {
    const { home, original, plugins } = await setup();
    const npm = fakeNpm();
    await installLocalPluginTarball({
      tarballPath: await original(),
      configHome: home,
      runner: npm.runner,
    });
    await expect(
      installLocalPluginTarball({
        tarballPath: await original({ version: "0.2.0" }, "ica2.tgz"),
        configHome: home,
        runner: npm.runner,
        verify: async () => {
          throw new Error("Activation failed");
        },
      }),
    ).rejects.toThrow(/Activation failed/);
    const installed = JSON.parse(
      await readFile(
        join(plugins, "node_modules", "@alisio", "plugin-ica", "package.json"),
        "utf8",
      ),
    );
    expect(installed.version).toBe("0.1.0");
    expect(await stored(plugins)).toEqual(["alisio-plugin-ica-0.1.0.tgz"]);
    expect((await config(home)).plugins).toEqual(["@alisio/plugin-ica"]);
  });

  it("migrates a plugin installed from an external file: spec into the stable store", async () => {
    const { home, root, original, plugins } = await setup();
    const external = await original({}, "external.tgz");
    const npm = fakeNpm();
    // Today's layout: the dependency points at the original tarball, outside local-packages.
    await mkdir(join(plugins, "node_modules", "@alisio", "plugin-ica"), { recursive: true });
    await writeFile(
      join(plugins, "node_modules", "@alisio", "plugin-ica", "package.json"),
      JSON.stringify({ name: "@alisio/plugin-ica", version: "0.1.0" }),
    );
    await writeFile(
      join(plugins, "package.json"),
      JSON.stringify({
        dependencies: { "@alisio/plugin-ica": `file:${relative(plugins, external)}` },
      }),
    );
    await writeFile(join(home, "config.json"), JSON.stringify({ plugins: ["@alisio/plugin-ica"] }));
    const result = await installLocalPluginTarball({
      tarballPath: external,
      configHome: home,
      runner: npm.runner,
    });
    expect(result).toMatchObject({
      alreadyInstalled: true,
      updated: true,
      previousVersion: "0.1.0",
    });
    const deps = JSON.parse(await readFile(join(plugins, "package.json"), "utf8")).dependencies;
    expect(deps["@alisio/plugin-ica"]).toBe("file:local-packages/alisio-plugin-ica-0.1.0.tgz");
    expect(await stored(plugins)).toEqual(["alisio-plugin-ica-0.1.0.tgz"]);
    // One config entry, and the original file was only read.
    expect((await config(home)).plugins).toEqual(["@alisio/plugin-ica"]);
    expect(await exists(external)).toBe(true);
    expect(root).toBeTruthy();
  });

  it("reinstalling and downgrading keep one config entry and one stored copy", async () => {
    const { home, original, plugins } = await setup();
    const npm = fakeNpm();
    const install = async (version: string, file: string) =>
      installLocalPluginTarball({
        tarballPath: await original({ version }, file),
        configHome: home,
        runner: npm.runner,
      });
    await install("0.2.0", "a.tgz");
    expect(await install("0.2.0", "b.tgz")).toMatchObject({
      updated: true,
      previousVersion: "0.2.0",
    });
    expect(await install("0.1.0", "c.tgz")).toMatchObject({
      installedVersion: "0.1.0",
      previousVersion: "0.2.0",
    });
    expect(await stored(plugins)).toEqual(["alisio-plugin-ica-0.1.0.tgz"]);
    expect((await config(home)).plugins).toEqual(["@alisio/plugin-ica"]);
  });

  it("is refused under --read-only", async () => {
    const { home, original } = await setup();
    await expect(
      installLocalPluginTarball({
        tarballPath: await original(),
        configHome: home,
        readOnly: true,
        runner: fakeNpm().runner,
      }),
    ).rejects.toThrow(/read-only/);
  });
});

describe("uninstallPlugin of a local package", () => {
  it("removes the stored tarball and the config entry", async () => {
    const { home, original, plugins } = await setup();
    const npm = fakeNpm();
    await installLocalPluginTarball({
      tarballPath: await original(),
      configHome: home,
      runner: npm.runner,
    });
    const result = await uninstallPlugin({
      packageName: "@alisio/plugin-ica",
      configHome: home,
      runner: npm.runner,
    });
    expect(result.removed).toBe(true);
    expect(await stored(plugins)).toEqual([]);
    expect((await config(home)).plugins).toEqual([]);
    expect(await exists(join(plugins, "node_modules", "@alisio", "plugin-ica"))).toBe(false);
  });

  it("never deletes a file: dependency that is outside local-packages", async () => {
    const { home, root, plugins } = await setup();
    const outside = join(root, "precious.tgz");
    await writeFile(outside, "keep me");
    await mkdir(join(plugins, "node_modules", "pkg-x"), { recursive: true });
    await writeFile(join(plugins, "node_modules", "pkg-x", "package.json"), '{"version":"1.0.0"}');
    await writeFile(
      join(plugins, "package.json"),
      JSON.stringify({ dependencies: { "pkg-x": `file:${relative(plugins, outside)}` } }),
    );
    await writeFile(join(home, "config.json"), JSON.stringify({ plugins: ["pkg-x"] }));
    await uninstallPlugin({
      packageName: "pkg-x",
      configHome: home,
      runner: async () => ({ stdout: "", stderr: "", exitCode: 0, truncated: false }),
    });
    expect(await exists(outside)).toBe(true);
  });
});
