/**
 * Live process registry: every child process Alisio spawns through `runProcess` (shell commands,
 * background tasks, git, ripgrep...) and its long-lived workers register here while they can still
 * be alive, so that a shutdown can stop all of them, including on paths that skip an orderly close.
 *
 * - On POSIX a `runProcess` child leads its own process group (`detached`), and the entry is the
 *   group: it stays tracked after the leader exits while any member is still alive (a command left
 *   running with `cmd &`), and is dropped once the group is empty. A POSIX process group id is not
 *   reused while one of its members is alive, so killing `-pgid` only hits what Alisio started.
 * - On Windows the entry is the process; `taskkill /T /F` kills it and the descendants Windows can
 *   still link to it. A descendant whose parent already exited cannot be found that way.
 *
 * `killAllTrackedProcesses` is synchronous (SIGKILL, or `taskkill` through `spawnSync`), so it is
 * also installed as a `process.on("exit")` hook the first time something is tracked: even a
 * `process.exit()` that bypasses every `close()` takes the tracked processes with it. Nothing can
 * run after SIGKILL of Alisio itself or a power loss. This is lifecycle hygiene, not a sandbox.
 */
import { type ChildProcess, spawnSync } from "node:child_process";

export interface TrackedProcess {
  pid: number;
  /** The pid leads a POSIX process group (`runProcess` children): the whole group is the target. */
  group: boolean;
}

export type ProcessKillPlan =
  | { kind: "signal"; target: number; signal: "SIGKILL" | "SIGTERM" }
  | { kind: "spawn"; command: "taskkill"; args: string[] };

/**
 * Grace the final shutdown sweep gives SIGTERM before SIGKILL. Part of the shutdown budget of
 * `alisio serve` and Alisio Desktop (`SERVER_CLOSE_BUDGET_MS` in `@alisio/server`).
 */
export const PROCESS_SWEEP_GRACE_MS = 1_000;

interface Entry extends TrackedProcess {
  /** The tracked process itself exited (a POSIX group may still have members). */
  exited: boolean;
}

const LIVE = new Map<number, Entry>();
let exitHookInstalled = false;

/** How to force-kill one tracked entry on `platform` (pure, for tests and both callers). */
export function processKillPlan(
  entry: TrackedProcess,
  platform: NodeJS.Platform = process.platform,
): ProcessKillPlan {
  if (platform === "win32")
    return { kind: "spawn", command: "taskkill", args: ["/PID", String(entry.pid), "/T", "/F"] };
  return { kind: "signal", target: entry.group ? -entry.pid : entry.pid, signal: "SIGKILL" };
}

/** Whether the entry still has a live process (POSIX: any member of the group). */
function alive(entry: TrackedProcess): boolean {
  if (process.platform === "win32") return true;
  try {
    process.kill(entry.group ? -entry.pid : entry.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Drops entries whose process (or whole group) is gone. */
function prune(): void {
  for (const [pid, entry] of LIVE) if (entry.exited && !alive(entry)) LIVE.delete(pid);
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    killAllTrackedProcesses();
  });
}

/**
 * Tracks `pid` until the returned function is called (call it when the process exits). On POSIX a
 * group entry stays tracked after that while a member of the group is still alive.
 */
export function trackProcess(pid: number, options: { group?: boolean } = {}): () => void {
  prune();
  const entry: Entry = { pid, group: options.group ?? false, exited: false };
  LIVE.set(pid, entry);
  installExitHook();
  return () => {
    if (LIVE.get(pid) !== entry) return;
    entry.exited = true;
    if (process.platform === "win32" || !entry.group || !alive(entry)) LIVE.delete(pid);
  };
}

/**
 * Tracks a long-lived worker child (not a group leader) until it exits or fails to spawn. For
 * workers that are normally stopped by their own `close()`: the registry is the backstop.
 */
export function trackChild(child: ChildProcess): void {
  if (child.pid === undefined) return;
  const release = trackProcess(child.pid);
  child.once("exit", release);
  child.once("error", release);
}

/** The entries that may still be alive (tests and diagnostics). */
export function trackedProcesses(): TrackedProcess[] {
  prune();
  return [...LIVE.values()].map(({ pid, group }) => ({ pid, group }));
}

function execute(plan: ProcessKillPlan): void {
  try {
    if (plan.kind === "signal") process.kill(plan.target, plan.signal);
    else spawnSync(plan.command, plan.args, { stdio: "ignore", windowsHide: true, timeout: 5_000 });
  } catch {
    /* already gone */
  }
}

/**
 * Force-kills every tracked process (group) right now and forgets them. Synchronous and never
 * throws, so it is safe inside a `process.on("exit")` handler. Returns how many entries it hit.
 */
export function killAllTrackedProcesses(): number {
  const entries = [...LIVE.values()];
  LIVE.clear();
  for (const entry of entries) execute(processKillPlan(entry));
  return entries.length;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Graceful sweep for a shutdown: SIGTERM every tracked process group, wait up to `graceMs` for
 * them to end, then SIGKILL whatever is left. On Windows there is no SIGTERM for a tree: it kills
 * at once (`taskkill /T /F`). Resolves within `graceMs` plus a few milliseconds.
 */
export async function terminateAllTrackedProcesses(
  options: { graceMs?: number; pollMs?: number } = {},
): Promise<void> {
  prune();
  if (LIVE.size === 0) return;
  if (process.platform === "win32") {
    killAllTrackedProcesses();
    return;
  }
  for (const entry of LIVE.values()) {
    try {
      process.kill(entry.group ? -entry.pid : entry.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  const until = Date.now() + (options.graceMs ?? PROCESS_SWEEP_GRACE_MS);
  const poll = options.pollMs ?? 50;
  while (Date.now() < until) {
    if (![...LIVE.values()].some(alive)) break;
    await sleep(Math.min(poll, Math.max(1, until - Date.now())));
  }
  for (const [pid, entry] of LIVE) if (!alive(entry)) LIVE.delete(pid);
  killAllTrackedProcesses();
}
