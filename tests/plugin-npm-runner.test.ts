import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installPlugin,
  NPM_NOT_FOUND_MESSAGE,
  resolveNpmInvocation,
  runNpm,
} from "../packages/core/src/index.ts";

afterEach(() => vi.unstubAllEnvs());

describe("resolveNpmInvocation", () => {
  it("spawns plain npm when ALISIO_NPM_CLI is not set", () => {
    expect(resolveNpmInvocation("npm", ["install", "x"], {}, {})).toEqual({
      command: "npm",
      args: ["install", "x"],
    });
  });

  it("runs the bundled npm-cli.js through this executable when ALISIO_NPM_CLI is set", () => {
    const spec = resolveNpmInvocation(
      "npm",
      ["uninstall", "x"],
      { ALISIO_NPM_CLI: "/rt/node_modules/npm/bin/npm-cli.js", PATH: "/bin", HOME: "/h" },
      {},
      "/opt/app/node",
    );
    expect(spec.command).toBe("/opt/app/node");
    expect(spec.args).toEqual(["/rt/node_modules/npm/bin/npm-cli.js", "uninstall", "x"]);
    expect(spec.env).toMatchObject({ PATH: "/bin", HOME: "/h" });
    expect(spec.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("sets ELECTRON_RUN_AS_NODE only under Electron", () => {
    const spec = resolveNpmInvocation(
      "npm",
      [],
      { ALISIO_NPM_CLI: "/x/npm-cli.js" },
      { electron: "45.0.0" },
      "/opt/app/alisio",
    );
    expect(spec.env?.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("ignores an empty ALISIO_NPM_CLI and non-npm commands", () => {
    expect(resolveNpmInvocation("npm", [], { ALISIO_NPM_CLI: "" }, {}).command).toBe("npm");
    expect(resolveNpmInvocation("git", [], { ALISIO_NPM_CLI: "/x.js" }, {}).command).toBe("git");
  });
});

describe("runNpm", () => {
  it("runs the bundled npm-cli.js (a real process)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alisio-npm-cli-"));
    const cli = join(dir, "npm-cli.js");
    await writeFile(cli, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    vi.stubEnv("ALISIO_NPM_CLI", cli);
    const result = await runNpm("npm", ["install", "--prefix", dir, "pkg"], {
      cwd: dir,
      signal: new AbortController().signal,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["install", "--prefix", dir, "pkg"]);
  });

  it("explains a missing npm instead of surfacing ENOENT", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alisio-no-npm-"));
    await mkdir(join(dir, "empty"));
    vi.stubEnv("PATH", join(dir, "empty"));
    vi.stubEnv("ALISIO_NPM_CLI", "");
    await expect(
      runNpm("npm", ["--version"], { cwd: dir, signal: new AbortController().signal }),
    ).rejects.toThrow(NPM_NOT_FOUND_MESSAGE);
  });

  it("installPlugin without a runner reports the missing npm clearly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alisio-no-npm-"));
    await mkdir(join(dir, "empty"));
    vi.stubEnv("PATH", join(dir, "empty"));
    vi.stubEnv("ALISIO_NPM_CLI", "");
    await expect(
      installPlugin({ spec: "npm:plugin-x", configHome: join(dir, "cfg") }),
    ).rejects.toThrow(
      /npm was not found: install Node\.js, or use the desktop app, which bundles it/,
    );
  });
});
