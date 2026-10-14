/**
 * Live engine of the reliability lab (specs/010 Phase 2): runs ONE task repetition through the
 * real Application (runner, tools, store) on a throwaway copy of its fixture and returns an
 * `EvalRunRecord` with the conditions it was measured under.
 *
 * What the isolation guarantees, and what it does not:
 * - The fixture is copied; the original is never touched. Config, state, home and tmp live in the
 *   run directory and the process environment points at them while the application exists.
 * - File tools are mediated: a write to `../x` or to an absolute path outside the copy is refused
 *   (`safePath`). That is path confinement, NOT an OS sandbox.
 * - A granted `process` effect (or a `command` verifier) runs with the user's privileges and can
 *   write anywhere the user can. When `process` is granted the "nothing outside changes" claim does
 *   not hold. A subprocess is not a sandbox.
 *
 * Runs never overlap: `ALISIO_CONFIG_HOME`/`ALISIO_STATE_HOME` are process-global, so `runTask`
 * serializes concurrent callers.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  EvalBudget,
  EvalReplayDivergence,
  EvalRunRecord,
  EvalTask,
  ModelProvider,
  RunEvent,
} from "@alisio/sdk";
import { type BuiltinPlugin, createApplication } from "../application.ts";
import { type Config, configSchema } from "../config.ts";
import type { Policy } from "../core/contracts.ts";
import { runStatsOf } from "../core/run-stats.ts";
import type { RunOptions } from "../core/runner.ts";
import { RunTruncationError } from "../core/truncation.ts";
import { PERMISSION_MODE_TABLE } from "../permissions/modes.ts";
import { seededIdSource, setIdSource } from "../runtime/ids.ts";
import { loadVersion } from "../version.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import {
  type Cassette,
  CassetteRecorder,
  RecordingProvider,
  ReplayDivergenceError,
  ReplayExhausted,
  ReplayProvider,
  ReplayUnconsumedError,
} from "./cassette.ts";
import { Normalizer, runLiterals } from "./normalize.ts";
import type { LoadedSuite } from "./suite.ts";
import { runVerifiers, snapshotTree, type ToolEvent, type VerifierResult } from "./verifiers.ts";

export type EvalApplication = Awaited<ReturnType<typeof createApplication>>;
type BudgetKey = NonNullable<EvalRunRecord["budgetExceeded"]>;

/** The run was refused before it started (policy, `full` without opt-in, unsafe fixture). */
export class EvalRunRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalRunRefusedError";
  }
}

/** Abort reason of the engine's own budgets (`maxWallMs`, `maxToolCalls`). */
export class EvalBudgetExceeded extends Error {
  constructor(readonly budget: BudgetKey) {
    super(`Evaluation budget exceeded: ${budget}`);
    this.name = "EvalBudgetExceeded";
  }
}

/** Effects the invoker (the person or CI job running the lab) holds. A task can never exceed them. */
export interface InvokerPermissions {
  write: boolean;
  process: boolean;
  external: boolean;
  analysis: boolean;
  readOnly?: boolean;
}

/**
 * `live` talks to `provider`; `record` is a live run whose provider calls are also written into the
 * `CassetteRecorder` passed as `cassette`; `replay` serves the recorded `Cassette` passed as
 * `cassette` and needs no provider. Record and replay install a seeded id source for the run (so
 * session, plan and execution ids do not depend on fresh randomness) and wait for the model
 * catalog before the first request (so the output limit does not depend on a race).
 */
export type EvalRunMode = "live" | "record" | "replay";

