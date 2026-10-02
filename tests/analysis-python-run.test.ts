import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelProvider, ProviderEvent, RunEvent, ToolResult } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { AnalysisJobs } from "../packages/core/src/analysis/jobs.ts";
import {
  AnalysisRuntimeManager,
  type PythonResolution,
} from "../packages/core/src/analysis/runtime-manager.ts";
import { createArtifactPublisher } from "../packages/core/src/artifacts/publisher.ts";
import { ArtifactStore } from "../packages/core/src/artifacts/store.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import { registerAnalysisTools } from "../packages/core/src/tools/analysis.ts";

const FAKE_PYTHON = resolve("fixtures/fake-python.mjs");
const fake = (plan: Record<string, unknown>) =>
  `# fake: ${JSON.stringify(plan)}\nprint("unused")\n`;
const fakeRuntime = {
  interpreter: async (): Promise<PythonResolution> => ({
    ok: true,
    executable: process.execPath,
    prefixArgs: [FAKE_PYTHON],
    version: "3.12.0",
    source: "python3",
  }),
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A runner whose first turn calls `python_run` with `args`, then answers "done". */
async function harness(
  args: Record<string, unknown>,
  options: { runtime?: Pick<AnalysisRuntimeManager, "interpreter">; timeoutMs?: number } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "alisio-pyrun-"));
  const workspace = join(root, "ws");
  await mkdir(workspace);
  const store = new SQLiteStore(join(root, "state", "sessions.sqlite"));
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const state = join(root, "state");
  const artifacts = new ArtifactStore({ root: state, db: store.db });
  const jobs = new AnalysisJobs({ root: state, db: store.db });
  const registry = new ToolRegistry();
  registerAnalysisTools(registry, {
    store: artifacts,
    jobs,
    runtime: options.runtime ?? fakeRuntime,
    rootOf: (id) => store.rootOf(id),
    limits: { timeoutMs: options.timeoutMs ?? 120_000, maxLogBytes: 1_000_000 },
    startup: { candidates: true, extras: [] },
  });
  let result: ToolResult | undefined;
  const provider: ModelProvider = {
    id: "fake",
    model: "fake-model",
    async *stream(request): AsyncGenerator<ProviderEvent> {
      const last = request.messages.at(-1);
      if (last?.role === "tool") {
        result = last.result;
        yield { type: "completed", message: { role: "assistant", text: "done", calls: [] } };
        return;
      }
      yield {
        type: "completed",
        message: {
          role: "assistant",
          text: "",
          calls: [{ id: "call-1", name: "python_run", arguments: JSON.stringify(args) }],
        },
      };
    },
  };
  const events: RunEvent[] = [];
  const runner = new AgentRunner({
    provider,
    registry,
    store,
    context: { instructions: async () => "", beforePaths: async () => undefined },
    policy: { write: false, process: false, external: false, analysis: true },
    workspace,
    onEvent: (event) => events.push(event),
    artifacts: (call, announce) =>
      createArtifactPublisher(
        artifacts,
        {
          sessionId: call.sessionId,
          rootSessionId: store.rootOf(call.sessionId),
          workspace,
          runId: call.runId,
          callId: call.callId,
        },
        announce,
      ),
  });
  const session = store.create(workspace, "fake", "fake-model");
  return {
    root,
    state,
    store,
    artifacts,
    session: session.id,
    events,
    run: (signal?: AbortSignal) => runner.run(session.id, "analyze", signal),
    /** The persisted result (with ui parts; the provider only sees the text projection). */
    result: () => (store.callResult(session.id, "call-1") ?? result) as ToolResult,
    text: () =>
      (result?.content ?? [])
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("\n"),
    executions: () =>
      store.db.prepare("SELECT * FROM analysis_executions").all() as Array<Record<string, unknown>>,
  };
}

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, prefix: string) => {
    for (const entry of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(d, entry.name), rel);
      else out.push(rel);
    }
  };
  await walk(dir, "");
  return out.sort();
}

