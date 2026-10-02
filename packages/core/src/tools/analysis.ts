/**
 * `python_run` (effect `process`, capability `analysis.run`), `artifact_create` (effect
 * `internal`) and `artifact_list` (effect `read`). The script runs with the discovered Python in a
 * job folder outside the repository; whatever it leaves in `$ALISIO_OUTPUT_DIR` is published as
 * artifacts. Managed Python is NOT a sandbox.
 */
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type ArtifactKind,
  type ToolContext,
  type ToolResult,
  textResult,
  type UiBlock,
} from "@alisio/sdk";
import type { DatasetService } from "../analysis/data/datasets.ts";
import {
  detectHintHost,
  installHintsMarkdown,
  installHintsText,
  pythonInstallHints,
} from "../analysis/install-hints.ts";
import type { AnalysisJobs, JobInput } from "../analysis/jobs.ts";
import type { OciRuntime } from "../analysis/oci.ts";
import type { AnalysisRerun, RerunPlan } from "../analysis/rerun.ts";
import {
  type AnalysisRuntimeManager,
  type Extras,
  ExtrasInstallError,
  installPreview,
  setupCommand,
} from "../analysis/runtime-manager.ts";
import { KIND_LABELS } from "../artifacts/kinds.ts";
import { ArtifactRejected, type ArtifactStore, toRef } from "../artifacts/store.ts";
import type { CoreArtifactPublisher, PublishedArtifactInfo } from "../core/contracts.ts";
import type { ToolRegistry } from "../core/registry.ts";
import { safePath } from "../runtime/paths.ts";
import { runProcess } from "../runtime/process.ts";
import { objectSchema } from "./standard.ts";

export const NOT_SANDBOXED =
  "Managed Python is not a sandbox: the script runs with your user permissions and can read your files and use the network.";

export interface AnalysisLimits {
  timeoutMs: number;
  maxLogBytes: number;
}

export interface AnalysisToolDeps {
  store: ArtifactStore;
  jobs: AnalysisJobs;
  /** Discovery (`interpreter`) and, for the optional extras, `hasExtras` / `installExtras`. */
  runtime: Pick<AnalysisRuntimeManager, "interpreter"> &
    Partial<Pick<AnalysisRuntimeManager, "hasExtras" | "installExtras">>;
  /** Container mode (`analysis.runtime: "oci"`), read when each call starts. */
  oci?: { mode(): "managed" | "oci"; runtime(): OciRuntime };
  /** Rerun of an earlier execution (`rerunOf`). */
  rerun?: AnalysisRerun;
  /** Datasets of the session: `inputs: [{ datasetId }]` copies the dataset's SQLite file. */
  datasets?: DatasetService;
  rootOf: (sessionId: string) => string;
  limits: AnalysisLimits;
  /** Startup facts for the description (stat only; no process was launched). */
  startup: { candidates: boolean; extras: string[] };
}

const TERMINAL_BYTES = 256 * 1024;
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