export interface RunTaskOptions {
  suite: LoadedSuite;
  /**
   * Already resolved by the caller; injected into the application (no network lookups here).
   * Required except in `replay` mode, where the cassette supplies the provider.
   */
  provider?: ModelProvider;
  mode?: EvalRunMode;
  cassette?: CassetteRecorder | Cassette;
  /** Receives every `RunEvent` of the run (tests and tooling; the engine keeps its own counts). */
  onEvent?: (event: RunEvent) => void;
  /**
   * Written (stripped of plugins, skills, MCP, extra roots, scratch root and memory `dbPath`) as the global
   * config layer of the run. Phase 3 variant overrides (D15) MUST be applied to this object before
   * calling: the `configHash` is computed from what is written.
   */
  config: Config;
  /** Orders runs only. The provider never receives it, so it is not determinism. */
  seed: number;
  repetition: number;
  invoker: InvokerPermissions;
  /** Required for a task asking for `full`, regardless of what the invoker holds. */
  allowSuiteFull?: boolean;
  keep?: boolean;
  builtins?: BuiltinPlugin[];
  /** Turns `task.agent` into run options; without it a task naming an agent ends `error`. */
  resolveAgent?: (app: EvalApplication, agent: string) => RunOptions | Promise<RunOptions>;
  /** Parent of the run directory (default `os.tmpdir()`). */
  tmpRoot?: string;
}

// ---------------------------------------------------------------------------------------------
// The configuration hash (canonical JSON lives in canonical.ts)
// ---------------------------------------------------------------------------------------------

const sha256 = sha256Hex;

/**
 * Which top-level config keys feed `configHash`. The `satisfies` clause fails the typecheck, and
 * `tests/eval-engine.test.ts` fails at runtime, when a key is added to the schema without being
 * classified here: a new setting must be consciously hashed or excluded.
 */
export const CONFIG_HASH_COVERAGE = {
  limits: "hashed",
  compaction: "hashed",
  context: "hashed",
  forge: "hashed",
  analysis: "hashed",
  websearch: "hashed",
  decisions: "hashed",
  skillOverrides: "hashed",
  // Never part of the hash: secrets/endpoints/models (provider), paths and plugin options.
  schemaVersion: "excluded",
  provider: "excluded",
  plugins: "excluded",
  skills: "excluded",
  additionalDirectories: "excluded",
  mcp: "excluded",
  builtinPlugins: "excluded",
  pluginOverrides: "excluded",
  pluginHooks: "excluded",
  tasks: "excluded",
  goal: "excluded",
  plan: "excluded",
  tui: "excluded",
  agents: "excluded",
  web: "excluded",
} as const satisfies Record<keyof Config, "hashed" | "excluded">;

export interface ConfigHashExtras {
  /** The effective policy of the run after the invoker check and `readOnly`. */
  policy: {
    write: boolean;
    process: boolean;
    external: boolean;
    analysis: boolean;
    readOnly?: boolean;
  };
  approvalMode: string;
  budget: EvalBudget;
  /** Ids of the built-in plugins handed to the application (kept only when not disabled). */
  builtinIds: string[];
}

/**
 * `sha256:` of the allowlisted effective configuration plus policy, approval mode, budget and
 * enabled built-ins. Excludes secrets, env names, plugin options, absolute paths, endpoints, the
 * provider and the model (those are separate columns of the run record).
 */
export function computeConfigHash(config: Config, extras: ConfigHashExtras): string {
  const forge = config.forge;
  const picked = {
    limits: config.limits,
    compaction: config.compaction,
    context: config.context,
    forge: {
      javascript: forge.javascript,
      state: forge.state,
      scratch: {
        enabled: forge.scratch.enabled,
        retentionDays: forge.scratch.retentionDays,
        maxBytes: forge.scratch.maxBytes,
      },
      guides: forge.guides,
    },
    analysis: {
      enabled: config.analysis.enabled,
      runtime: config.analysis.runtime,
      isolation: config.analysis.isolation,
    },
    websearch: { provider: config.websearch.provider },
    decisions: { enabled: config.decisions.enabled, provider: config.decisions.provider },
    skillOverrides: config.skillOverrides,
    policy: extras.policy,
    approvalMode: extras.approvalMode,
    budget: extras.budget,
    builtins: extras.builtinIds.filter((id) => config.builtinPlugins[id]?.enabled !== false).sort(),
  };
  return `sha256:${sha256(canonicalJson(picked))}`;
}

