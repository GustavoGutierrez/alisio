/**
 * specs/011 Fase 0: measures what Proof's evidence capture would cost. No production code.
 *
 *   node --experimental-strip-types scripts/proof-phase0.ts [--iterations N]
 *
 * Prints one JSON report with (1) how many `tool_completed` events of `run_process`/`shell` a
 * synthetic session produces and (2) the per-call capture cost against the real latency of a
 * spawned process, for two designs: `hash` (outputHash + <=4 KB redacted excerpt, the spec design)
 * and `full` (redacts and stores the whole output). The sessions are synthetic: the tool mix is an
 * ASSUMPTION stated in the report, not a measurement of real usage. It also pins the command
 * fingerprint format (`commandFingerprint`) that Fase 2 must implement.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { redactSecrets } from "../packages/core/src/eval/secrets.ts";

const EXCERPT_CAP = 4096;
/** The runner bounds the text the model sees at 48,000 chars (`executeCall`). */
const OUTPUT_SIZES = [512, 4_096, 32_000, 47_000];

/** Fingerprint v1: sha256 of canonical JSON `{v, argv, cwd}`; see `normalizeShell`. */
export function commandFingerprint(
  tool: "run_process" | "shell",
  input: { command: string; args?: string[] },
  cwdRelative = ".",
): string {
  const argv =
    tool === "run_process"
      ? [input.command, ...(input.args ?? [])]
      : ["sh", "-c", normalizeShell(input.command)];
  const cwd =
    cwdRelative
      .split("\\")
      .join("/")
      .replace(/^(\.\/)+/, "") || ".";
  return createHash("sha256")
    .update(JSON.stringify({ v: 1, argv, cwd }))
    .digest("hex");
}

/** Trims and collapses whitespace runs OUTSIDE single/double quotes; quoted text stays verbatim. */
export function normalizeShell(command: string): string {
  let out = "";
  let quote: string | undefined;
  let pendingSpace = false;
  for (const ch of command.trim()) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = undefined;
    } else if (/\s/.test(ch)) {
      pendingSpace = true;
    } else {
      if (pendingSpace) out += " ";
      pendingSpace = false;
      out += ch;
      if (ch === '"' || ch === "'") quote = ch;
    }
  }
  return out;
}

function checkFingerprint(): string[] {
  const failures: string[] = [];
  const eq = (name: string, a: string, b: string, same: boolean) => {
    if ((a === b) !== same) failures.push(name);
  };
  const f = commandFingerprint;
  eq(
    "whitespace-insensitive",
    f("shell", { command: "pnpm   test " }),
    f("shell", { command: "pnpm test" }),
    true,
  );
  eq(
    "quoted-whitespace-kept",
    f("shell", { command: 'echo "a  b"' }),
    f("shell", { command: 'echo "a b"' }),
    false,
  );
  eq(
    "args-matter",
    f("run_process", { command: "pnpm", args: ["test"] }),
    f("run_process", { command: "pnpm", args: ["lint"] }),
    false,
  );
  eq(
    "cwd-matters",
    f("shell", { command: "ls" }, "packages/core"),
    f("shell", { command: "ls" }, "."),
    false,
  );
  eq(
    "cwd-normalized",
    f("shell", { command: "ls" }, "./."),
    f("shell", { command: "ls" }, "."),
    true,
  );
  eq(
    "tool-kinds-differ",
    f("shell", { command: "pnpm test" }),
    f("run_process", { command: "pnpm", args: ["test"] }),
    false,
  );
  return failures;
}

/** Synthetic tool mix per session (assumption, not telemetry). */
const MIX: Array<[string, number]> = [
  ["read_file", 0.35],
  ["search_text", 0.15],
  ["edit_file", 0.12],
  ["write_file", 0.05],
  ["run_process", 0.2],
  ["shell", 0.1],
  ["other", 0.03],
];

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function inventory(sessions: number, callsPerSession: number) {
  const rand = lcg(11);
  const counts: Record<string, number> = {};
  let processCalls = 0;
  const perSession: number[] = [];
  for (let s = 0; s < sessions; s++) {
    let inSession = 0;
    for (let c = 0; c < callsPerSession; c++) {
      let r = rand();
      let name = "other";
      for (const [tool, p] of MIX) {
        if (r < p) {
          name = tool;
          break;
        }
        r -= p;
      }
      counts[name] = (counts[name] ?? 0) + 1;
      if (name === "run_process" || name === "shell") {
        processCalls++;
        inSession++;
      }
    }
    perSession.push(inSession);
  }
  perSession.sort((a, b) => a - b);
  return {
    sessions,
    callsPerSession,
    toolCompleted: sessions * callsPerSession,
    processToolCompleted: processCalls,
    processPerSessionMedian: perSession[Math.floor(perSession.length / 2)],
    processPerSessionMax: perSession.at(-1),
    mixAssumption: Object.fromEntries(MIX),
  };
}

