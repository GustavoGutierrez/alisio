/**
 * `alisio_runtime.forge` (Python spec §7) against a real CPython: what a script's calls put on
 * stdout, that the host transport accepts all of it, and that it degrades to plain output when the
 * script runs outside Alisio. Skipped where no Python 3.10+ is installed.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GuestMessage } from "../packages/core/src/forge/protocol.ts";
import { FrameDecoder } from "../packages/core/src/forge/python/frame-parser.ts";
import { StdoutFrameTransport } from "../packages/core/src/forge/python/frame-transport.ts";

const python = ["python3", "python"].find((cmd) => {
  const r = spawnSync(cmd, ["-c", "import sys; print(sys.version_info >= (3, 10))"], {
    encoding: "utf8",
  });
  return r.status === 0 && r.stdout.trim() === "True";
});

const NONCE = "abcdefabcdefabcdefabcdefabcdefab";
const RUNTIME = resolve("packages/core/src/analysis/python");
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "alisio-forgepy-"));
  mkdirSync(join(dir, "work", ".forge"), { recursive: true });
  writeFileSync(join(dir, "work", ".forge", "state.json"), JSON.stringify({ last: "ds_1", n: 3 }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(script: string, env: Record<string, string> = {}) {
  const r = spawnSync(python as string, ["-s", "-B", "-X", "utf8", "-c", script], {
    cwd: join(dir, "work"),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      PYTHONPATH: RUNTIME,
      ALISIO_WORK_DIR: join(dir, "work"),
      ...env,
    },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}
const inAlisio = { ALISIO_FORGE_NONCE: NONCE, ALISIO_FORGE_ENGINE: "python-managed" };

/** What the host transport makes of the stdout: the messages it accepts and the text it shows. */
async function viaHost(stdout: string) {
  const messages: GuestMessage[] = [];
  const text: string[] = [];
  const failures: string[] = [];
  const transport = new StdoutFrameTransport({
    nonce: NONCE,
    receive: async (m) => void messages.push(m),
    onText: (t) => text.push(t),
    onFailure: (e) => failures.push(e.message),
  });
  transport.feed(stdout);
  await transport.end();
  return { messages, text: text.join(""), failures, completion: transport.completion };
}

describe.skipIf(!python)("alisio_runtime.forge", () => {
  it("is part of runtime version 4", () => {
    const r = run("import alisio_runtime; print(alisio_runtime.__version__)");
    expect(r.stdout.trim()).toBe("4");
  });

  it("emits ready first, then progress, text and the final value, all accepted by the host", async () => {
    const r = run(
      [
        "from alisio_runtime import forge",
        "forge.progress('Training', completed=1, total=3)",
        "forge.text('hello ')",
        "forge.text({'rows': 2})",
        "forge.result({'best': [1, 2]})",
        "print('plain line')",
      ].join("\n"),
      inAlisio,
    );
    expect(r.status).toBe(0);
    const host = await viaHost(r.stdout);
    expect(host.failures).toEqual([]);
    expect(host.messages.map((m) => m.type)).toEqual(["progress", "output", "output"]);
    expect(host.messages[0]).toMatchObject({
      payload: { message: "Training", completed: 1, total: 3 },
    });
    expect(host.messages.slice(1).map((m) => (m.payload as { text: string }).text)).toEqual([
      "hello ",
      '{"rows": 2}',
    ]);
    expect(host.completion).toEqual({ value: { best: [1, 2] } });
    expect(host.text).toBe("plain line\n");
    // `ready` names the engine the host passed in the environment.
    const decoder = new FrameDecoder(NONCE);
    const first = decoder.feed(r.stdout).find((e) => e.type === "frame");
    expect(JSON.parse((first as { json: string }).json)).toMatchObject({
      type: "ready",
      seq: 0,
      payload: { engine: "python-managed" },
    });
  });

  it("sends the result even when the script exits early with sys.exit", async () => {
    const r = run(
      "import sys\nfrom alisio_runtime import forge\nforge.result(42)\nsys.exit(0)\nprint('unreachable')",
      inAlisio,
    );
    expect((await viaHost(r.stdout)).completion).toEqual({ value: 42 });
  });

  it("reads the snapshot, and set and delete are visible to the script at once and sent to the host", async () => {
    const r = run(
      [
        "from alisio_runtime import forge",
        "print(forge.state.get('last'), forge.state.get('missing', 'dflt'))",
        "forge.state.set('last', 'ds_2')",
        "forge.state.delete('n')",
        "print(forge.state.get('last'), forge.state.get('n'))",
      ].join("\n"),
      inAlisio,
    );
    const host = await viaHost(r.stdout);
    expect(host.failures).toEqual([]);
    expect(host.text).toBe("ds_1 dflt\nds_2 None\n");
    expect(host.messages.map((m) => [m.type, m.payload])).toEqual([
      ["state.set", { key: "last", value: "ds_2" }],
      ["state.delete", { key: "n" }],
    ]);
  });

  it("refuses values that are not JSON in the caller's frame instead of ending the run", () => {
    for (const call of ["forge.result(float('nan'))", "forge.state.set('k', object())"]) {
      const r = run(
        `from alisio_runtime import forge\ntry:\n    ${call}\nexcept (TypeError, ValueError):\n    print('refused')`,
        inAlisio,
      );
      expect(r.stdout).toContain("refused");
      expect(r.stdout).not.toContain("ALISIO-FORGE");
    }
  });

  it("refuses a message over the protocol cap before sending it", () => {
    const r = run(
      "from alisio_runtime import forge\ntry:\n    forge.state.set('k', 'x' * 300000)\nexcept ValueError as e:\n    print('too large')",
      inAlisio,
    );
    expect(r.stdout.trim().split("\n").at(-1)).toBe("too large");
  });

  it("without a nonce it degrades to plain output and keeps state in memory", () => {
    const r = run(
      [
        "from alisio_runtime import forge",
        "forge.progress('step', completed=1, total=2)",
        "forge.text({'a': 1})",
        "forge.result([1])",
        "forge.state.set('k', 5)",
        "print(forge.state.get('k'), forge.state.get('last'))",
      ].join("\n"),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('step (1/2)\n{"a": 1}\n[1]\n5 ds_1\n');
    expect(r.stdout).not.toContain("ALISIO-FORGE");
  });
});
