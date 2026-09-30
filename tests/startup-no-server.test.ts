/**
 * T-12: `alisio`, `alisio run` and `--help` never load @alisio/server or node:http (zero
 * overhead, spec §3.4). Technique: run the CLI source under Node with a `module.registerHooks`
 * resolve hook (Node >= 22.15) that records every resolved module URL, then inspect the list.
 * Bun has no equivalent hook; the standalone binary is covered by `pnpm test:compiled`
 * running `serve --help` only.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { browserCommand } from "../packages/cli/src/serve.ts";

const HOOK = `
import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    appendFileSync(process.env.ALISIO_MODULE_TRACE, result.url + "\\n");
    return result;
  },
});`;

function loadedModules(args: string[]): { modules: string[]; status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "alisio-t12-"));
  const trace = join(dir, "trace.txt");
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--disable-warning=ExperimentalWarning",
      "--conditions=alisio-source",
      "--import",
      `data:text/javascript,${encodeURIComponent(HOOK)}`,
      resolve("packages/cli/src/main.ts"),
      ...args,
    ],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ALISIO_MODULE_TRACE: trace,
        ALISIO_CONFIG_HOME: join(dir, "config"),
        ALISIO_STATE_HOME: join(dir, "state"),
        HERDR_ENV: "0",
      },
    },
  );
  let modules: string[] = [];
  try {
    modules = readFileSync(trace, "utf8").split("\n").filter(Boolean);
  } catch {
    /* no trace: asserted below */
  }
  return { modules, status: result.status, out: `${result.stdout}${result.stderr}` };
}

const serverModules = (modules: string[]) =>
  modules.filter((url) => url === "node:http" || url.includes("/packages/server/"));

describe("zero overhead startup (T-12)", () => {
  for (const args of [
    ["--help"],
    ["run", "hello", "--no-herdr"],
    ["--no-herdr"],
    ["serve", "--help"],
  ])
    it(`alisio ${args.join(" ")} loads neither @alisio/server nor node:http`, () => {
      const { modules, out } = loadedModules(args);
      expect(modules.length, out).toBeGreaterThan(5);
      expect(serverModules(modules)).toEqual([]);
    }, 30_000);

  it("the headless run path does load the core (the trace is meaningful)", () => {
    const { modules } = loadedModules(["run", "hello", "--no-herdr"]);
    expect(modules.some((url) => url.includes("/packages/core/src/"))).toBe(true);
  }, 30_000);
});

describe("serve browser opener", () => {
  it("uses the operating system opener for each platform", () => {
    expect(browserCommand("linux", "http://x")).toEqual(["xdg-open", "http://x"]);
    expect(browserCommand("darwin", "http://x")).toEqual(["open", "http://x"]);
    expect(browserCommand("win32", "http://x")).toEqual(["cmd", "/c", "start", '""', "http://x"]);
  });
});