function spawnOutput(bytes: number): Promise<{ ms: number; stdout: string }> {
  const started = performance.now();
  const code = `process.stdout.write(("x".repeat(79)+"\\n").repeat(${Math.ceil(bytes / 80)}).slice(0,${bytes}))`;
  return new Promise((resolve, reject) =>
    execFile(process.execPath, ["-e", code], { maxBuffer: 1 << 24 }, (error, stdout) =>
      error ? reject(error) : resolve({ ms: performance.now() - started, stdout }),
    ),
  );
}

function mean(values: number[]) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function capture(iterations: number) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE ev(id INTEGER PRIMARY KEY, fp TEXT, exit_code INTEGER, output_hash TEXT, excerpt TEXT, full TEXT)",
  );
  const insert = db.prepare(
    "INSERT INTO ev(fp, exit_code, output_hash, excerpt, full) VALUES(?,?,?,?,?)",
  );
  const rows = [];
  for (const size of OUTPUT_SIZES) {
    const baseline: number[] = [];
    let stdout = "";
    for (let i = 0; i < 15; i++) {
      const r = await spawnOutput(size);
      baseline.push(r.ms);
      stdout = r.stdout;
    }
    // What the runner holds right after `execute`: the JSON text of a ProcessResult.
    const text = JSON.stringify({ stdout, stderr: "", exitCode: 0, truncated: false });
    const run = (full: boolean) => {
      const samples: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const t = performance.now();
        const parsed = JSON.parse(text) as { stdout: string; stderr: string; exitCode: number };
        const output = parsed.stdout + parsed.stderr;
        const fp = commandFingerprint("run_process", { command: "pnpm", args: ["test"] });
        const outputHash = createHash("sha256").update(output).digest("hex");
        const excerpt = redactSecrets(output.slice(-EXCERPT_CAP));
        insert.run(fp, parsed.exitCode, outputHash, excerpt, full ? redactSecrets(output) : null);
        samples.push(performance.now() - t);
      }
      return mean(samples);
    };
    run(false); // warm-up
    const hashMs = run(false);
    const fullMs = run(true);
    const base = mean(baseline);
    rows.push({
      outputBytes: size,
      processMeanMs: +base.toFixed(2),
      hashCaptureMs: +hashMs.toFixed(3),
      fullCaptureMs: +fullMs.toFixed(3),
      hashOverheadPct: +((hashMs / base) * 100).toFixed(2),
      fullOverheadPct: +((fullMs / base) * 100).toFixed(2),
    });
  }
  db.close();
  return rows;
}

const { values } = parseArgs({ options: { iterations: { type: "string", default: "200" } } });
const failures = checkFingerprint();
const rows = await capture(Number(values.iterations));
const worstHash = Math.max(...rows.map((r) => r.hashOverheadPct));
const worstFull = Math.max(...rows.map((r) => r.fullOverheadPct));
console.log(
  JSON.stringify(
    {
      scenario: "specs/011 phase 0: Proof evidence capture cost",
      runner: `node ${process.versions.node} ${process.platform}/${process.arch}`,
      inventory: inventory(200, 60),
      capture: rows,
      targetPct: 5,
      worstHashOverheadPct: worstHash,
      worstFullOverheadPct: worstFull,
      hashWithinTarget: worstHash < 5,
      fullWithinTarget: worstFull < 5,
      fingerprintChecks: failures.length === 0 ? "ok" : failures,
      scope:
        "Capture work after the call returns (JSON.parse, sha256, redaction, SQLite insert in memory) vs a real spawned node process; excludes model latency and disk fsync",
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
