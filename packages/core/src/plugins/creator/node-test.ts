/**
 * Runs a creator project's code with Node: its `node:test` suite and a probe that imports the
 * entry and reports the exported plugin object. The child gets a scrubbed environment (no
 * credentials, a throwaway HOME), bounded time and output, and no install step. It still runs
 * with the user's privileges and may reach the network: this is NOT a sandbox.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginCreatorTestRun } from "@alisio/sdk";
import { isMissingCommand, runProcess } from "../../runtime/process.ts";
import { sanitizePluginDiagnostic } from "../diagnostic.ts";
import { PLUGIN_API_SHAPE } from "./api-shape.ts";
import { PLUGIN_CREATOR_LIMITS } from "./types.ts";

export interface NodeCommand {
  command: string;
  env: Record<string, string>;
}

/**
 * The Node executable for project code: this process under Node (Electron acting as Node in the
 * desktop app), else `node` from PATH (Bun and the standalone binary are not Node).
 */
export function nodeCommand(
  versions: Record<string, string | undefined> = process.versions,
  execPath: string = process.execPath,
): NodeCommand {
  if (versions.bun) return { command: "node", env: {} };
  return {
    command: execPath,
    env: versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
  };
}

const PASSED = ["PATH", "SystemRoot", "COMSPEC", "LANG", "PATHEXT", "WINDIR"];

async function scrubbedEnv(extra: Record<string, string>): Promise<{
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}> {
  const home = await mkdtemp(join(tmpdir(), "alisio-plugin-test-"));
  const env: Record<string, string> = {};
  for (const key of PASSED) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: home,
    TEMP: home,
    TMP: home,
    NODE_ENV: "test",
    NO_COLOR: "1",
    ...extra,
  });
  return { env, cleanup: () => rm(home, { recursive: true, force: true }).catch(() => {}) };
}

const NODE_MISSING =
  "Node.js was not found: install Node.js 22 or newer to run plugin tests, or use the desktop app";

function count(output: string, label: string): number {
  const matches = [...output.matchAll(new RegExp(`^# ${label} (\\d+)\\s*$`, "gm"))];
  const last = matches.at(-1)?.[1];
  return last ? Number(last) : 0;
}

/** Runs `node --test` over `files` (project-relative) in `dir` with the TAP reporter. */
export async function runNodeTests(
  dir: string,
  files: string[],
  options: { timeoutMs?: number; signal?: AbortSignal; node?: NodeCommand } = {},
): Promise<PluginCreatorTestRun> {
  const started = Date.now();
  const node = options.node ?? nodeCommand();
  const timeoutMs = options.timeoutMs ?? PLUGIN_CREATOR_LIMITS.testTimeoutMs;
  const timer = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timer]) : timer;
  const { env, cleanup } = await scrubbedEnv(node.env);
  try {
    const result = await runProcess(
      node.command,
      ["--test", "--test-reporter=tap", `--test-timeout=${timeoutMs}`, ...files],
      {
        cwd: dir,
        signal,
        timeoutMs: timeoutMs + 1_000,
        env,
        maxBytes: 200_000,
        onOverflow: "truncate",
        killGraceMs: 1_000,
      },
    );
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const timedOut = timer.aborted;
    const passed = count(result.stdout, "pass");
    const failed = count(result.stdout, "fail") + count(result.stdout, "cancelled");
    return {
      ok: !timedOut && result.exitCode === 0 && failed === 0 && passed > 0,
      passed,
      failed: timedOut && failed === 0 ? Math.max(1, failed) : failed,
      durationMs: Date.now() - started,
      timedOut,
      output: output.slice(-PLUGIN_CREATOR_LIMITS.testOutputChars),
    };
  } catch (error) {
    const timedOut = timer.aborted;
    return {
      ok: false,
      passed: 0,
      failed: timedOut ? 1 : 0,
      durationMs: Date.now() - started,
      timedOut,
      output: isMissingCommand(error)
        ? NODE_MISSING
        : timedOut
          ? "The tests took too long and were stopped."
          : "The tests could not be started.",
    };
  } finally {
    await cleanup();
  }
}

export interface PluginProbe {
  ok: boolean;
  id?: unknown;
  name?: string;
  version?: unknown;
  apiVersion?: unknown;
  hasSetup?: boolean;
  /** Short reason when the import failed. */
  error?: string;
  /** `api.x` / `api.x.y` members setup touched that the running SDK's PluginAPI does not have. */
  unknownMembers?: string[];
  /** What setup registered (tools, commands, views...), counted by API member. */
  registered?: Record<string, number>;
  /** Setup threw or timed out against the strict fake API (a warning: tests judge behavior). */
  setupError?: string;
}

/**
 * Child-side probe: imports the entry, then runs `setup` against a STRICT fake PluginAPI built
 * from `PLUGIN_API_SHAPE` (passed as argv): reading any member the running SDK does not define is
 * recorded, registrations are counted, and nothing real happens (no database, no network).
 */
