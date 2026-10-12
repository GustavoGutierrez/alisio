/**
 * `python_run` (effect `process`, capability `analysis.run`), `artifact_create` (effect
 * `internal`) and `artifact_list` (effect `read`). The script runs with the discovered Python in a
 * job folder outside the repository; whatever it leaves in `$ALISIO_OUTPUT_DIR` is published as
 * artifacts. Managed Python is NOT a sandbox.
 */
import { open, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { type ArtifactKind, type ToolContext, type ToolResult, textResult } from "@alisio/sdk";
import type { DatasetService } from "../analysis/data/datasets.ts";
import {
  detectHintHost,
  installHintsMarkdown,
  installHintsText,
  pythonInstallHints,
} from "../analysis/install-hints.ts";
import type { AnalysisJobs } from "../analysis/jobs.ts";
import type { OciRuntime } from "../analysis/oci.ts";
import type { AnalysisRerun, RerunPlan } from "../analysis/rerun.ts";
import {
  type AnalysisRuntimeManager,
  type Extras,
  ExtrasInstallError,
  installPreview,
  type PythonResolution,
  setupCommand,
} from "../analysis/runtime-manager.ts";
import { KIND_LABELS } from "../artifacts/kinds.ts";
import { ArtifactRejected, type ArtifactStore, toRef } from "../artifacts/store.ts";
import type { CoreArtifactPublisher } from "../core/contracts.ts";
import type { ToolRegistry } from "../core/registry.ts";
import { isForgeError, renderHint } from "../forge/errors.ts";
import type { ExecutionKernel } from "../forge/kernel.ts";
import type {
  BackendReadiness,
  PythonBackendId,
  PythonRequirements,
  SupportVerdict,
} from "../forge/python/backend.ts";
import {
  engineIdOf,
  type IsolationPolicy,
  neededBackends,
  type PythonRuntimeSetting,
} from "../forge/python/backend-selector.ts";
import {
  newPythonRunReport,
  PYTHON_PLAN_KEY,
  type PythonRunPlan,
  TERMINAL_BYTES,
} from "../forge/python/engine.ts";
import { stripFrames } from "../forge/python/frame-parser.ts";
import { scanImports } from "../forge/python/import-scan.ts";
import type { PyodideBackendDeps } from "../forge/python/pyodide-backend.ts";
import { createPythonForge } from "../forge/python/wiring.ts";
import type { EngineRegistry } from "../forge/registry.ts";
import { clipText, outputText, pythonHintFor } from "../forge/result.ts";
import { resolveScratchPath } from "../forge/session-dir.ts";
import { safePath } from "../runtime/paths.ts";
import { artifactBlocks, describeArtifact, formatBytes } from "./artifact-blocks.ts";
import { objectSchema } from "./standard.ts";

export const NOT_SANDBOXED =
  "Managed Python is not a sandbox: the script runs with your user permissions and can read your files and use the network.";

export interface AnalysisLimits {
  timeoutMs: number;
  maxLogBytes: number;
}

export interface AnalysisToolDeps {
  /** `analysis.smartDashboard`: the descriptions steer dashboards to `dashboard_generate`. */
  smartDashboard?: boolean;
  store: ArtifactStore;
  jobs: AnalysisJobs;
  /** Discovery (`interpreter`) and, for the optional extras, `hasExtras` / `installExtras`. */
  runtime: Pick<AnalysisRuntimeManager, "interpreter"> &
    Partial<Pick<AnalysisRuntimeManager, "hasExtras" | "installExtras">>;
  /** `analysis.runtime` and the container runtime, read when each call starts. */
  oci?: { mode(): PythonRuntimeSetting; runtime(): OciRuntime };
  /** `analysis.isolation`, read when each call starts (`preferred` when absent). */
  isolation?: () => IsolationPolicy;
  /** The Pyodide backend (`analysis.runtime: "wasm"`, and a candidate of `auto`). */
  wasm?: PyodideBackendDeps;
  /** Rerun of an earlier execution (`rerunOf`). */
  rerun?: AnalysisRerun;
  /**
   * The Forja kernel and engine registry shared with `js_run` (one journal, one state store). When
   * absent the tool builds a private kernel over the jobs' database.
   */
  forge?: { kernel: ExecutionKernel; engines: EngineRegistry };
  /**
   * The verified Forja scratchpad of a session; undefined while there is none (Forja off, or
   * `--read-only`). It enables `codePath` and is exposed to the script read-only.
   */
  scratchpad?: (session: string) => Promise<string | undefined>;
  /** Datasets of the session: `inputs: [{ datasetId }]` copies the dataset's SQLite file. */
  datasets?: DatasetService;
  rootOf: (sessionId: string) => string;
  limits: AnalysisLimits;
  /** Startup facts for the description (stat only; no process was launched). */
  startup: { candidates: boolean; extras: string[] };
  /** Whether `forge_guide` exists now; error results then point at `python.environment` (spec §8.4). */
  guideHints?: () => boolean;
}

const TEXT_TAIL = 4 * 1024;
const MAX_CODE = 200_000;
const MAX_TEXT = 5 * 1024 * 1024;
const KINDS: ArtifactKind[] = [
  "dashboard",
  "document",
  "spreadsheet",
  "image",
  "data",
  "code",
  "archive",
  "file",
];

const tail = (text: string, bytes: number) => {
  const buffer = Buffer.from(text);
  return buffer.byteLength <= bytes
    ? text
    : buffer
        .subarray(buffer.byteLength - bytes)
        .toString("utf8")
        .replace(/^�+/, "");
};

async function readTail(path: string, bytes: number): Promise<string> {
  try {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer.toString("utf8").replace(/^�+/, "");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

function publisherOf(context: ToolContext): CoreArtifactPublisher {
  const publisher = context.artifacts as CoreArtifactPublisher | undefined;
  if (!publisher || typeof publisher.publishOutputs !== "function")
    throw new Error("Artifacts are not available here (no artifact store for this session)");
  return publisher;
}

const WASM_NOTE =
  "This run happens in a restricted WebAssembly process (Pyodide in Node with the Permission Model): no host files outside the job, no child processes; the network is NOT blocked and memory is a soft limit. Only the downloaded profile's packages exist.";

const CONTAINER_NOTE =
  "This run happens in a container (Docker or Podman) with no network access, a read-only root and only the job folders mounted; it is isolation with limits, not a hardened sandbox.";

function pythonRunDescription(deps: AnalysisToolDeps): string {
  const setting = deps.oci?.mode() ?? "managed";
  const container = setting === "oci";
  const modules = container
    ? "whatever the configured container image provides (and alisio_runtime)"
    : setting === "wasm"
      ? "the standard library, alisio_runtime and the downloaded Pyodide profile (analysis: pandas, numpy, matplotlib, openpyxl, python-docx, reportlab, plotly, jinja2; science adds scipy, statsmodels, scikit-learn); other packages are not available"
      : deps.startup.extras.length
        ? `the standard library, alisio_runtime and the "${deps.startup.extras.join(", ")}" extras (pandas, numpy, matplotlib…)`
        : 'the Python standard library and alisio_runtime only (no pandas or numpy; use csv, statistics, sqlite3). Pass extras: ["analysis"] to use pandas, numpy, matplotlib, openpyxl, python-docx, reportlab, plotly and jinja2: if they are not installed the user is asked once to approve a download, and without approval the call fails';
  return [
    ...(deps.smartDashboard
      ? [
          "To build a dashboard from a dataset, prefer dashboard_generate (no code). Use python_run for analysis or visuals the dashboard catalog does not cover (statistical tests, custom or unsupported charts, joins, exports).",
        ]
      : []),
    "Write and run a Python 3.10+ script in a job folder managed by Alisio, outside the repository.",
    "Every file the script writes to $ALISIO_OUTPUT_DIR is published as a downloadable artifact",
    "(HTML dashboard, Markdown, PDF, DOCX, XLSX, CSV, PNG/SVG, JSON, ZIP or any other file); a",
    "top-level folder with index.html becomes one multi-file dashboard. Optionally write",
    '$ALISIO_OUTPUT_DIR/outputs.json = {"artifacts":[{"path":"…","title":"…"}]} to publish only',
    "those. The cwd is $ALISIO_WORK_DIR (scratch); inputs are copied to $ALISIO_INPUT_DIR.",
    `Available modules: ${modules}. alisio_runtime offers output_dir(), html.page/table/write,`,
    ...(deps.smartDashboard
      ? [
          "charts.* (Chart.js cards: charts.card/grid/kpis/write) and svg.* are for custom visuals beyond dashboard_generate's catalog; never hand-write SVG or load a CDN.",
        ]
      : [
          "charts (Chart.js bundled; pie/donut/bar/hbar/line/area/scatter(labels, values or {name: values}, title,",
          "fmt='currency:USD', locale) in charts.card/grid/kpis, then charts.write(name, title, body): responsive, with",
          "a data table) and svg.* (static, no script). For charts ALWAYS use them: never hand-write SVG arcs or fixed-size",
          "SVGs, never load a CDN; one chart per card; pie only for 2-5 parts, else donut or hbar.",
        ]),
    "inputs: [{ datasetId }] copies a dataset (see",
    "data_inspect) to $ALISIO_INPUT_DIR/<name>.sqlite: alisio_runtime.datasets.open(name) returns a",
    "read-only sqlite3 connection (table `data` or `s_<sheet>`). HTML is shown offline: embed data and scripts",
    "inline (no fetch, no CDN). Nothing is published when the script fails unless publishOnError.",
    "Keep each call's code short: the model's output is capped per response, so split large scripts or dashboards into several calls or files.",
    "To run an earlier analysis again unchanged (same script, inputs checked by hash, new artifacts) pass rerunOf: an artifact or execution id of this session, instead of code.",
    container ? CONTAINER_NOTE : setting === "wasm" ? WASM_NOTE : NOT_SANDBOXED,
    ...(deps.startup.candidates || container || setting === "wasm"
      ? []
      : ["Python was not found at startup: the tool answers with install instructions."]),
  ].join(" ");
}

/** PD11: the last line of the text names the engine, the isolation and why it was chosen. */
const withEngineLine = (text: string, line: string): string =>
  `${text}${text.endsWith("\n") ? "" : "\n"}${line}`;

const failure = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

export function registerAnalysisTools(registry: ToolRegistry, deps: AnalysisToolDeps): void {
  const python = createPythonForge({
    jobs: deps.jobs,
    runtime: deps.runtime,
    ...(deps.oci ? { oci: deps.oci } : {}),
    ...(deps.wasm ? { wasm: deps.wasm } : {}),
    ...(deps.forge ? { shared: deps.forge } : {}),
  });

  /** The pointer line to `python.environment`, only while the guide tool exists. */
  const guideLine = (code: "PACKAGE_UNAVAILABLE" | "RUNTIME_UNAVAILABLE"): string =>
    deps.guideHints?.() ? `\nhint: ${renderHint(pythonHintFor(code))}` : "";

  async function unavailable(
    runtime: PythonRuntimeSetting,
    state: BackendReadiness | undefined,
    fallback: string,
    host: BackendReadiness | undefined,
  ): Promise<ToolResult> {
    const result = await unavailableText(runtime, state, fallback, host);
    const line = guideLine(
      /wasm profiles|profile/.test(fallback) ? "PACKAGE_UNAVAILABLE" : "RUNTIME_UNAVAILABLE",
    );
    const first = result.content[0];
    if (line && first?.type === "text") first.text += line;
    return result;
  }

  /** The text `python_run` has always answered when the chosen runtime cannot run. */
  async function unavailableText(
    runtime: PythonRuntimeSetting,
    state: BackendReadiness | undefined,
    fallback: string,
    host: BackendReadiness | undefined,
  ): Promise<ToolResult> {
    if (runtime === "auto" || runtime === "wasm") {
      // The chain's own message lists every backend; the host's install hints ride along when the
      // host was a candidate that failed for lack of Python.
      const hostDown = runtime === "auto" && host && !host.ready ? host : undefined;
      if (!hostDown) return failure(`runtime_unavailable: ${fallback}`);
      const found = (hostDown.detail as Extract<PythonResolution, { ok: false }> | undefined)
        ?.found;
      const hints = pythonInstallHints(await detectHintHost(found));
      return {
        content: [
          { type: "text", text: `runtime_unavailable: ${fallback}\n${installHintsText(hints)}` },
          { type: "ui", block: { kind: "markdown", text: installHintsMarkdown(hints) } },
        ],
        isError: true,
      };
    }
    if (!state || state.ready) return failure(`runtime_unavailable: ${fallback}`);
    if (runtime === "oci") return failure(`runtime_unavailable: ${state.reason}`);
    const found = (state.detail as Extract<PythonResolution, { ok: false }> | undefined)?.found;
    const hints = pythonInstallHints(await detectHintHost(found));
    return {
      content: [
        { type: "text", text: `runtime_unavailable: ${state.reason}.\n${installHintsText(hints)}` },
        { type: "ui", block: { kind: "markdown", text: installHintsMarkdown(hints) } },
      ],
      isError: true,
    };
  }

  /** The Pyodide start margin added to a run's deadline (0 without the backend). */
  const wasmStartupMs = (): number => deps.wasm?.settings().startupMs ?? 0;

  /** Bytes of the inputs a call declares, best effort: a bad input fails later with its own error. */
  async function inputBytesOf(
    declared: unknown,
    rerun: RerunPlan | undefined,
    context: ToolContext,
    root: string,
  ): Promise<number> {
    if (rerun) return rerun.inputs.reduce((sum, item) => sum + item.bytes, 0);
    let total = 0;
    for (const item of (declared as Array<{ path?: string; datasetId?: string }> | undefined) ??
      []) {
      try {
        const file =
          item.datasetId !== undefined
            ? deps.datasets?.file(deps.datasets.getFor(item.datasetId, root))
            : item.path !== undefined
              ? await (context.resolvePath
                  ? context.resolvePath(item.path)
                  : safePath(context.workspace, item.path))
              : undefined;
        if (file) total += (await stat(file)).size;
      } catch {
        /* the real preparation reports it */
      }
    }
    return total;
  }

  /** The scratchpad to expose to the script (read-only), when it exists. */
  async function exposedScratchpad(session: string): Promise<string | undefined> {
    const pad = await deps.scratchpad?.(session).catch(() => undefined);
    if (!pad) return undefined;
    return (await stat(pad).catch(() => undefined))?.isDirectory() ? pad : undefined;
  }

  /** `codePath`: the text of a `.py` file inside the session scratchpad (Python spec §5). */
  async function codeFromScratchpad(codePath: unknown, session: string): Promise<string> {
    if (typeof codePath !== "string" || codePath === "")
      throw new Error("`codePath` must be a non-empty string");
    const pad = deps.scratchpad ? await deps.scratchpad(session).catch(() => undefined) : undefined;
    if (!pad) throw new Error("`codePath` needs the session scratchpad, which is not available");
    const path = await resolveScratchPath(pad, codePath);
    if (extname(path) !== ".py")
      throw new Error("`codePath` must be a .py file inside the scratchpad");
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`\`codePath\` does not name a file: ${codePath}`);
    const text = await readFile(path, "utf8");
    if (text.length > MAX_CODE)
      throw new Error(`\`codePath\` file is longer than ${MAX_CODE} characters`);
    if (text.trim() === "") throw new Error("`codePath` file is empty");
    return text;
  }

  /**
   * The optional extras (pandas…): when they are not installed, installing them needs an
   * `analysis.install` approval (once, with the packages, the size and the network need). Where no
   * one can be asked, or the answer is no, or the download fails, nothing is installed and the
   * result names the optional command. Returns a failure result, or undefined when ready.
   */
  async function ensureExtras(
    extras: Extras,
    context: ToolContext,
  ): Promise<ToolResult | undefined> {
    const remedy = `To install them yourself (optional): ${setupCommand(extras)}. Until then, use the standard library.`;
    if (!deps.runtime.hasExtras || !deps.runtime.installExtras)
      return failure(
        `extras_unavailable: the "${extras}" extras cannot be installed here. ${remedy}`,
      );
    if (await deps.runtime.hasExtras(extras)) return undefined;
    const verdict = context.approveInstall
      ? await context.approveInstall(installPreview(extras))
      : "deny";
    if (verdict !== "once")
      return failure(
        `extras_not_installed: the "${extras}" extras (pandas, numpy…) are not installed, and installing them needs the user's approval and network access: it was denied, or nobody could be asked (headless runs never install; no flag allows it). ${remedy}`,
      );
    try {
      await deps.runtime.installExtras(extras, {
        signal: context.signal,
        onOutput: context.emit,
      });
    } catch (error) {
      if (context.signal.aborted) throw error;
      if (error instanceof ExtrasInstallError)
        return failure(`extras_install_failed: ${error.message}`);
      return failure(
        `extras_install_failed: ${error instanceof Error ? error.message : String(error)}. ${remedy}`,
      );
    }
    return undefined;
  }

  registry.register({
    name: "python_run",
    effect: "process",
    capability: "analysis.run",
    description: pythonRunDescription(deps),
    inputSchema: objectSchema(
      {
        code: { type: "string", minLength: 1, maxLength: MAX_CODE },
        title: { type: "string", maxLength: 200 },
        inputs: {
          type: "array",
          maxItems: 20,
          items: objectSchema({
            path: { type: "string", minLength: 1 },
            datasetId: { type: "string", minLength: 1, maxLength: 64 },
          }),
        },
        timeoutMs: { type: "integer", minimum: 1000, maximum: deps.limits.timeoutMs },
        publishOnError: { type: "boolean" },
        extras: {
          type: "array",
          maxItems: 2,
          items: { type: "string", enum: ["analysis", "science"] },
        },
        rerunOf: { type: "string", minLength: 5, maxLength: 64 },
        codePath: {
          type: "string",
          maxLength: 1024,
          description:
            "A .py file inside the session scratchpad to run instead of code (edit it with the file tools between runs). The scratchpad is readable from the script as $ALISIO_SCRATCH_DIR and never writable. Only where the scratchpad exists.",
        },
      },
      [],
    ),
    async execute(input, context): Promise<ToolResult> {
      const publisher = publisherOf(context);
      const sessionId = context.session ?? "headless";
      const root = deps.rootOf(sessionId);
      const rerunRef = typeof input.rerunOf === "string" ? input.rerunOf.trim() : undefined;
      const hasPath = input.codePath !== undefined;
      if (rerunRef && input.code !== undefined)
        throw new Error("Pass either code or rerunOf, not both");
      if (hasPath && (rerunRef || input.code !== undefined))
        throw new Error("Pass only one of code, codePath or rerunOf");
      if (!rerunRef && !hasPath && typeof input.code !== "string")
        throw new Error("python_run needs code (or rerunOf to run an earlier analysis again)");
      const source = hasPath ? await codeFromScratchpad(input.codePath, sessionId) : undefined;
      // Rerun: the saved script and inputs, verified by hash; a mismatch runs nothing.
      let rerun: RerunPlan | undefined;
      if (rerunRef) {
        if (!deps.rerun) throw new Error("Rerun is not available here");
        const prepared = await deps.rerun.prepare(rerunRef, root);
        if (!prepared.ok)
          return failure(
            `rerun refused; nothing was executed:\n${prepared.problems.map((p) => `- ${p}`).join("\n")}`,
          );
        rerun = prepared.plan;
      }
      const code = rerun ? rerun.code : (source ?? String(input.code));
      await python.ready();

      // select (Python spec §6): the configured runtime under the isolation policy, from facts
      // gathered once. Nothing is probed after this point, and nothing falls back after a start.
      const runtimeSetting: PythonRuntimeSetting = deps.oci ? deps.oci.mode() : "managed";
      const isolation: IsolationPolicy = deps.isolation?.() ?? "preferred";
      const rerunOfBackend: PythonBackendId | undefined = rerun?.runtime;
      const extrasAsked = [
        ...new Set<string>([
          ...((input.extras as string[] | undefined) ?? []),
          ...(rerun?.extras ?? []),
        ]),
      ];
      const probe = neededBackends({
        runtime: runtimeSetting,
        isolation,
        ...(rerunOfBackend ? { rerunOfBackend } : {}),
      });
      const readiness: Partial<Record<PythonBackendId, BackendReadiness>> = {};
      await Promise.all(
        probe.map(async (id) => {
          const backend = python.backends[id];
          readiness[id] = backend
            ? await backend.check(context.signal)
            : { ready: false, reason: `${id} is not available here` };
        }),
      );
      const requirements: PythonRequirements = {
        extras: extrasAsked.filter((e): e is "analysis" | "science" =>
          ["analysis", "science"].includes(e),
        ),
        importedModules: scanImports(code),
        inputBytes: probe.includes("wasm")
          ? await inputBytesOf(input.inputs, rerun, context, root)
          : 0,
        ...(rerunOfBackend ? { rerunOfBackend } : {}),
      };
      const support: Partial<Record<PythonBackendId, SupportVerdict>> = {};
      const networkDenied: Partial<Record<PythonBackendId, boolean>> = {};
      for (const id of probe) {
        const backend = python.backends[id];
        if (!backend || !readiness[id]?.ready) continue;
        support[id] = backend.supports(requirements);
        if (isolation === "strict")
          networkDenied[id] = (await backend.describe()).capabilities.networkDeniedByOS;
      }
      let selection: { engine: PythonBackendId; reason: string };
      try {
        selection = python.selector.select({
          runtime: runtimeSetting,
          isolation,
          ...(rerunOfBackend ? { rerunOfBackend } : {}),
          readiness,
          support,
          networkDenied,
        });
      } catch (error) {
        if (!isForgeError(error)) throw error;
        return unavailable(
          runtimeSetting,
          runtimeSetting === "auto" ? undefined : readiness[runtimeSetting],
          error.message,
          readiness.managed,
        );
      }
      const managed = python.backends.managed;
      if (selection.engine === "managed" && managed) {
        const wanted = new Set<string>([
          ...((input.extras as string[] | undefined) ?? []),
          ...(rerun?.extras ?? []),
        ]);
        if (wanted.size) {
          const need = wanted.has("science") ? "science" : "analysis";
          const outcome = await ensureExtras(need, context);
          if (outcome) return outcome;
          const again = await managed.check(context.signal);
          if (!again.ready) return failure(`runtime_unavailable: ${again.reason}`);
        }
      }
      const timeoutMs = Math.min(
        Number(input.timeoutMs ?? deps.limits.timeoutMs),
        deps.limits.timeoutMs,
      );
      const pad = await exposedScratchpad(sessionId);
      const engineId = engineIdOf(selection.engine);
      const report = newPythonRunReport();
      const plan: PythonRunPlan = {
        code,
        ...(rerun ? { rerun } : {}),
        inputs: (input.inputs as Array<{ path?: string; datasetId?: string }> | undefined) ?? [],
        extrasAsked,
        resolvePath: (path) =>
          context.resolvePath ? context.resolvePath(path) : safePath(context.workspace, path),
        ...(deps.datasets ? { datasets: deps.datasets } : {}),
        rootSessionId: root,
        sessionId,
        workspace: context.workspace,
        ...(context.runId ? { runId: context.runId } : {}),
        ...(context.callId ? { callId: context.callId } : {}),
        publisher,
        ...(typeof input.title === "string" && input.title.trim()
          ? { title: input.title.trim() }
          : {}),
        publishOnError: input.publishOnError === true,
        onText: (text) => context.emit(text),
        ...(pad ? { scratch: pad } : {}),
        maxLogBytes: deps.limits.maxLogBytes,
        engine: {
          id: engineId,
          isolation: python.engines.descriptors()[engineId]?.isolation ?? "none",
          selectionReason: selection.reason,
        },
        report,
      };
      const { result } = await python.kernel.execute({
        source: code,
        language: "python",
        selection: { engine: engineId, reason: selection.reason },
        // Pyodide's start is a margin on top of the run's own deadline, not part of it (PD13).
        limitOverrides: {
          timeoutMs: timeoutMs + (selection.engine === "wasm" ? wasmStartupMs() : 0),
          maxSourceBytes: MAX_CODE * 4,
        },
        payload: { [PYTHON_PLAN_KEY]: plan },
        call: {
          toolCallId: context.callId ?? "python_run",
          session: sessionId,
          rootSessionId: root,
          workspace: context.workspace,
          signal: context.signal,
          // Python has no nested calls; these only describe the caller (the call passed the
          // analysis.run gate, and its effect is `process`).
          permissionMode: "ask",
          allowAnalysis: true,
          allowProcess: true,
          emit: (progress) => context.emit(progress),
          ...(pad ? { tasksDir: join(dirname(pad), "tasks") } : {}),
        },
      });

      // The tool's errors keep their shape: a failed preparation is the original error, a cancelled
      // call ends by throwing, a crash of the launch rethrows.
      if (report.prepareError) throw report.prepareError;
      const job = report.job;
      if (!job)
        return failure(
          `${result.error?.code ?? "ISOLATE_FAILURE"}: ${result.error?.message ?? "the script did not start"}`,
        );
      if (result.status === "cancelled") {
        deps.jobs.finish(job.id, "cancelled");
        context.signal.throwIfAborted();
        throw new Error("python_run was cancelled");
      }
      if (report.crash) {
        deps.jobs.finish(job.id, "failed", {
          error: report.crash instanceof Error ? report.crash.message : String(report.crash),
        });
        throw report.crash;
      }
      const nonce = report.nonce ?? "";
      const logs = { stdout: join(job.logs, "stdout.log"), stderr: join(job.logs, "stderr.log") };
      const engineLine = `engine: ${result.engine} (${result.isolation}) · reason: ${result.selectionReason}`;
      if (result.status === "timed_out") {
        deps.jobs.finish(job.id, "timed_out", { error: result.error?.message ?? "timed out" });
        const stdoutTail = stripFrames(await readTail(logs.stdout, TEXT_TAIL), nonce);
        const output = `${stdoutTail}${await readTail(logs.stderr, TEXT_TAIL)}`;
        return {
          content: [
            {
              type: "text",
              text: withEngineLine(
                `timed out after ${Math.round(timeoutMs / 1000)}s; nothing was published (${job.id})${output ? `\n--- output (last 4 KB) ---\n${tail(output, TEXT_TAIL)}` : ""}`,
                engineLine,
              ),
            },
            {
              type: "ui",
              block: {
                kind: "terminal",
                command: "python main.py",
                output,
                durationMs: report.durationMs ?? timeoutMs,
                truncated: true,
              },
            },
          ],
          isError: true,
        };
      }
      const durationMs = report.durationMs ?? 0;
      const proc = report.process;
      const published = report.published;
      const publishError = report.publishError;
      const failed = result.status !== "succeeded";
      // Anything else that stopped the run (a protocol violation, a refused state write...).
      const forgeError =
        result.error && !["SCRIPT_RUNTIME", "PUBLICATION_REJECTED"].includes(result.error.code)
          ? result.error
          : undefined;
      deps.jobs.finish(job.id, failed ? "failed" : "completed", {
        ...(proc ? { exitCode: proc.exitCode } : {}),
        ...(publishError
          ? { error: `publish: ${publishError}` }
          : forgeError
            ? { error: `${forgeError.code}: ${forgeError.message}` }
            : {}),
      });
      const stdout =
        proc?.stdout ?? stripFrames(await readTail(logs.stdout, TERMINAL_BYTES), nonce);
      const stderr = proc?.stderr ?? (await readTail(logs.stderr, TERMINAL_BYTES));
      const warnings = [...published.flatMap((p) => p.warnings), ...report.warnings];
      const seconds = (durationMs / 1000).toFixed(1);
      const head = [
        `${rerun ? `rerun of ${rerun.executionId} · ` : ""}${proc ? `exit ${proc.exitCode}` : "stopped"} in ${seconds}s${typeof report.runtime?.startupMs === "number" ? ` (startup ${(report.runtime.startupMs / 1000).toFixed(1)}s)` : ""}`,
        publishError
          ? `publication rejected (nothing was published): ${publishError}`
          : failed && input.publishOnError !== true
            ? "nothing was published (non-zero exit; pass publishOnError to keep partial outputs)"
            : `published ${published.length} artifact${published.length === 1 ? "" : "s"}${published.length ? `: ${published.map(describeArtifact).join(", ")}` : ""}`,
      ].join(" · ");
      const forgeOutput = outputText(result.output);
      const forgeValue = result.value !== undefined ? JSON.stringify(result.value) : undefined;
      const sections = [
        head,
        ...(forgeError ? [`error: ${forgeError.code}: ${forgeError.message}`] : []),
        ...warnings.map((w) => `warning: ${w}`),
        ...(stdout.trim() ? [`--- stdout (last 4 KB) ---\n${tail(stdout, TEXT_TAIL)}`] : []),
        ...(stderr.trim() ? [`--- stderr (last 4 KB) ---\n${tail(stderr, TEXT_TAIL)}`] : []),
        ...(forgeOutput || forgeValue !== undefined
          ? [
              `--- forge output ---\n${
                clipText(
                  [forgeOutput, ...(forgeValue !== undefined ? [`value: ${forgeValue}`] : [])]
                    .filter(Boolean)
                    .join("\n"),
                  16_000,
                ).text
              }`,
            ]
          : []),
      ];
      // A script that failed on an import: point at the packages this backend really has.
      const missingModule =
        failed && /ModuleNotFoundError|ImportError: No module named/.test(stderr)
          ? guideLine("PACKAGE_UNAVAILABLE").trim()
          : "";
      if (missingModule) sections.push(missingModule);
      const separator = stdout && stderr && !stdout.endsWith("\n") ? "\n" : "";
      return {
        content: [
          { type: "text", text: withEngineLine(sections.join("\n"), engineLine) },
          {
            type: "ui",
            block: {
              kind: "terminal",
              command: "python main.py",
              output: tail(`${stdout}${separator}${stderr}`, TERMINAL_BYTES),
              ...(proc ? { exitCode: proc.exitCode } : {}),
              durationMs,
              ...(proc?.truncated ? { truncated: true } : {}),
            },
          },
          ...artifactBlocks(published),
        ],
        ...(failed ? { isError: true } : {}),
      };
    },
  });

  registry.register({
    name: "artifact_create",
    effect: "internal",
    description:
      "Publish text you already have (Markdown, HTML, CSV, JSON, SVG, plain text…) as a " +
      "downloadable artifact of this session; works without Python. fileName decides the type " +
      `(e.g. report.md, dashboard.html).${deps.smartDashboard ? " For a data dashboard use dashboard_generate instead of writing the HTML." : ""} HTML is shown offline: inline every script and style.`,
    inputSchema: objectSchema(
      {
        fileName: { type: "string", minLength: 1, maxLength: 200 },
        title: { type: "string", maxLength: 200 },
        text: { type: "string", maxLength: MAX_TEXT },
      },
      ["fileName", "text"],
    ),
    async execute(input, context) {
      const publisher = publisherOf(context);
      const fileName = String(input.fileName);
      if (basename(fileName.replace(/\\/g, "/")) !== fileName)
        throw new Error("fileName must be a plain file name without folders");
      try {
        const published = await publisher.publishTextDetailed({
          fileName,
          text: String(input.text),
          ...(typeof input.title === "string" && input.title.trim()
            ? { title: input.title.trim() }
            : {}),
        });
        return {
          content: [
            { type: "text", text: `published ${describeArtifact(published)}` },
            ...artifactBlocks([published]),
          ],
        };
      } catch (error) {
        if (error instanceof ArtifactRejected)
          throw new Error(`Publication rejected: ${error.message}`);
        throw error;
      }
    },
  });

  registry.register({
    name: "artifact_list",
    effect: "read",
    description: "List the downloadable artifacts of this session, newest first.",
    inputSchema: objectSchema({
      kind: { type: "string", enum: KINDS },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    }),
    async execute(input, context) {
      const root = deps.rootOf(context.session ?? "");
      const records = deps.store.list(root, {
        ...(typeof input.kind === "string" ? { kind: input.kind as ArtifactKind } : {}),
        limit: Number(input.limit ?? 50),
      });
      if (!records.length) return textResult("No artifacts in this session yet.");
      return textResult(
        records
          .map((r) => {
            const ref = toRef(r);
            return `${ref.id} · ${KIND_LABELS[ref.kind]} · ${ref.fileName} · ${formatBytes(ref.bytes)}${ref.partial ? " · partial" : ""} · ${new Date(ref.createdAt).toISOString()}${ref.title !== ref.fileName ? ` · "${ref.title}"` : ""}`;
          })
          .join("\n"),
      );
    },
  });
}
