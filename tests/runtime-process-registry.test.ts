import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  killAllTrackedProcesses,
  processKillPlan,
  runProcess,
  terminateAllTrackedProcesses,
  trackedProcesses,
  trackProcess,
} from "../packages/core/src/index.ts";

const posix = process.platform !== "win32";

/** Whether any process of the POSIX process group `pgid` is still alive. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Starts a shell command through `runProcess`; resolves with its pid once it has spawned. */
async function start(script: string, signal = new AbortController().signal) {
  let pid: number | undefined;
  const result = runProcess("/bin/sh", ["-c", script], {
    cwd: process.cwd(),
    signal,
    timeoutMs: 60_000,
    onSpawn: (p) => {
      pid = p;
    },
  });
  result.catch(() => {});
  await waitFor(() => pid !== undefined);
  return { pid: pid as number, result };
}

afterEach(() => {
  killAllTrackedProcesses();
});

describe("live process registry: kill plans", () => {
  it("kills a POSIX process group with SIGKILL to the negative pid, a plain child by its pid", () => {
    expect(processKillPlan({ pid: 4242, group: true }, "linux")).toEqual({
      kind: "signal",
      target: -4242,
      signal: "SIGKILL",
    });
    expect(processKillPlan({ pid: 4242, group: false }, "darwin")).toEqual({
      kind: "signal",
      target: 4242,
      signal: "SIGKILL",
    });
  });

  it("kills the whole tree with taskkill /T /F on Windows", () => {
    for (const group of [true, false])
      expect(processKillPlan({ pid: 77, group }, "win32")).toEqual({
        kind: "spawn",
        command: "taskkill",
        args: ["/PID", "77", "/T", "/F"],
      });
  });
});

describe("live process registry: add and remove", () => {
  it("tracks an entry until its release function is called, and releasing twice is harmless", () => {
    const release = trackProcess(999_999_001, { group: false });
    expect(trackedProcesses()).toContainEqual({ pid: 999_999_001, group: false });
    release();
    release();
    expect(trackedProcesses().some((p) => p.pid === 999_999_001)).toBe(false);
  });

  it.skipIf(!posix)(
    "registers a runProcess child while it runs and forgets it after it exits",
    async () => {
      const { pid, result } = await start("sleep 0.2");
      expect(trackedProcesses()).toContainEqual({ pid, group: posix });
      await result;
      expect(trackedProcesses().some((p) => p.pid === pid)).toBe(false);
    },
  );
});

describe.skipIf(!posix)("live process registry: kill everything (POSIX)", () => {
  it("killAllTrackedProcesses kills a process group that ignores SIGTERM, synchronously", async () => {
    const { pid, result } = await start('trap "" TERM; sleep 60 & wait');
    expect(groupAlive(pid)).toBe(true);
    expect(killAllTrackedProcesses()).toBeGreaterThanOrEqual(1);
    await result;
    await waitFor(() => !groupAlive(pid));
    expect(trackedProcesses().some((p) => p.pid === pid)).toBe(false);
  });

  it("terminateAllTrackedProcesses gives SIGTERM a grace, then SIGKILLs the group within the bound", async () => {
    const { pid, result } = await start('trap "" TERM; sleep 60 & wait');
    const began = Date.now();
    await terminateAllTrackedProcesses({ graceMs: 300 });
    expect(Date.now() - began).toBeLessThan(2_000);
    await result;
    await waitFor(() => !groupAlive(pid), 1_000);
  });

  it("returns early when every group ends on SIGTERM", async () => {
    const { pid } = await start("sleep 60");
    const began = Date.now();
    await terminateAllTrackedProcesses({ graceMs: 5_000 });
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(groupAlive(pid)).toBe(false);
  });

  it("keeps tracking a group whose leader exited while a member still runs, and kills it", async () => {
    // The shell leaves a sleep behind (stdio detached) and exits at once: runProcess resolves.
    const { pid, result } = await start("sleep 60 >/dev/null 2>&1 </dev/null & echo $!");
    const done = await result;
    const leftover = Number(done.stdout.trim());
    expect(leftover).toBeGreaterThan(0);
    expect(groupAlive(pid)).toBe(true);
    expect(trackedProcesses()).toContainEqual({ pid, group: true });
    killAllTrackedProcesses();
    await waitFor(() => !groupAlive(pid));
  });

  it("aborting a run that ignores SIGTERM still ends its whole group after the grace", async () => {
    const controller = new AbortController();
    let pid: number | undefined;
    const result = runProcess("/bin/sh", ["-c", 'trap "" TERM; sleep 60 & wait'], {
      cwd: process.cwd(),
      signal: controller.signal,
      killGraceMs: 200,
      onSpawn: (p) => {
        pid = p;
      },
    });
    await waitFor(() => pid !== undefined);
    controller.abort();
    await expect(result).rejects.toThrow();
    await waitFor(() => !groupAlive(pid as number), 2_000);
  });
});

describe.skipIf(!posix)("live process registry: exit hook (POSIX)", () => {
  it("a process.exit() that skips every close still kills the tracked groups", async () => {
    const core = join(
      import.meta.dirname,
      "..",
      "packages",
      "core",
      "src",
      "runtime",
      "process.ts",
    );
    const script = `
      import { runProcess } from ${JSON.stringify(pathToFileURL(core).href)};
      runProcess("/bin/sh", ["-c", 'trap "" TERM; sleep 60 & wait'], {
        cwd: process.cwd(),
        signal: new AbortController().signal,
        timeoutMs: 60_000,
        onSpawn: (pid) => {
          console.log(pid);
          setTimeout(() => process.exit(0), 100);
        },
      }).catch(() => {});`;
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        script,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code).toBe(0);
    const pid = Number(out.trim());
    expect(pid).toBeGreaterThan(0);
    await waitFor(() => !groupAlive(pid), 2_000);
  });
});