// ---------------------------------------------------------------------------------------------
// Policy (D16)
// ---------------------------------------------------------------------------------------------

type EffectName = "write" | "process" | "external" | "analysis";
const EFFECTS: readonly EffectName[] = ["write", "process", "external", "analysis"];

interface Plan {
  policy: Required<Pick<Policy, "write" | "process" | "external">> & { analysis: boolean };
  readOnly: boolean;
}

/** Effective policy of a task, or an `EvalRunRefusedError` naming what is not allowed and why. */
function planPolicy(
  task: EvalTask,
  opts: Pick<RunTaskOptions, "invoker" | "allowSuiteFull">,
): Plan {
  const { mode, allow = [], readOnly: taskReadOnly = false } = task.policy;
  if (mode === "full" && !opts.allowSuiteFull)
    throw new EvalRunRefusedError(
      `Task "${task.id}" asks for permission mode "full"; pass --allow-suite-full explicitly to run it.`,
    );
  const base = PERMISSION_MODE_TABLE[mode].policy;
  const requested: Record<EffectName, boolean> = {
    write: base.write || allow.includes("write"),
    process: base.process || allow.includes("process"),
    external: base.external || allow.includes("external"),
    analysis: allow.includes("analysis"),
  };
  const readOnly = taskReadOnly || !!opts.invoker.readOnly;
  if (!taskReadOnly) {
    const lacking = EFFECTS.filter(
      (effect) => requested[effect] && (opts.invoker.readOnly || !opts.invoker[effect]),
    );
    if (lacking.length > 0)
      throw new EvalRunRefusedError(
        `Task "${task.id}" requests ${lacking.join(", ")} but the invoker does not hold ${
          lacking.length === 1 ? "it" : "them"
        }${opts.invoker.readOnly ? " (read-only)" : ""}. A suite can only equal or restrict the invoker's permissions; grant the --allow-* flag or lower the task policy.`,
      );
  }
  const effective = readOnly
    ? { write: false, process: false, external: false, analysis: false }
    : requested;
  return { policy: effective, readOnly };
}

/**
 * Throws the same `EvalRunRefusedError` `runTask` would, without running anything. Lets a caller
 * refuse a whole batch up front instead of discovering a refusal after earlier runs finished.
 */
export function checkTaskPolicy(
  task: EvalTask,
  opts: Pick<RunTaskOptions, "invoker" | "allowSuiteFull">,
): void {
  planPolicy(task, opts);
}

function checkMode(opts: Pick<RunTaskOptions, "mode" | "provider" | "cassette">): void {
  const mode = opts.mode ?? "live";
  if (mode === "replay") {
    if (!opts.cassette || opts.cassette instanceof CassetteRecorder)
      throw new EvalRunRefusedError("Replay mode needs the recorded cassette (`cassette`).");
    return;
  }
  if (!opts.provider)
    throw new EvalRunRefusedError(`${mode} mode needs a model provider (\`provider\`).`);
  if (mode === "record") {
    if (!(opts.cassette instanceof CassetteRecorder))
      throw new EvalRunRefusedError("Record mode needs a CassetteRecorder (`cassette`).");
  } else if (opts.cassette)
    throw new EvalRunRefusedError("A cassette only goes with record or replay mode, not live.");
}

// ---------------------------------------------------------------------------------------------
// Fixture copy
// ---------------------------------------------------------------------------------------------