describe("python_run (fake interpreter)", () => {
  it("publishes report.md and chart.svg: two events, two rows, byte-identical, sources kept apart", async () => {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg'/>";
    const h = await harness({
      code: fake({ files: { "report.md": "# R\n", "chart.svg": svg }, stdout: "hello\n" }),
    });
    await h.run();
    const published = h.events.filter((e) => e.type === "artifact_published");
    expect(published).toHaveLength(2);
    for (const event of published) {
      const data = event.data as {
        artifact: { status: string };
        path: string;
        callId: string;
        executionId: string;
      };
      expect(data).toMatchObject({
        callId: "call-1",
        executionId: expect.stringMatching(/^exec_/),
      });
      expect(data.artifact.status).toBe("ready");
      expect(existsSync(data.path)).toBe(true);
    }
    const byName = Object.fromEntries(
      published.map((e) => {
        const d = e.data as { artifact: { fileName: string }; path: string };
        return [d.artifact.fileName, d.path];
      }),
    );
    expect(await readFile(byName["report.md"] as string, "utf8")).toBe("# R\n");
    expect(await readFile(byName["chart.svg"] as string, "utf8")).toBe(svg);
    expect(
      h.store.db.prepare("SELECT count(*) AS n FROM artifacts WHERE status='ready'").get(),
    ).toEqual({ n: 2 });
    const [execution] = h.executions();
    expect(execution).toMatchObject({ status: "completed", exit_code: 0 });
    const jobFiles = await files(join(h.state, String(execution?.rel_dir)));
    expect(jobFiles).toEqual(
      expect.arrayContaining(["job.json", "script/main.py", "logs/stdout.log"]),
    );
    expect(jobFiles).toContain("script/alisio_runtime/__init__.py");
    const artifactFiles = await files(join(h.state, "artifacts"));
    expect(artifactFiles.filter((f) => /\.py$|\.log$|job\.json$/.test(f))).toEqual([]);
    expect(h.text()).toMatch(/^exit 0 in .* · published 2 artifacts: /);
    expect(h.text()).toContain("hello");
    const kinds = h.result().content.flatMap((p) => (p.type === "ui" ? [p.block.kind] : []));
    expect(kinds).toEqual(["terminal", "artifact", "artifact"]);
  });

  it("runs with HOME in work/, no provider keys and MPLBACKEND=Agg", async () => {
    process.env.OPENAI_API_KEY = "sk-must-not-leak";
    try {
      const h = await harness({ code: fake({ env: true }) });
      await h.run();
      const env = JSON.parse(
        h
          .text()
          .split("\n")
          .find((l) => l.startsWith("{")) ?? "{}",
      );
      expect(env.key).toBeNull();
      expect(env.mpl).toBe("Agg");
      // macOS tmpdir() sits behind the /var -> /private/var symlink; the child reports the real path.
      expect(realpathSync(String(env.home))).toBe(realpathSync(String(env.cwd)));
      expect(String(env.cwd)).toMatch(/[\\/]work$/);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("does not publish on a non-zero exit; publishOnError publishes as partial", async () => {
    const h = await harness({ code: fake({ files: { "a.md": "x" }, exit: 3, stderr: "boom" }) });
    await h.run();
    expect(h.events.filter((e) => e.type === "artifact_published")).toHaveLength(0);
    expect(h.result().isError).toBe(true);
    expect(h.text()).toContain("nothing was published");
    expect(h.executions()[0]).toMatchObject({ status: "failed", exit_code: 3 });

    const partial = await harness({
      code: fake({ files: { "a.md": "x" }, exit: 3 }),
      publishOnError: true,
    });
    await partial.run();
    const [event] = partial.events.filter((e) => e.type === "artifact_published");
    expect((event?.data as { artifact: { partial?: boolean } }).artifact.partial).toBe(true);
  });

  it("times out as timed_out and publishes nothing", async () => {
    const h = await harness(
      { code: fake({ files: { "a.md": "x" }, sleepMs: 10_000 }), timeoutMs: 1000 },
      { timeoutMs: 1000 },
    );
    await h.run();
    expect(h.executions()[0]).toMatchObject({ status: "timed_out" });
    expect(h.text()).toContain("timed out");
    expect(h.events.filter((e) => e.type === "artifact_published")).toHaveLength(0);
  }, 15_000);

  it("cancelling the run stops the process within 6 s and records cancelled", async () => {
    const h = await harness({ code: fake({ files: { "a.md": "x" }, sleepMs: 30_000 }) });
    const controller = new AbortController();
    const started = Date.now();
    const running = h.run(controller.signal);
    // Wait until the job exists (the interpreter was launched), then cancel.
    for (let i = 0; i < 200 && !h.executions().length; i++)
      await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 200));
    controller.abort(new Error("Cancelled"));
    await expect(running).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(h.executions()[0]).toMatchObject({ status: "cancelled" });
    expect(h.events.filter((e) => e.type === "artifact_published")).toHaveLength(0);
  }, 15_000);

  // Creating symbolic links needs extra privileges on Windows.
  it.skipIf(process.platform === "win32")(
    "rejects a symbolic link in the outputs and publishes nothing",
    async () => {
      const h = await harness({ code: fake({ files: { "ok.md": "fine" }, sleepMs: 1 }) });
      // Plant a symlink through outputs.json pointing outside (the fake can only write files).
      const outside = join(h.root, "secret.txt");
      await writeFile(outside, "secret");
      const original = h.artifacts.publishOutputs.bind(h.artifacts);
      h.artifacts.publishOutputs = async (staging, owner, defaults) => {
        await symlink(outside, join(staging, "leak.txt"));
        return original(staging, owner, defaults);
      };
      await h.run();
      expect(h.text()).toMatch(/publication rejected .*symbolic links/);
      expect(h.store.db.prepare("SELECT count(*) AS n FROM artifacts").get()).toEqual({ n: 0 });
      expect(h.executions()[0]).toMatchObject({ status: "failed" });
    },
  );

  it("without Python answers runtime_unavailable with install guidance and creates no job", async () => {
    const h = await harness(
      { code: fake({}) },
      {
        runtime: {
          interpreter: async () => ({
            ok: false,
            reason: "No Python interpreter was found on PATH",
          }),
        },
      },
    );
    await h.run();
    expect(h.text()).toMatch(/^runtime_unavailable: /);
    expect(h.text()).toContain("Python 3.10+ was not found on this machine");
    expect(h.result().content.some((p) => p.type === "ui" && p.block.kind === "markdown")).toBe(
      true,
    );
    expect(h.executions()).toEqual([]);
  });
});

const python = ["python3", "python"].find((cmd) => {
  const r = spawnSync(cmd, ["-c", "import sys; print(sys.version_info >= (3, 10))"], {
    encoding: "utf8",
  });
  return r.status === 0 && r.stdout.trim() === "True";
});
describe.skipIf(!python)("python_run with a real Python 3.10+ (skipped when absent)", () => {
  it("discovers Python with no configuration and publishes a report and a chart via alisio_runtime", async () => {
    let h: Awaited<ReturnType<typeof harness>> | undefined;
    const code = [
      "from alisio_runtime import output_dir, svg",
      "out = output_dir()",
      "(out / 'report.md').write_text('# Año 2026\\n', encoding='utf-8')",
      "(out / 'chart.svg').write_text(svg.bar(['a', 'b'], [1, 2], title='T'), encoding='utf-8')",
      "print('ok')",
    ].join("\n");
    const root = await mkdtemp(join(tmpdir(), "alisio-realpy-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const runtime = new AnalysisRuntimeManager({ stateDir: root });
    h = await harness({ code }, { runtime });
    await h.run();
    expect(h.text()).toMatch(/^exit 0 .* published 2 artifacts/);
    const names = h.events
      .filter((e) => e.type === "artifact_published")
      .map((e) => (e.data as { artifact: { fileName: string; kind: string } }).artifact);
    expect(names.map((a) => [a.fileName, a.kind]).sort()).toEqual([
      ["chart.svg", "image"],
      ["report.md", "document"],
    ]);
    expect(existsSync(join(root, "runtimes", "python", "discovery.json"))).toBe(true);
  }, 30_000);

  it("publishes a charts dashboard as one HTML file without chart warnings, and warns about a hand-written pie", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-realpy-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const good = await harness(
      {
        code: [
          "from alisio_runtime import charts",
          "body = charts.grid(charts.card('Status', charts.donut(['A', 'B'], [81.7, 18.3])), charts.card('Sellers', charts.bar(['x', 'y'], {'S': [1, 2], 'P': [2, 1]})))",
          "charts.write('dashboard.html', 'Sales', body)",
        ].join("\n"),
      },
      { runtime: new AnalysisRuntimeManager({ stateDir: root }) },
    );
    await good.run();
    expect(good.text()).toMatch(/^exit 0 .* published 1 artifact: /);
    expect(good.text()).not.toContain("warning:");
    const bad = await harness(
      {
        code: [
          "from alisio_runtime import output_dir",
          "svg = '<svg width=\"400\" height=\"300\">' + ''.join(f'<path d=\"M200,150 L200,50 A100,100 0 0,1 {x},176 Z\"/>' for x in (250, 300)) + '<rect/><rect/></svg>'",
          "(output_dir() / 'dashboard.html').write_text('<body>' + svg + '</body>', encoding='utf-8')",
        ].join("\n"),
      },
      { runtime: new AnalysisRuntimeManager({ stateDir: root }) },
    );
    await bad.run();
    expect(bad.text()).toMatch(/^exit 0 .* published 1 artifact/);
    expect(bad.text()).toContain("warning:");
    expect(bad.text()).toContain("hand-written SVG arc paths");
  }, 60_000);
});
