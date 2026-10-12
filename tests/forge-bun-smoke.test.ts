/**
 * FJ-AC-07 on Bun: vitest runs on Node, so the Bun side is a script (`scripts/forge-bun-smoke.ts`)
 * run with the repository's own Bun. It drives the real kernel and QuickJS through both isolate
 * hosts on Bun: a call, a busy loop that times out within the deadline plus a second, a
 * cancellation, and the host cleaned up.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const bun = resolve("node_modules/.bin/bun");

describe.skipIf(!existsSync(bun) || process.platform === "win32")(
  "Bun smoke of the isolate hosts",
  () => {
    it.each(["process", "worker"])(
      "runs, times out and cancels with the %s host",
      (host) => {
        const run = spawnSync(bun, ["scripts/forge-bun-smoke.ts", host], {
          encoding: "utf8",
          timeout: 60_000,
        });
        expect(run.status, run.stderr + run.stdout).toBe(0);
        const report = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as Record<
          string,
          number
        >;
        expect(report.timeoutWallMs).toBeLessThan(1400);
        expect(report.cancelToStopMs).toBeLessThan(1000);
      },
      70_000,
    );
  },
);