/** Refuses symlinks that leave the fixture (or are absolute, which a copy would turn into escapes). */
function assertFixtureSafe(fixtureDir: string, taskId: string): void {
  const root = realpathSync(fixtureDir);
  const within = (path: string) => {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const shown = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(full);
        if (isAbsolute(target))
          throw new EvalRunRefusedError(
            `Task "${taskId}": fixture symlink "${shown}" is an absolute symlink; use a relative target inside the fixture.`,
          );
        if (!within(resolve(dirname(full), target)))
          throw new EvalRunRefusedError(
            `Task "${taskId}": fixture symlink "${shown}" resolves outside the fixture; remove it or point it inside.`,
          );
        let real: string | undefined;
        try {
          real = realpathSync(full);
        } catch {
          // Dangling link: the lexical check above already proved it stays inside.
        }
        if (real !== undefined && !within(real))
          throw new EvalRunRefusedError(
            `Task "${taskId}": fixture symlink "${shown}" resolves outside the fixture; remove it or point it inside.`,
          );
      } else if (entry.isDirectory()) walk(full, shown);
    }
  };
  walk(root, "");
}

function initGit(ws: string, home: string): void {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const identity = [
    "-c",
    "user.name=alisio-eval",
    "-c",
    "user.email=eval@alisio.invalid",
    "-c",
    "commit.gpgsign=false",
  ];
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    [...identity, "commit", "-q", "--allow-empty", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: ws, env, encoding: "utf8" });
    if (result.status !== 0)
      throw new Error(
        `git ${args.find((a) => !a.startsWith("-") && a !== "user.name=alisio-eval") ?? ""} failed in the fixture copy`,
      );
  }
}

// ---------------------------------------------------------------------------------------------
// Process environment scoping
// ---------------------------------------------------------------------------------------------