/** `48 KB`, `1.2 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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

const describeArtifact = (p: PublishedArtifactInfo) =>
  `${p.artifact.fileName} (${p.artifact.kind}, ${formatBytes(p.artifact.bytes)}, ${p.artifact.id})`;

const artifactBlocks = (published: PublishedArtifactInfo[]) =>
  published.map((p) => ({
    type: "ui" as const,
    block: { kind: "artifact", artifact: p.artifact } as UiBlock,
  }));

function publisherOf(context: ToolContext): CoreArtifactPublisher {
  const publisher = context.artifacts as CoreArtifactPublisher | undefined;
  if (!publisher || typeof publisher.publishOutputs !== "function")
    throw new Error("Artifacts are not available here (no artifact store for this session)");
  return publisher;
}

/** Environment of the script: the usual whitelist, HOME/TMP inside work/, and the job paths. */
function scriptEnv(job: {
  input: string;
  staging: string;
  work: string;
  id: string;
}): Record<string, string> {
  const keep = [
    "PATH",
    "LANG",
    "LC_ALL",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    "SYSTEMDRIVE",
    "WINDIR",
  ];
  return {
    ...Object.fromEntries(
      keep.flatMap((k) => (process.env[k] ? [[k, process.env[k] as string]] : [])),
    ),
    HOME: job.work,
    USERPROFILE: job.work,
    TMPDIR: job.work,
    TEMP: job.work,
    TMP: job.work,
    ALISIO_INPUT_DIR: job.input,
    ALISIO_OUTPUT_DIR: job.staging,
    ALISIO_WORK_DIR: job.work,
    ALISIO_EXECUTION_ID: job.id,
    MPLBACKEND: "Agg",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUNBUFFERED: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

const CONTAINER_NOTE =
  "This run happens in a container (Docker or Podman) with no network access, a read-only root and only the job folders mounted; it is isolation with limits, not a hardened sandbox.";

function pythonRunDescription(deps: AnalysisToolDeps): string {
  const container = deps.oci?.mode() === "oci";
  const modules = container
    ? "whatever the configured container image provides (and alisio_runtime)"
    : deps.startup.extras.length
      ? `the standard library, alisio_runtime and the "${deps.startup.extras.join(", ")}" extras (pandas, numpy, matplotlib…)`
      : 'the Python standard library and alisio_runtime only (no pandas or numpy; use csv, statistics, sqlite3). Pass extras: ["analysis"] to use pandas, numpy, matplotlib, openpyxl, python-docx, reportlab, plotly and jinja2: if they are not installed the user is asked once to approve a download, and without approval the call fails';
  return [
    "Write and run a Python 3.10+ script in a job folder managed by Alisio, outside the repository.",
    "Every file the script writes to $ALISIO_OUTPUT_DIR is published as a downloadable artifact",
    "(HTML dashboard, Markdown, PDF, DOCX, XLSX, CSV, PNG/SVG, JSON, ZIP or any other file); a",
    "top-level folder with index.html becomes one multi-file dashboard. Optionally write",
    '$ALISIO_OUTPUT_DIR/outputs.json = {"artifacts":[{"path":"…","title":"…"}]} to publish only',
    "those. The cwd is $ALISIO_WORK_DIR (scratch); inputs are copied to $ALISIO_INPUT_DIR.",
    `Available modules: ${modules}. alisio_runtime offers output_dir(), html.page/table/write,`,
    "charts (Chart.js bundled; pie/donut/bar/hbar/line/area/scatter(labels, values or {name: values}, title,",
    "fmt='currency:USD', locale) in charts.card/grid/kpis, then charts.write(name, title, body): responsive, with",
    "a data table) and svg.* (static, no script). For charts ALWAYS use them: never hand-write SVG arcs or fixed-size",
    "SVGs, never load a CDN; one chart per card; pie only for 2-5 parts, else donut or hbar. inputs: [{ datasetId }] copies a dataset (see",
    "data_inspect) to $ALISIO_INPUT_DIR/<name>.sqlite: alisio_runtime.datasets.open(name) returns a",
    "read-only sqlite3 connection (table `data` or `s_<sheet>`). HTML is shown offline: embed data and scripts",
    "inline (no fetch, no CDN). Nothing is published when the script fails unless publishOnError.",
    "Keep each call's code short: the model's output is capped per response, so split large scripts or dashboards into several calls or files.",
    "To run an earlier analysis again unchanged (same script, inputs checked by hash, new artifacts) pass rerunOf: an artifact or execution id of this session, instead of code.",
    container ? CONTAINER_NOTE : NOT_SANDBOXED,
    ...(deps.startup.candidates || container
      ? []
      : ["Python was not found at startup: the tool answers with install instructions."]),
  ].join(" ");
}

const failure = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

export function registerAnalysisTools(registry: ToolRegistry, deps: AnalysisToolDeps): void {
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
      },
      [],
    ),
    async execute(input, context): Promise<ToolResult> {
      const publisher = publisherOf(context);
      const sessionId = context.session ?? "headless";
      const root = deps.rootOf(sessionId);
      const rerunRef = typeof input.rerunOf === "string" ? input.rerunOf.trim() : undefined;
      if (rerunRef && input.code !== undefined)
        throw new Error("Pass either code or rerunOf, not both");
      if (!rerunRef && typeof input.code !== "string")
        throw new Error("python_run needs code (or rerunOf to run an earlier analysis again)");
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
      const code = rerun ? rerun.code : String(input.code);
      const container = deps.oci?.mode() === "oci" ? deps.oci.runtime() : undefined;
      // Container mode needs neither host Python nor extras (the image carries them).
      let runtime: Awaited<ReturnType<AnalysisToolDeps["runtime"]["interpreter"]>> | undefined;
      if (container) {
        const unavailable = await container.unavailable(context.signal);
        if (unavailable) return failure(`runtime_unavailable: ${unavailable}`);
      } else {
        runtime = await deps.runtime.interpreter(context.signal);
        if (!runtime.ok) {
          const hints = pythonInstallHints(await detectHintHost(runtime.found));
          return {
            content: [
              {
                type: "text",
                text: `runtime_unavailable: ${runtime.reason}.\n${installHintsText(hints)}`,
              },
              { type: "ui", block: { kind: "markdown", text: installHintsMarkdown(hints) } },
            ],
            isError: true,
          };
        }
        const wanted = new Set<string>([
          ...((input.extras as string[] | undefined) ?? []),
          ...(rerun?.extras ?? []),
        ]);
        if (wanted.size) {
          const need = wanted.has("science") ? "science" : "analysis";
          const outcome = await ensureExtras(need, context);
          if (outcome) return outcome;
          runtime = await deps.runtime.interpreter(context.signal);
          if (!runtime.ok) return failure(`runtime_unavailable: ${runtime.reason}`);
        }
      }
      const job = await deps.jobs.create({
        sessionId,
        rootSessionId: root,
        workspace: context.workspace,
        ...(context.runId ? { runId: context.runId } : {}),
        ...(context.callId ? { callId: context.callId } : {}),
        code,
        runtime: container ? "oci" : "managed",
        ...(rerun ? { rerunOf: rerun.executionId } : {}),
      });
      const inputs: JobInput[] = [];
      let manifest: unknown[] = [];
      const extrasAsked = [
        ...new Set<string>([
          ...((input.extras as string[] | undefined) ?? []),
          ...(rerun?.extras ?? []),
        ]),
      ];
      try {
        if (rerun) {
          // The verified copies of the original run, under the same names.
          for (const item of rerun.inputs) {
            const added = await deps.jobs.addInput(job, item.source, item.name);
            if (added.sha256 !== (item.copySha256 ?? item.sha256) && !item.datasetId)
              throw new Error(`Input ${item.name} changed while the rerun started`);
            inputs.push({
              ...added,
              sha256: item.sha256,
              copySha256: added.sha256,
              ...(item.datasetId ? { datasetId: item.datasetId } : {}),
            });
          }
          manifest = rerun.manifest;
        } else
          for (const item of (input.inputs as
            | Array<{ path?: string; datasetId?: string }>
            | undefined) ?? []) {
            if ((item.path === undefined) === (item.datasetId === undefined))
              throw new Error("Each input needs exactly one of path or datasetId");
            if (item.datasetId !== undefined) {
              if (!deps.datasets) throw new Error("Datasets are not available here");
              const record = deps.datasets.getFor(item.datasetId, root);
              const added = await deps.jobs.addInput(
                job,
                deps.datasets.file(record),
                `${
                  basename(record.name)
                    .replace(/\.[^.]*$/, "")
                    .replace(/[^\w.-]+/g, "_") || "dataset"
                }.sqlite`,
              );
              // Provenance names the original content, so a rerun can verify it by hash.
              inputs.push({
                ...added,
                sha256: record.sha256,
                copySha256: added.sha256,
                datasetId: record.id,
              });
              manifest.push({
                name: added.name,
                kind: "dataset",
                datasetId: record.id,
                source: record.name,
                format: record.format,
                sheets: record.sheets,
              });
              continue;
            }
            const resolved = context.resolvePath
              ? await context.resolvePath(item.path as string)
              : await safePath(context.workspace, item.path as string);
            const added = await deps.jobs.addInput(job, resolved);
            inputs.push({ ...added, copySha256: added.sha256 });
            manifest.push({ name: added.name, kind: "file", bytes: added.bytes });
          }
        if (manifest.length) await deps.jobs.writeInputsManifest(job, manifest);
        await deps.jobs.recordInputs(job, {
          inputs,
          manifest,
          ...(extrasAsked.length ? { extras: extrasAsked } : {}),
        });
      } catch (error) {
        deps.jobs.finish(job.id, "failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      const timeoutMs = Math.min(
        Number(input.timeoutMs ?? deps.limits.timeoutMs),
        deps.limits.timeoutMs,
      );
      const started = Date.now();
      const logs = { stdout: join(job.logs, "stdout.log"), stderr: join(job.logs, "stderr.log") };
      let result: Awaited<ReturnType<typeof runProcess>>;
      try {
        if (container)
          result = await container.run({
            executionId: job.id,
            mounts: {
              script: job.script,
              input: job.input,
              work: job.work,
              staging: job.staging,
            },
            signal: context.signal,
            timeoutMs,
            maxBytes: TERMINAL_BYTES,
            logFiles: logs,
            maxLogBytes: deps.limits.maxLogBytes,
            onData: context.emit,
          });
        else {
          const interpreter = runtime as Extract<typeof runtime, { ok: true }>;
          const args = [
            ...(interpreter.prefixArgs ?? []),
            "-E",
            "-s",
            "-B",
            "-u",
            "-X",
            "utf8",
            job.main,
          ];
          result = await runProcess(interpreter.executable, args, {
            cwd: job.work,
            signal: context.signal,
            timeoutMs,
            maxBytes: TERMINAL_BYTES,
            onOverflow: "truncate",
            logFiles: logs,
            maxLogBytes: deps.limits.maxLogBytes,
            env: scriptEnv(job),
            onData: context.emit,
          });
        }
      } catch (error) {
        if (context.signal.aborted) {
          deps.jobs.finish(job.id, "cancelled");
          throw error;
        }
        const timedOut =
          error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        deps.jobs.finish(job.id, timedOut ? "timed_out" : "failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!timedOut) throw error;
        const output = `${await readTail(logs.stdout, TEXT_TAIL)}${await readTail(logs.stderr, TEXT_TAIL)}`;
        return {
          content: [
            {
              type: "text",
              text: `timed out after ${Math.round(timeoutMs / 1000)}s; nothing was published (${job.id})${output ? `\n--- output (last 4 KB) ---\n${tail(output, TEXT_TAIL)}` : ""}`,
            },
            {
              type: "ui",
              block: {
                kind: "terminal",
                command: "python main.py",
                output,
                durationMs: Date.now() - started,
                truncated: true,
              },
            },
          ],
          isError: true,
        };
      }
      const durationMs = Date.now() - started;
      const failed = result.exitCode !== 0;
      let published: PublishedArtifactInfo[] = [];
      let publishError: string | undefined;
      if (!failed || input.publishOnError === true) {
        try {
          const settings = container?.settings;
          const interpreter = runtime?.ok ? runtime : undefined;
          published = await publisher.publishOutputs(job.staging, {
            executionId: job.id,
            ...(typeof input.title === "string" && input.title.trim()
              ? { title: input.title.trim() }
              : {}),
            ...(failed ? { partial: true } : {}),
            provenance: {
              runtime: settings
                ? {
                    mode: "oci",
                    engine: settings.engine,
                    ...(settings.image ? { image: settings.image } : {}),
                    extras: [],
                  }
                : {
                    mode: "managed",
                    python: interpreter?.version,
                    extras: interpreter?.extras ?? [],
                    ...(interpreter?.runtimeVersion
                      ? { runtimeVersion: interpreter.runtimeVersion }
                      : {}),
                  },
              scriptSha256: job.scriptSha256,
              inputs: inputs.map((i) => ({
                name: i.name,
                sha256: i.sha256,
                ...(i.datasetId ? { datasetId: i.datasetId } : {}),
              })),
              ...(rerun
                ? {
                    rerunOf: rerun.executionId,
                    ...(rerun.artifactId ? { rerunOfArtifact: rerun.artifactId } : {}),
                  }
                : {}),
            },
          });
        } catch (error) {
          if (!(error instanceof ArtifactRejected)) throw error;
          publishError = error.message;
        }
      }
      deps.jobs.finish(job.id, failed || publishError ? "failed" : "completed", {
        exitCode: result.exitCode,
        ...(publishError ? { error: `publish: ${publishError}` } : {}),
      });
      const warnings = published.flatMap((p) => p.warnings);
      const head = [
        `${rerun ? `rerun of ${rerun.executionId} · ` : ""}exit ${result.exitCode} in ${(durationMs / 1000).toFixed(1)}s`,
        publishError
          ? `publication rejected (nothing was published): ${publishError}`
          : failed && input.publishOnError !== true
            ? "nothing was published (non-zero exit; pass publishOnError to keep partial outputs)"
            : `published ${published.length} artifact${published.length === 1 ? "" : "s"}${published.length ? `: ${published.map(describeArtifact).join(", ")}` : ""}`,
      ].join(" · ");
      const sections = [
        head,
        ...warnings.map((w) => `warning: ${w}`),
        ...(result.stdout.trim()
          ? [`--- stdout (last 4 KB) ---\n${tail(result.stdout, TEXT_TAIL)}`]
          : []),
        ...(result.stderr.trim()
          ? [`--- stderr (last 4 KB) ---\n${tail(result.stderr, TEXT_TAIL)}`]
          : []),
      ];
      const separator = result.stdout && result.stderr && !result.stdout.endsWith("\n") ? "\n" : "";
      return {
        content: [
          { type: "text", text: sections.join("\n") },
          {
            type: "ui",
            block: {
              kind: "terminal",
              command: "python main.py",
              output: tail(`${result.stdout}${separator}${result.stderr}`, TERMINAL_BYTES),
              exitCode: result.exitCode,
              durationMs,
              ...(result.truncated ? { truncated: true } : {}),
            },
          },
          ...artifactBlocks(published),
        ],
        ...(failed || publishError ? { isError: true } : {}),
      };
    },
  });

  registry.register({
    name: "artifact_create",
    effect: "internal",
    description:
      "Publish text you already have (Markdown, HTML, CSV, JSON, SVG, plain text…) as a " +
      "downloadable artifact of this session; works without Python. fileName decides the type " +
      "(e.g. report.md, dashboard.html). HTML is shown offline: inline every script and style.",
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
