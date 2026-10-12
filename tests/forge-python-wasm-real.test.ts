/**
 * The wasm backend against the REAL Pyodide 314.0.7 (Python spec §10.2: FP-AC-04, 10-17, 23, 26-28
 * on wasm). Slow (about 1-12 s per Pyodide start), so it only runs with ALISIO_TEST_PYODIDE=1 and
 * a verified local distribution in ALISIO_TEST_PYODIDE_DIST (the files `alisio analysis setup
 * --wasm` would download). The distribution is installed through the real installer, with a fetch
 * that serves the local files, so every pinned hash is checked.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toRef } from "../packages/core/src/artifacts/store.ts";
import type {
  IsolationPolicy,
  PythonRuntimeSetting,
} from "../packages/core/src/forge/python/backend-selector.ts";
import { PyodideBackend } from "../packages/core/src/forge/python/pyodide-backend.ts";
import { installPyodide, pyodideDir } from "../packages/core/src/forge/python/pyodide-install.ts";
import { PYODIDE_MANIFEST } from "../packages/core/src/forge/python/pyodide-manifest.ts";
import { resetNodeCaches } from "../packages/core/src/forge/python/wasm-node.ts";
import { rendererFor } from "../packages/web/src/util/panel.ts";
import { type AnalysisHarness, analysisHarness } from "./analysis-run-helpers.ts";
import { fakeContainer, realInterpreter, realPython } from "./forge-python-helpers.ts";
import { buildXlsx } from "./xlsx-helpers.ts";

const DIST = process.env.ALISIO_TEST_PYODIDE_DIST;
const enabled = process.env.ALISIO_TEST_PYODIDE === "1" && !!DIST;
const SLOW = 180_000;

let stateRoot = "";
const cleanups: Array<() => Promise<void>> = [];
const measured: Record<string, unknown> = {};

beforeAll(async () => {
  if (!enabled) return;
  stateRoot = await mkdtemp(join(tmpdir(), "alisio-pyodide-real-"));
  await installPyodide({
    dir: pyodideDir(stateRoot),
    profile: "science",
    fetch: async (url) => new Response(await readFile(join(DIST as string, basename(String(url))))),
  });
}, SLOW);
afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  if (stateRoot) await rm(stateRoot, { recursive: true, force: true });
  if (enabled) console.info(`[wasm real] ${JSON.stringify(measured)}`);
});

const wasmSettings = (over: Record<string, unknown> = {}) => ({
  memoryMb: 3072,
  startupMs: 60_000,
  maxInputBytes: 100 * 1024 * 1024,
  // A node that has the CVE-2025-55130 fix (>= 22.22 / 24.13 / 25.3); null = the running one.
  nodePath: process.env.ALISIO_TEST_PYODIDE_NODE ?? null,
  ...over,
});

async function harness(
  options: {
    mode?: PythonRuntimeSetting;
    isolation?: IsolationPolicy;
    settings?: Record<string, unknown>;
    hostPython?: "real" | "fake";
  } = {},
): Promise<AnalysisHarness> {
  resetNodeCaches();
  const c = await fakeContainer({ engineMissing: true });
  cleanups.push(() => c.dispose());
  const h = await analysisHarness({
    deps: {
      ...(options.hostPython === "real" ? { runtime: { interpreter: realInterpreter } } : {}),
      oci: { mode: () => options.mode ?? "wasm", runtime: () => c.runtime },
      isolation: () => options.isolation ?? "preferred",
      wasm: { stateRoot, settings: () => wasmSettings(options.settings) },
    },
  });
  cleanups.push(() => h.dispose());
  return h;
}

const lastLine = (text: string) => text.split("\n").at(-1) ?? "";
const forgeRows = (h: AnalysisHarness) =>
  h.store.db.prepare("SELECT * FROM forge_executions ORDER BY started_at, id").all() as Array<
    Record<string, unknown>
  >;
const artifacts = (h: AnalysisHarness) => h.artifacts.list(h.store.rootOf(h.session));
const provenanceOf = (h: AnalysisHarness) =>
  JSON.parse(
    (h.store.db.prepare("SELECT provenance FROM artifacts LIMIT 1").get() as { provenance: string })
      .provenance,
  ) as { runtime: Record<string, unknown> };
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!enabled)("real Pyodide: selection and a pandas run (FP-AC-04)", () => {
  it(
    "auto with no container runs a pandas script on wasm, publishes its file and reports startup and memory",
    async () => {
      const h = await harness({ mode: "auto" });
      const code = [
        "import pandas as pd, os",
        'df = pd.DataFrame({"a": [1, 2, 3], "b": [4, 5, 6]})',
        'print("sum", int(df.a.sum() + df.b.sum()))',
        'open(os.environ["ALISIO_OUTPUT_DIR"] + "/r.csv", "w").write(df.to_csv(index=False))',
      ].join("\n");
      const { text, result } = await h.run({ code });
      expect(result.isError, text).toBeFalsy();
      expect(text).toContain("sum 21");
      expect(lastLine(text)).toContain("engine: python-wasm (wasm-process)");
      expect(artifacts(h).map((a) => a.fileName)).toEqual(["r.csv"]);
      const runtime = provenanceOf(h).runtime;
      expect(runtime).toMatchObject({
        mode: "wasm",
        pyodide: "314.0.7",
        python: "3.14.2",
        profile: "science",
      });
      measured.pandas = { startupMs: runtime.startupMs, peakRssMb: runtime.peakRssMb };
      expect(runtime.startupMs).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    "a run that raises fails with the traceback of main.py and leaves one wasm execution (FP-AC-08)",
    async () => {
      const h = await harness({ mode: "auto" });
      const { text, result } = await h.run({
        code: "def f():\n    raise ValueError('nope')\nf()\n",
      });
      expect(result.isError).toBe(true);
      expect(text).toContain("ValueError: nope");
      expect(text).toContain("main.py");
      expect(h.executions().map((e) => [e.runtime, e.status])).toEqual([["wasm", "failed"]]);
    },
    SLOW,
  );

  it(
    "carries Forja frames over Pyodide's stdout: progress, state and the final value",
    async () => {
      const h = await harness({ mode: "wasm" });
      const code = [
        "from alisio_runtime import forge",
        "forge.progress('Loading', completed=1, total=2)",
        "forge.state.set('last', {'rows': 3})",
        "forge.text('explicit output')",
        "forge.result({'ok': True})",
      ].join("\n");
      const { text, result } = await h.run({ code });
      expect(result.isError, text).toBeFalsy();
      expect(text).toContain("explicit output");
      expect(text).toContain('value: {"ok":true}');
      const state = h.store.db.prepare("SELECT key, value_json FROM forge_state").all();
      expect(state).toEqual([{ key: "last", value_json: '{"rows":3}' }]);
    },
    SLOW,
  );
});

describe.skipIf(!enabled)("real Pyodide: dashboards and data (FP-AC-10, 11, 12)", () => {
  const dashboard = [
    "from alisio_runtime import charts",
    "body = charts.grid(charts.card('Status', charts.donut(['A', 'B'], [81.7, 18.3])))",
    "charts.write('dashboard.html', 'Sales', body)",
  ].join("\n");

  it(
    "FP-AC-10: a dashboard from alisio_runtime.charts is a dashboard artifact the panel opens in its HTML frame",
    async () => {
      const h = await harness({ mode: "wasm" });
      const { text, result } = await h.run({ code: dashboard });
      expect(result.isError, text).toBeFalsy();
      expect(text).not.toContain("warning:");
      const [artifact] = artifacts(h);
      expect(artifact?.kind).toBe("dashboard");
      expect(rendererFor(toRef(artifact as never))).toEqual({ kind: "html" });
    },
    SLOW,
  );

  it.skipIf(!realPython)(
    "FP-AC-10: the page is byte for byte the one the host Python writes",
    async () => {
      const wasm = await harness({ mode: "wasm" });
      await wasm.run({ code: dashboard });
      const managed = await harness({ mode: "managed", hostPython: "real" });
      await managed.run({ code: dashboard });
      const read = async (h: AnalysisHarness) => {
        const [a] = artifacts(h);
        return readFile(h.artifacts.localPath(h.artifacts.get(a?.id ?? "") as never));
      };
      expect(sha(await read(wasm))).toBe(sha(await read(managed)));
    },
    SLOW,
  );

  it(
    "FP-AC-11: scikit-learn, statsmodels and a Matplotlib PNG on the science profile, with the metrics of the fixture",
    async () => {
      const h = await harness({ mode: "wasm" });
      const code = [
        "import numpy as np, os",
        "from sklearn.datasets import make_classification",
        "from sklearn.model_selection import train_test_split",
        "from sklearn.linear_model import LogisticRegression",
        "X, y = make_classification(n_samples=500, n_features=8, random_state=0)",
        "Xt, Xv, yt, yv = train_test_split(X, y, random_state=0)",
        'print("acc", round(LogisticRegression(max_iter=500).fit(Xt, yt).score(Xv, yv), 3))',
        "import statsmodels.api as sm",
        "rng = np.random.default_rng(0); x = rng.normal(size=200); yy = 2 * x + 1 + rng.normal(size=200) * .1",
        "r = sm.OLS(yy, sm.add_constant(x)).fit()",
        'print("ols", r.params.round(2).tolist(), round(r.rsquared, 3))',
        "import matplotlib.pyplot as plt",
        "fig, ax = plt.subplots(); ax.plot([1, 2, 3], [3, 1, 2])",
        'fig.savefig(os.environ["ALISIO_OUTPUT_DIR"] + "/c.png", dpi=80)',
      ].join("\n");
      const { text, result } = await h.run({ code });
      expect(result.isError, text).toBeFalsy();
      const acc = Number(/acc ([\d.]+)/.exec(text)?.[1]);
      // Fixture tolerance: 0.792 on Pyodide 314.0.7; a different BLAS may move the last digits.
      expect(acc).toBeGreaterThan(0.77);
      expect(acc).toBeLessThan(0.81);
      expect(text).toContain("ols [0.99, 1.99] 0.997");
      expect(artifacts(h).map((a) => a.fileName)).toEqual(["c.png"]);
      expect(artifacts(h)[0]?.kind).toBe("image");
      measured.science = {
        startupMs: provenanceOf(h).runtime.startupMs,
        peakRssMb: provenanceOf(h).runtime.peakRssMb,
      };
    },
    SLOW,
  );

  it.skipIf(!realPython)(
    "FP-AC-12: xlsx_to_sqlite gives the same tables and rows as on the host Python",
    async () => {
      const book = await buildXlsx([
        {
          name: "Ventas",
          rows: [
            ["id", "nombre", "monto"],
            [1, "007", 10.5],
            [2, "ñandú", { date: 45000 }],
            [3, null, true],
          ],
        },
        { name: "Otra", rows: [["x"], [1], [2]] },
      ]);
      const code = [
        "import os, runpy, sys, sqlite3, json",
        'inp = os.environ["ALISIO_INPUT_DIR"] + "/book.xlsx"; out = os.environ["ALISIO_WORK_DIR"] + "/data.sqlite"',
        'sys.argv = ["xlsx_to_sqlite", inp, out]',
        "try:",
        '    runpy.run_module("alisio_runtime.xlsx_to_sqlite", run_name="__main__")',
        "except SystemExit as e:",
        '    print("exit", e.code)',
        "db = sqlite3.connect(out)",
        "tables = sorted(r[0] for r in db.execute(\"select name from sqlite_master where type='table'\"))",
        "dump = {t: db.execute(f'select * from \"{t}\" order by rowid').fetchall() for t in tables if t.startswith('s_')}",
        "print('DUMP', json.dumps({'tables': tables, 'rows': dump}, sort_keys=True, default=str))",
      ].join("\n");
      const dumpOf = async (h: AnalysisHarness) => {
        await writeFile(join(h.workspace, "book.xlsx"), book);
        const { text, result } = await h.run({ code, inputs: [{ path: "book.xlsx" }] });
        expect(result.isError, text).toBeFalsy();
        return text.split("\n").find((l) => l.startsWith("DUMP "));
      };
      const wasm = await dumpOf(await harness({ mode: "wasm" }));
      const managed = await dumpOf(await harness({ mode: "managed", hostPython: "real" }));
      expect(wasm).toBeDefined();
      expect(wasm).toBe(managed);
    },
    SLOW,
  );
});

describe.skipIf(!enabled)(
  "real Pyodide: what the restricted child can and cannot do (FP-AC-13..15, 23, 27, 28)",
  () => {
    let target: Server;
    let hits = 0;
    let secretDir = "";
    beforeAll(async () => {
      if (!enabled) return;
      target = createServer((_req, res) => {
        hits++;
        res.end("hello from the host");
      });
      await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
      secretDir = await mkdtemp(join(tmpdir(), "alisio-secret-"));
      await writeFile(join(secretDir, "s.txt"), "TOP-SECRET-VALUE");
    });
    afterAll(async () => {
      if (!enabled) return;
      await new Promise((resolve) => target.close(resolve));
      await rm(secretDir, { recursive: true, force: true });
    });

    it(
      "FP-AC-13 and FP-AC-28: a connection from Python through the FFI is observed, and the descriptor and strict agree with it",
      async () => {
        const port = (target.address() as AddressInfo).port;
        const h = await harness({ mode: "wasm" });
        const code = [
          "import js, asyncio",
          "from pyodide.ffi import create_proxy",
          "async def main():",
          "    done = asyncio.get_event_loop().create_future()",
          "    def end(*a):",
          "        if not done.done(): done.set_result('reached')",
          "    def err(e):",
          "        if not done.done(): done.set_result('denied ' + str(e)[:60])",
          "    http = js.process.getBuiltinModule('node:http')",
          `    req = http.get('http://127.0.0.1:${port}/', create_proxy(lambda res: (res.resume(), res.on('end', create_proxy(end)))))`,
          "    req.on('error', create_proxy(err))",
          "    print('NET', await asyncio.wait_for(done, 8))",
          "try:",
          "    await main()",
          "except BaseException as e:",
          "    print('NET denied', type(e).__name__, str(e)[:80])",
        ].join("\n");
        hits = 0;
        const { text } = await h.run({ code });
        const reached = hits > 0;
        measured.networkReachedFromPython = reached;
        const probe = new PyodideBackend({ stateRoot, settings: () => wasmSettings() });
        const descriptor = await probe.describe();
        measured.networkDeniedByOS = descriptor.capabilities.networkDeniedByOS;
        // What the child did and what the self-probe said must agree.
        expect(descriptor.capabilities.networkDeniedByOS).toBe(!reached);
        expect(text.includes("NET reached")).toBe(reached);
        // Strict follows the probe: wasm is excluded unless the OS denies the network.
        const strict = await harness({ mode: "auto", isolation: "strict" });
        const refused = await strict.run({ code: "print(1)" });
        if (descriptor.capabilities.networkDeniedByOS) expect(refused.result.isError).toBeFalsy();
        else {
          expect(refused.result.isError).toBe(true);
          expect(refused.text).toContain("wasm: excluded by analysis.isolation=strict");
        }
      },
      SLOW,
    );

    it(
      "FP-AC-14: the host's files are out of reach, through Python's own open and through the FFI",
      async () => {
        const h = await harness({ mode: "wasm" });
        const secret = join(secretDir, "s.txt");
        const code = [
          "import js, os",
          "def probe(name, f):",
          "    try:",
          "        r = f()",
          "        print('ALLOWED', name, str(r)[:30])",
          "    except BaseException as e:",
          "        print('DENIED', name, type(e).__name__)",
          "fs = js.process.getBuiltinModule('node:fs')",
          `probe('python open', lambda: open(${JSON.stringify(secret)}).read())`,
          `probe('ffi read secret', lambda: fs.readFileSync(${JSON.stringify(secret)}, 'utf8'))`,
          "probe('ffi list ~/.ssh', lambda: fs.readdirSync(os.path.expanduser('~') + '/.ssh'))",
          `probe('ffi read repo', lambda: fs.readFileSync(${JSON.stringify(join(process.cwd(), "package.json"))}, 'utf8'))`,
          "probe('ffi read /etc/passwd', lambda: fs.readFileSync('/etc/passwd', 'utf8'))",
          `probe('ffi write outside', lambda: fs.writeFileSync(${JSON.stringify(join(secretDir, "pwn.txt"))}, 'x'))`,
        ].join("\n");
        const { text, result } = await h.run({ code });
        expect(result.isError, text).toBeFalsy();
        expect(text).not.toContain("TOP-SECRET-VALUE");
        expect(text).not.toContain("ALLOWED");
        for (const name of [
          "python open",
          "ffi read secret",
          "ffi list ~/.ssh",
          "ffi read repo",
          "ffi read /etc/passwd",
          "ffi write outside",
        ])
          expect(text).toContain(`DENIED ${name}`);
      },
      SLOW,
    );

    it(
      "FP-AC-15: subprocess, workers and child_process are denied; os.system ends the run as a failure",
      async () => {
        const h = await harness({ mode: "wasm" });
        const code = [
          "import js, subprocess",
          "def probe(name, f):",
          "    try:",
          "        f(); print('ALLOWED', name)",
          "    except BaseException as e:",
          "        print('DENIED', name, type(e).__name__)",
          "gb = js.process.getBuiltinModule",
          "probe('subprocess', lambda: subprocess.run(['id'], capture_output=True))",
          "probe('execSync', lambda: gb('node:child_process').execSync('id'))",
          "probe('Worker', lambda: js.Reflect.construct(gb('node:worker_threads').Worker, ['1', {'eval': True}]))",
        ].join("\n");
        const { text, result } = await h.run({ code });
        expect(result.isError, text).toBeFalsy();
        expect(text).not.toContain("ALLOWED");
        for (const name of ["subprocess", "execSync", "Worker"])
          expect(text).toContain(`DENIED ${name}`);
        // os.system is denied by Node as a fatal error: the child dies and the run fails.
        const crash = await harness({ mode: "wasm" });
        const dead = await crash.run({ code: "import os\nos.system('id')\nprint('survived')\n" });
        expect(dead.result.isError).toBe(true);
        expect(dead.text).not.toContain("survived");
        expect(artifacts(crash)).toEqual([]);
      },
      SLOW,
    );

    it(
      "FP-AC-27: process.kill and process._kill are replaced and frozen; the parent survives a kill of its pid",
      async () => {
        const h = await harness({ mode: "wasm" });
        const code = [
          "import js",
          "for name in ('kill', '_kill'):",
          "    try:",
          "        getattr(js.process, name)(js.process.ppid, 9)",
          "        print('ALLOWED', name)",
          "    except BaseException as e:",
          "        print('DENIED', name, str(e)[:60])",
          "try:",
          "    js.process.kill = js.Function('return 1')",
          "    print('REPLACED' if js.process.kill() == 1 else 'KEPT')",
          "except BaseException:",
          "    print('FROZEN')",
          "try:",
          "    print('STILL', js.process.kill(js.process.ppid, 0))",
          "except BaseException as e:",
          "    print('STILL DENIED')",
        ].join("\n");
        const { text, result } = await h.run({ code });
        expect(result.isError, text).toBeFalsy();
        expect(text).not.toContain("ALLOWED");
        expect(text).toContain("DENIED kill");
        expect(text).toContain("DENIED _kill");
        expect(text).not.toContain("REPLACED");
        expect(text).toContain("STILL DENIED");
        // This very process is the parent and is alive to say so.
        expect(() => process.kill(process.pid, 0)).not.toThrow();
      },
      SLOW,
    );

    it.skipIf(spawnSync("strace", ["-V"]).status !== 0)(
      "FP-AC-23: a full run opens no network connection and has no fetch, XMLHttpRequest or navigator",
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "alisio-strace-"));
        cleanups.push(() => rm(dir, { recursive: true, force: true }));
        const trace = join(dir, "connect.trace");
        const wrapper = join(dir, "node-traced");
        await writeFile(
          wrapper,
          `#!/bin/sh\nexec strace -f -qq -e trace=connect -o "${trace}" "${process.execPath}" "$@"\n`,
        );
        await chmod(wrapper, 0o755);
        resetNodeCaches();
        const h = await harness({ mode: "wasm", settings: { nodePath: wrapper } });
        const code = [
          "import js, pandas as pd, numpy as np, matplotlib",
          "print('GLOBALS', [n for n in ('fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'navigator') if hasattr(js, n)])",
          "print('rows', len(pd.DataFrame({'a': np.arange(5)})))",
        ].join("\n");
        const { text, result } = await h.run({ code });
        expect(result.isError, text).toBeFalsy();
        expect(text).toContain("GLOBALS []");
        expect(text).toContain("rows 5");
        const calls = (await readFile(trace, "utf8"))
          .split("\n")
          .filter((l) => /connect\(/.test(l) && /AF_INET/.test(l));
        expect(calls).toEqual([]);
      },
      SLOW,
    );
  },
);

describe.skipIf(!enabled)("real Pyodide: limits (FP-AC-16, 17)", () => {
  it(
    "FP-AC-16: while True: pass times out, the child is gone and the core answers the next call",
    async () => {
      const h = await harness({ mode: "wasm", settings: { startupMs: 4000 } });
      const { text, result } = await h.run({ code: "while True:\n    pass\n", timeoutMs: 1000 });
      expect(result.isError).toBe(true);
      expect(text).toContain("timed out after 1s");
      expect(forgeRows(h)[0]).toMatchObject({ status: "timed_out", termination_unconfirmed: 0 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const left = spawnSync("pgrep", ["-f", `${stateRoot}/analysis/pyodide`], {
        encoding: "utf8",
      });
      expect(left.stdout.trim()).toBe("");
      const next = await h.run({ code: "print('alive')" });
      expect(next.text).toContain("alive");
    },
    SLOW,
  );

  it(
    "FP-AC-17: reserving memory without limit ends in MEMORY_LIMIT and the core carries on",
    async () => {
      const h = await harness({ mode: "wasm", settings: { memoryMb: 700 } });
      const code = [
        "import numpy as np",
        "keep = []",
        "while True:",
        "    keep.append(np.ones(25_000_000))",
      ].join("\n");
      const { text, result } = await h.run({ code });
      expect(result.isError).toBe(true);
      expect(text).toContain("MEMORY_LIMIT");
      expect(forgeRows(h)[0]).toMatchObject({ status: "failed", error_code: "MEMORY_LIMIT" });
      const next = await h.run({ code: "print('alive')" });
      expect(next.text).toContain("alive");
    },
    SLOW,
  );
});

// FP-AC-26 (a compiled binary without node on PATH) is covered by the fast suite.

describe.skipIf(!enabled)("real Pyodide: the scratchpad is a link-free copy (M1)", () => {
  it(
    "a symlink placed in the scratchpad reaches nothing: neither the copy nor the real folder resolves it",
    async () => {
      resetNodeCaches();
      const root = await mkdtemp(join(tmpdir(), "alisio-m1-"));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const outside = join(root, "outside");
      const scratch = join(root, "scratch");
      await mkdir(outside);
      await mkdir(scratch);
      await writeFile(join(outside, "secret.txt"), "TOP-SECRET-VALUE");
      await writeFile(join(scratch, "ok.txt"), "visible");
      await symlink(outside, join(scratch, "link"));
      const jobRoot = join(root, "job");
      const paths = {
        id: "exec_m1",
        root: jobRoot,
        script: join(jobRoot, "script"),
        main: join(jobRoot, "script", "main.py"),
        input: join(jobRoot, "input"),
        work: join(jobRoot, "work"),
        staging: join(jobRoot, "staging"),
        logs: join(jobRoot, "logs"),
      };
      for (const dir of [paths.script, paths.input, paths.work, paths.staging, paths.logs])
        await mkdir(dir, { recursive: true });
      const code = [
        "import js, os",
        "fs = js.process.getBuiltinModule('node:fs')",
        "spec = __import__('json').loads(str(js.process.argv[2]))",
        "granted = spec['job']['scratch']",
        "def probe(name, f):",
        "    try:",
        "        print('ALLOWED', name, str(f())[:30])",
        "    except BaseException as e:",
        "        print('DENIED', name, type(e).__name__)",
        "probe('virtual ok', lambda: open('/job/scratch/ok.txt').read())",
        "probe('virtual link', lambda: os.listdir('/job/scratch/link'))",
        "probe('granted link', lambda: fs.readFileSync(granted + '/link/secret.txt', 'utf8'))",
        `probe('real link', lambda: fs.readFileSync(${JSON.stringify(join(scratch, "link", "secret.txt"))}, 'utf8'))`,
        `probe('real file', lambda: fs.readFileSync(${JSON.stringify(join(scratch, "ok.txt"))}, 'utf8'))`,
      ].join("\n");
      await writeFile(paths.main, code);
      const backend = new PyodideBackend({ stateRoot, settings: () => wasmSettings() });
      await backend.check();
      let stdout = "";
      const running = await backend.launch(
        {
          executionId: "exec_m1",
          paths,
          env: {},
          signal: new AbortController().signal,
          backstopMs: 120_000,
          maxBytes: 1 << 20,
          maxLogBytes: 1 << 20,
          logFiles: { stdout: join(paths.logs, "o.log"), stderr: join(paths.logs, "e.log") },
          scratch,
        },
        { onData: (chunk: string) => void (stdout += chunk) },
      );
      await running.result;
      expect(stdout).not.toContain("TOP-SECRET-VALUE");
      expect(stdout).toContain("ALLOWED virtual ok visible");
      expect(stdout).toContain("DENIED virtual link");
      expect(stdout).toContain("DENIED granted link");
      expect(stdout).toContain("DENIED real link");
      expect(stdout).toContain("DENIED real file");
    },
    SLOW,
  );
});