const PROBE = `
const [url, shapeText] = process.argv.slice(1);
const shape = JSON.parse(shapeText);
const unknown = new Set();
const registered = {};
const unregister = () => () => {};
const statement = { run: () => ({ changes: 0, lastInsertRowid: 0 }), get: () => undefined, all: () => [] };
const database = { exec() {}, prepare: () => statement, transaction: (fn) => fn(), close() {} };
const stub = (top, name) => {
  if (/^(register|on|onStart|onEnd|registerProvider|registerVerifier|registerEmbedding|registerStore|panel)$/.test(name))
    return () => { registered[top] = (registered[top] || 0) + 1; return () => {}; };
  if (top === "storage") return () => database;
  if (top === "resources") return name === "list" ? () => [] : () => {};
  if (top === "ui") return name === "interactive" || name === "open" ? () => false : async () => (name === "askQuestions" ? {} : undefined);
  if (top === "state") return () => undefined;
  if (name === "available") return () => false;
  return async () => undefined;
};
const group = (top, spec) => {
  if (spec === "value")
    return top === "paths" ? { state: "/probe/state", config: "/probe/config", cache: "/probe/cache" } : {};
  return new Proxy({}, {
    get(_, key) {
      if (typeof key !== "string" || key === "then") return undefined;
      if (!(key in spec)) { unknown.add("api." + top + "." + key); return undefined; }
      return stub(top, key);
    },
    has: (_, key) => typeof key === "string" && key in spec,
  });
};
const groups = {};
const api = new Proxy({}, {
  get(_, key) {
    if (typeof key !== "string" || key === "then" || key === "toJSON") return undefined;
    if (!(key in shape)) { unknown.add("api." + key); return undefined; }
    return (groups[key] ??= group(key, shape[key]));
  },
  has: (_, key) => typeof key === "string" && key in shape,
});
const report = (out) => { process.stdout.write("\\n@@PROBE@@" + JSON.stringify(out) + "\\n"); process.exit(0); };
import(url).then(async (m) => {
  const p = m.default;
  if (!p || typeof p !== "object") return report({ ok: false, error: "The entry file has no default export object" });
  const out = { ok: true, id: p.id, name: typeof p.name === "string" ? p.name : undefined, version: p.version, apiVersion: p.apiVersion, hasSetup: typeof p.setup === "function" };
  if (out.hasSetup) {
    try {
      await Promise.race([
        Promise.resolve().then(() => p.setup(api)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("setup took longer than 5 seconds")), 5000).unref()),
      ]);
    } catch (e) {
      out.setupError = String((e && e.message) || e).slice(0, 300);
    }
  }
  out.unknownMembers = [...unknown];
  out.registered = registered;
  report(out);
}, (e) => report({ ok: false, error: String((e && e.message) || e).slice(0, 300) }));
`;

/** Imports the entry in a child Node and reports the exported plugin object (no setup call). */
export async function probePlugin(
  dir: string,
  entry: string,
  options: { timeoutMs?: number; node?: NodeCommand } = {},
): Promise<PluginProbe> {
  const node = options.node ?? nodeCommand();
  const { env, cleanup } = await scrubbedEnv(node.env);
  try {
    const result = await runProcess(
      node.command,
      [
        "--input-type=module",
        "--eval",
        PROBE,
        pathToFileURL(join(dir, entry)).href,
        JSON.stringify(PLUGIN_API_SHAPE),
      ],
      {
        cwd: dir,
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
        timeoutMs: options.timeoutMs ?? 20_000,
        env,
        maxBytes: 64_000,
        onOverflow: "truncate",
        killGraceMs: 1_000,
      },
    );
    const line = result.stdout
      .split("\n")
      .reverse()
      .find((l) => l.startsWith("@@PROBE@@"));
    if (!line) return { ok: false, error: "The plugin could not be loaded" };
    return JSON.parse(line.slice("@@PROBE@@".length)) as PluginProbe;
  } catch (error) {
    return {
      ok: false,
      error: isMissingCommand(error) ? NODE_MISSING : "The plugin could not be loaded",
    };
  } finally {
    await cleanup();
  }
}

/**
 * Parses each shipped file as a module (`node --check`, which honors `"type": "module"`): a file
 * with TypeScript syntax or any other syntax error is reported with the parser's first error line.
 */
export async function checkSyntax(
  dir: string,
  files: string[],
  options: { node?: NodeCommand; timeoutMs?: number } = {},
): Promise<Array<{ file: string; message: string }>> {
  const node = options.node ?? nodeCommand();
  const { env, cleanup } = await scrubbedEnv(node.env);
  const problems: Array<{ file: string; message: string }> = [];
  try {
    for (const file of files) {
      try {
        const result = await runProcess(node.command, ["--check", file], {
          cwd: dir,
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
          timeoutMs: options.timeoutMs ?? 15_000,
          env,
          maxBytes: 16_000,
          onOverflow: "truncate",
          killGraceMs: 500,
        });
        if (result.exitCode === 0) continue;
        const line =
          result.stderr.split("\n").find((l) => /^\w*Error\b/.test(l.trim())) ?? "SyntaxError";
        problems.push({ file, message: sanitizePluginDiagnostic(line.trim(), 300) });
      } catch (error) {
        if (isMissingCommand(error)) return [{ file, message: NODE_MISSING }];
      }
    }
  } finally {
    await cleanup();
  }
  return problems;
}
