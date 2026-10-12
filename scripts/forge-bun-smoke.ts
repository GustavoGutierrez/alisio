/**
 * Runtime smoke of the Forja JavaScript engine (spec FJ-AC-07, §16): run with the repository's Bun
 * (`node_modules/.bin/bun scripts/forge-bun-smoke.ts`) or with Node (`--experimental-strip-types`).
 * It drives the REAL kernel, QuickJS and isolate hosts (the process host is what Bun uses) through
 * a busy loop that must time out, one that is cancelled, and a script that calls a tool, then
 * prints the measured times. Vitest runs on Node, so this is how the Bun side is exercised.
 */
import assert from "node:assert/strict";
import { kernelFixture, probeTools } from "../tests/forge-kernel-helpers.ts";

const host = (process.argv[2] ?? "auto") as "auto" | "worker" | "process";
const runtime = process.versions.bun
  ? `bun ${process.versions.bun}`
  : `node ${process.versions.node}`;
const fx = await kernelFixture({ host, tools: [probeTools().echo] });
const report: Record<string, unknown> = {
  runtime,
  host: host === "auto" ? (process.versions.bun ? "process" : "worker") : host,
};
try {
  const basic = await fx.run("const r = await tools.call('echo', { n: 21 }); return r.n * 2;");
  assert.equal(basic.status, "succeeded");
  assert.equal(basic.value, 42);

  const started = Date.now();
  const timeout = await fx.run("while (true) {}", { requestedLimits: { timeoutMs: 400 } });
  const timeoutMs = Date.now() - started;
  assert.equal(timeout.status, "timed_out");
  assert.ok(timeoutMs < 400 + 1000, `timeout took ${timeoutMs} ms`);
  assert.equal(fx.journal.get(timeout.executionId)?.terminationUnconfirmed, false);
  report.timeoutWallMs = timeoutMs;

  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("stop")), 200);
  const cancelStarted = Date.now();
  const cancelled = await fx.run("while (true) {}", { signal: controller.signal });
  const cancelMs = Date.now() - cancelStarted - 200;
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelMs < 1000, `cancel took ${cancelMs} ms`);
  report.cancelToStopMs = cancelMs;

  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    const empty = await fx.run("return 1;");
    assert.equal(empty.status, "succeeded");
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  report.emptyRunP50Ms = Math.round(times[10] ?? 0);
  report.emptyRunP95Ms = Math.round(times[18] ?? 0);

  const nested = await fx.run(
    "const t = []; for (let i = 0; i < 40; i++) { const s = Date.now(); await tools.call('echo', { n: i }); t.push(Date.now() - s); } t.sort((a, b) => a - b); return { p50: t[20], p95: t[38] };",
  );
  assert.equal(nested.status, "succeeded");
  report.nestedCallMs = nested.value;
  console.log(JSON.stringify(report));
} finally {
  await fx.close();
}