/** Points the process-global homes at the run and returns the function that restores them. */
function scopeEnv(values: Record<string, string>): () => void {
  const saved = Object.keys(values).map((key) => [key, process.env[key]] as const);
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** The global config layer written for the run: nothing that could load code or reach real paths. */
function isolatedConfig(config: Config): Config {
  const copy = JSON.parse(JSON.stringify(config)) as Config;
  copy.plugins = [];
  // User skill roots must not influence results (skillOverrides stay: they are hashed).
  copy.skills = [];
  copy.mcp = { ...copy.mcp, servers: {} };
  copy.additionalDirectories = [];
  copy.forge.scratch.root = null;
  for (const [id, options] of Object.entries(copy.builtinPlugins)) {
    const { dbPath: _dbPath, ...rest } = options as Record<string, unknown>;
    copy.builtinPlugins[id] = rest as (typeof copy.builtinPlugins)[string];
  }
  return configSchema.parse(copy);
}

// ---------------------------------------------------------------------------------------------
// Event bookkeeping
// ---------------------------------------------------------------------------------------------

const INCIDENT_ORDER = [
  "approval_denied",
  "tool_error",
  "turns_exceeded",
  "compaction",
  "compaction_failed",
  "context_reduced",
  "timeout",
  "output_truncated",
  "request_retry",
  "truncation_recovery",
  "response_truncated",
  "plugin_hook_failed",
  "run_aborted",
  "usage_unreported",
] as const;

class RunObserver {
  readonly incidents = new Map<string, number>();
  readonly tools: Array<{
    id: string;
    name: string;
    args: string;
    done: boolean;
    isError: boolean;
  }> = [];
  readonly blocked = new Set<string>();
  turns = 0;
  /** Turns whose `turn_completed` carried provider usage. */
  turnsWithUsage = 0;
  startedCalls = 0;
  /** Cumulative tokens reported by the last `turn_completed`. */
  tokens = 0;
  usage: { input: number; output: number } | undefined;
  model: string | undefined;
  timedOut = false;
  turnsExceeded = false;

  private bump(kind: string): void {
    this.incidents.set(kind, (this.incidents.get(kind) ?? 0) + 1);
  }

  /** Returns true when this event is a tool call that must be blocked (over `maxToolCalls`). */
  handle(event: RunEvent, maxToolCalls: number | undefined): boolean {
    const data = event.data as Record<string, unknown>;
    switch (event.type) {
      case "run_started":
        this.model = String(data.model);
        break;
      case "turn_completed": {
        this.turns += 1;
        this.tokens = Number(data.tokens) || this.tokens;
        const usage = data.usage as { input: number; output: number } | undefined;
        if (usage) {
          this.turnsWithUsage += 1;
          this.usage ??= { input: 0, output: 0 };
          this.usage.input += usage.input;
          this.usage.output += usage.output;
        }
        break;
      }
      case "tool_started": {
        const id = String(data.id);
        if (maxToolCalls !== undefined && this.startedCalls + 1 > maxToolCalls) {
          this.blocked.add(id);
          return true;
        }
        this.startedCalls += 1;
        this.tools.push({
          id,
          name: String(data.name),
          args: String(data.arguments),
          done: false,
          isError: false,
        });
        break;
      }
      case "tool_completed": {
        const id = String(data.id);
        if (this.blocked.has(id)) break;
        const tool = this.tools.find((t) => t.id === id);
        if (tool) {
          tool.done = true;
          tool.isError = data.isError === true;
        }
        if (data.isError === true) this.bump("tool_error");
        break;
      }
      case "approval_resolved":
        if (data.decision === "deny") this.bump("approval_denied");
        break;
      case "run_turns_exceeded":
        this.turnsExceeded = true;
        this.bump("turns_exceeded");
        break;
      case "compaction_completed":
        this.bump("compaction");
        break;
      case "compaction_failed":
      case "context_reduced":
      case "request_retry":
      case "truncation_recovery":
      case "response_truncated":
      case "plugin_hook_failed":
        this.bump(event.type);
        break;
      case "run_failed":
        if (data.code === "timeout") {
          this.timedOut = true;
          this.bump("timeout");
        } else if (data.code === "output_truncated") this.bump("output_truncated");
        break;
      default:
        break;
    }
    return false;
  }

  toolEvents(): ToolEvent[] {
    return this.tools.map((t) => ({
      tool: t.name,
      ok: t.done && !t.isError,
      argsKey: argsKey(t.args),
    }));
  }

  /** Only SOME turns reported usage: the summed totals understate the run. */
  get usagePartial(): boolean {
    return this.turnsWithUsage > 0 && this.turnsWithUsage < this.turns;
  }

  markAborted(): void {
    this.bump("run_aborted");
  }

  incidentList(): Array<{ kind: string; count: number }> {
    if (this.turns > 0 && (!this.usage || this.usagePartial)) this.bump("usage_unreported");
    return INCIDENT_ORDER.flatMap((kind) => {
      const count = this.incidents.get(kind);
      return count ? [{ kind, count }] : [];
    });
  }
}

/** Canonical key of the call arguments: sha256 of the sorted JSON, or of the raw text if unparsable. */
function argsKey(raw: string): string {
  let text = raw;
  try {
    text = canonicalJson(JSON.parse(raw));
  } catch {
    // Unparsable arguments are compared as written.
  }
  return `sha256:${sha256(text)}`;
}

/**
 * Whether a run's exception was caused by what the model did (so the run is a `fail`, a
 * repetition that counts) rather than by infrastructure (provider network/auth, fixture copy,
 * application creation: the run is `error` and excluded). Excluding model-caused failures would
 * be survivorship bias: the model that breaks the protocol would look better than one that does
 * not. The runner throws these as plain `Error`s, so the three protocol messages are matched
 * exactly; `tests/eval-engine.test.ts` drives each one through the real runner.
 */
const MODEL_PROTOCOL_ERRORS = new Set([
  "Too many tool calls in one turn",
  "Provider returned duplicate tool call IDs",
  "Provider reused a tool call ID across turns",
]);

function isModelCaused(error: unknown): boolean {
  if (error instanceof RunTruncationError) return true;
  return error instanceof Error && MODEL_PROTOCOL_ERRORS.has(error.message);
}

// ---------------------------------------------------------------------------------------------
// runTask
// ---------------------------------------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs one repetition of `task`. Refusals (`EvalRunRefusedError`) reject before anything is
 * created; infrastructure failures resolve with `status: "error"` and `error` set.
 */
export async function runTask(
  task: EvalTask,
  opts: RunTaskOptions,
): Promise<{ record: EvalRunRecord; keptDir?: string }> {
  const plan = planPolicy(task, opts);
  checkMode(opts);
  const fixtureDir = opts.suite.fixtureDirs[task.id];
  if (!fixtureDir)
    throw new EvalRunRefusedError(
      `Task "${task.id}" is not part of suite "${opts.suite.suite.suiteId}".`,
    );
  assertFixtureSafe(fixtureDir, task.id);
  const result = queue.then(() => execute(task, opts, plan, fixtureDir));
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function execute(
  task: EvalTask,
  opts: RunTaskOptions,
  plan: Plan,
  fixtureDir: string,
): Promise<{ record: EvalRunRecord; keptDir?: string }> {
  const runId = randomUUID();
  const startedAt = Date.now();
  const { suite } = opts.suite;
  const observer = new RunObserver();
  const budget = task.budget;
  const stored = isolatedConfig(opts.config);
  const configHash = computeConfigHash(stored, {
    policy: { ...plan.policy, ...(plan.readOnly ? { readOnly: true } : {}) },
    approvalMode: task.policy.mode,
    budget,
    builtinIds: (opts.builtins ?? []).map((b) => b.id),
  });

  const compactionHash = `sha256:${sha256(
    canonicalJson({
      compaction: stored.compaction,
      maxContextChars: stored.limits.maxContextChars,
    }),
  )}`;

  let runDir: string | undefined;
  let infraError: string | undefined;
  /** A failure the model caused (truncation, protocol violation): judged as `fail`, not `error`. */
  let modelFailure: string | undefined;
  let budgetReason: BudgetKey | undefined;
  let usageStats: { input: number; output: number } | undefined;
  let wallMs = 0;
  let verifiers: VerifierResult[] = [];
  const mode: EvalRunMode = opts.mode ?? "live";
  const recorder = opts.cassette instanceof CassetteRecorder ? opts.cassette : undefined;
  let replay: ReplayProvider | undefined;
  /** Why a replay stopped (a changed request, a call past the recording, calls never asked for). */
  let divergence: EvalReplayDivergence | undefined;
  const cassetteHeader = mode === "replay" ? (opts.cassette as Cassette).header : undefined;
  let model = opts.provider?.model ?? cassetteHeader?.model ?? "";
  const providerId = opts.provider?.id ?? cassetteHeader?.provider ?? "";
  try {
    if (task.agent && !opts.resolveAgent)
      throw new Error(
        `Task names agent "${task.agent}" but no resolveAgent was provided to the engine; agent runs are not available here.`,
      );
    runDir = realpathSync(mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "alisio-eval-")));
    const ws = join(runDir, "ws");
    const dirs = {
      config: join(runDir, "config"),
      state: join(runDir, "state"),
      home: join(runDir, "home"),
      tmp: join(runDir, "tmp"),
    };
    for (const dir of Object.values(dirs)) mkdirSync(dir);
    cpSync(fixtureDir, ws, { recursive: true, verbatimSymlinks: true });
    writeFileSync(join(dirs.config, "config.json"), `${JSON.stringify(stored, null, 2)}\n`);
    if (task.fixtureGit) initGit(ws, dirs.home);
    const baseline = snapshotTree(ws);

    // Record and replay: the same deterministic setup on both sides (ids, normalization).
    let normalizer: Normalizer | undefined;
    let provider = opts.provider;
    if (mode !== "live") {
      normalizer = new Normalizer({
        literals: runLiterals({
          runDir,
          workspace: ws,
          home: homedir(),
          osTmp: tmpdir(),
          ...(process.getuid ? { uid: process.getuid() } : {}),
        }),
        ...(task.replayNormalize ? { replay: task.replayNormalize } : {}),
      });
      normalizer.registerRun(runId);
      if (recorder && opts.provider) {
        recorder.bind(normalizer);
        provider = new RecordingProvider(opts.provider, recorder);
      } else if (mode === "replay") {
        replay = new ReplayProvider(opts.cassette as Cassette, { normalizer });
        provider = replay;
      }
    }
    if (!provider) throw new Error("No model provider for the run.");
    const effectiveProvider = provider;

    const controller = new AbortController();
    const restoreEnv = scopeEnv({
      ALISIO_CONFIG_HOME: dirs.config,
      ALISIO_STATE_HOME: dirs.state,
      ALISIO_TMPDIR: dirs.tmp,
    });
    // Ids of the run (sessions, plans, executions) come from a seed, not from fresh randomness.
    if (mode !== "live") setIdSource(seededIdSource(`${suite.suiteId}/${task.id}`));
    let app: EvalApplication | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      app = await createApplication({
        cwd: ws,
        db: join(dirs.state, "sessions.sqlite"),
        provider: effectiveProvider,
        noHerdr: true,
        trustProject: false,
        allowWrite: plan.policy.write,
        allowProcess: plan.policy.process,
        allowExternal: plan.policy.external,
        allowAnalysis: plan.policy.analysis,
        readOnly: plan.readOnly,
        ...(opts.builtins ? { builtins: opts.builtins } : {}),
        ...(task.policy.mode === "ask" && !plan.readOnly
          ? { approve: async () => "deny" as const }
          : {}),
        onEvent: (event) => {
          opts.onEvent?.(event);
          if (observer.handle(event, budget.maxToolCalls)) {
            budgetReason ??= "maxToolCalls";
            controller.abort(new EvalBudgetExceeded("maxToolCalls"));
          }
        },
      });
      model = app.provider.model;
      const agentOptions =
        task.agent && opts.resolveAgent ? await opts.resolveAgent(app, task.agent) : {};
      const sessionId = app.store.create(app.workspace, app.provider.id, app.provider.model).id;
      if (normalizer) {
        normalizer.registerSession(sessionId);
        // The first request's output limit comes from the catalog: wait for it, do not race it.
        await app.loadModels(AbortSignal.timeout(10_000)).catch(() => undefined);
      }
      const runOptions: RunOptions = {
        ...agentOptions,
        // Replay makes no timing promise: a silent-request retry would consume a call twice.
        ...(mode === "replay" ? { firstTokenTimeoutMs: 0 } : {}),
        maxTurns: budget.maxTurns,
        ...(budget.maxTokens !== undefined ? { maxTokens: budget.maxTokens } : {}),
        timeoutMs: budget.maxWallMs + 5_000,
        runId,
      };
      timer = setTimeout(() => {
        budgetReason ??= "maxWallMs";
        controller.abort(new EvalBudgetExceeded("maxWallMs"));
      }, budget.maxWallMs);
      const began = performance.now();
      try {
        const result = await app.runner.run(sessionId, task.prompt, controller.signal, runOptions);
        usageStats = result.usage;
        if (result.status === "turns-exceeded") budgetReason ??= "maxTurns";
        else if (result.status !== "completed")
          modelFailure = `The run ended with status "${result.status}" (runner protocol violation).`;
      } catch (error) {
        const stats = runStatsOf(error);
        if (stats) usageStats = stats.usage;
        if (!budgetReason) {
          if (observer.timedOut) budgetReason = "maxWallMs";
          else if (
            budget.maxTokens !== undefined &&
            Math.max(observer.tokens, usageStats ? usageStats.input + usageStats.output : 0) >=
              budget.maxTokens
          )
            budgetReason = "maxTokens";
          else if (isModelCaused(error))
            modelFailure = error instanceof Error ? error.message : String(error);
          else infraError = error instanceof Error ? error.message : String(error);
        }
      } finally {
        wallMs = performance.now() - began;
      }
    } finally {
      if (timer) clearTimeout(timer);
      try {
        await app?.close();
      } finally {
        restoreEnv();
        if (mode !== "live") setIdSource(undefined);
      }
    }

    if (replay) {
      let reason: ReplayDivergenceError | ReplayExhausted | ReplayUnconsumedError | undefined =
        replay.failure;
      if (!reason && !infraError && !budgetReason && !modelFailure) {
        try {
          replay.assertConsumed();
        } catch (error) {
          if (error instanceof ReplayUnconsumedError) reason = error;
          else throw error;
        }
      }
      if (reason) {
        divergence = {
          kind:
            reason instanceof ReplayDivergenceError
              ? "fingerprint"
              : reason instanceof ReplayExhausted
                ? "exhausted"
                : "unconsumed",
          message: reason.message,
          diff: reason instanceof ReplayDivergenceError ? reason.diff : [],
        };
        infraError = "replay_divergence";
      }
    }
    if (recorder?.unstable && !infraError)
      infraError = `Cassette recording failed: ${recorder.unstable}`;
    if (
      !budgetReason &&
      !infraError &&
      budget.maxTokens !== undefined &&
      observer.tokens > budget.maxTokens
    )
      budgetReason = "maxTokens";
    if (!infraError)
      verifiers = await runVerifiers(task.verifiers, {
        cwd: ws,
        baseline,
        toolEvents: observer.toolEvents(),
        tmpDir: dirs.tmp,
      });
  } catch (error) {
    infraError ??= error instanceof Error ? error.message : String(error);
  }

  const failed = verifiers.some((v) => v.status === "fail");
  const verifierError = verifiers.find((v) => v.status === "error");
  let status: EvalRunRecord["status"];
  let error = infraError;
  if (modelFailure && !infraError) {
    observer.markAborted();
    error = modelFailure;
  }
  if (infraError) status = "error";
  else if (modelFailure) status = "fail";
  else if (verifierError && !failed) {
    status = "error";
    error = `Verifier "${verifierError.id}" could not run: ${verifierError.detail ?? "unknown reason"}`;
  } else if (budgetReason) status = "budget_exceeded";
  else status = failed ? "fail" : "pass";

  const usage =
    observer.usage ??
    (usageStats && usageStats.input + usageStats.output > 0 ? usageStats : undefined);
  const record: EvalRunRecord = {
    schemaVersion: 1,
    runId,
    suiteId: suite.suiteId,
    suiteVersion: suite.suiteVersion,
    taskId: task.id,
    repetition: opts.repetition,
    seed: opts.seed,
    // `loadVersion` falls back to "dev" when no package manifest is found (source runs).
    harnessVersion: loadVersion(import.meta.url),
    configHash,
    compactionHash,
    provider: providerId,
    model: observer.model ?? model,
    mode: mode === "replay" ? "replay" : "live",
    startedAt,
    endedAt: Date.now(),
    status,
    ...(status === "budget_exceeded" && budgetReason ? { budgetExceeded: budgetReason } : {}),
    ...(error ? { error: error.slice(0, 500) } : {}),
    verifiers: verifiers.map((v) => ({
      id: v.id,
      status: v.status,
      ...(v.detail === undefined ? {} : { detail: v.detail }),
    })),
    measured: {
      ...(usage ? { inputTokens: usage.input, outputTokens: usage.output } : {}),
      ...(usage && observer.usagePartial ? { usagePartial: true as const } : {}),
      wallMs,
      turns: observer.turns,
      toolCalls: observer.startedCalls,
    },
    incidents: observer.incidentList(),
    ...(divergence ? { divergence } : {}),
  };
  if (runDir && !opts.keep) rmSync(runDir, { recursive: true, force: true });
  return { record, ...(runDir && opts.keep ? { keptDir: runDir } : {}) };
}
