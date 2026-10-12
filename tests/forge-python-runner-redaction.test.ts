/**
 * What the wasm runner prints when it fails reaches the model, so it must not carry host
 * absolute paths (L5). The runner is plain JavaScript: it is run here under the test's own Node
 * with a distribution that does not exist, which makes the import fail with a path-heavy stack.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RUNNER = resolve("packages/core/src/forge/python/pyodide-runner.mjs");
let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "alisio-runner-private-"));
});
afterEach(() => rm(base, { recursive: true, force: true }));

describe("runner failure output (L5)", () => {
  it("names the distribution and the job folders by placeholder, never by host path", () => {
    const dist = join(base, "state", "analysis", "pyodide", "1.0");
    const spec = {
      dist,
      packages: [],
      wheels: [],
      job: {
        script: join(base, "job", "script"),
        input: join(base, "job", "input"),
        work: join(base, "job", "work"),
        out: join(base, "job", "staging"),
        scratch: join(base, "job", "scratch-copy"),
      },
    };
    const run = spawnSync(process.execPath, [RUNNER, JSON.stringify(spec)], {
      encoding: "utf8",
      env: {},
    });
    expect(run.status).toBe(70);
    expect(run.stderr).toContain("alisio wasm runner:");
    expect(run.stderr).toContain("<dist>");
    expect(run.stderr).not.toContain(base);
    // Whatever other absolute path the stack shows (the runner's own file, node_modules) is cut
    // down to its last segment under a placeholder.
    expect(run.stderr).not.toContain(resolve("packages"));
    expect(run.stderr).not.toMatch(/(?:^|[\s(])\/(?:home|tmp|usr|var)\//m);
  });
});
