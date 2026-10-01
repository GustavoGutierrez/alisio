/**
 * Internal job folders of `python_run`, outside the repository and outside the artifact store:
 * `<root>/analysis/jobs/<workspaceKey>/<root session>/<executionId>/` with `job.json`,
 * `script/main.py` (+ the `alisio_runtime` package), `input/`, `work/`, `staging/` and `logs/`.
 * Nothing here is published automatically: only `staging/` is read by the artifact publisher.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { SqlDatabase } from "@alisio/sdk";
import { newId } from "../runtime/ids.ts";
import { workspaceKey } from "../runtime/paths.ts";
import { ALISIO_RUNTIME_FILES } from "./python/sources.ts";

export type ExecutionStatus = "running" | "completed" | "failed" | "cancelled" | "timed_out";

export interface JobPaths {
  id: string;
  root: string;
  script: string;
  main: string;
  input: string;
  work: string;
  staging: string;
  logs: string;
}

export interface JobInput {
  /** Name inside `input/`. */
  name: string;
  /** Hash of the content named in the provenance (for a dataset: the original file). */
  sha256: string;
  bytes: number;
  /** Set for a dataset (the `.sqlite` file of §17): its id and the hash of the original file. */
  datasetId?: string;
  /** Hash of the copy inside `input/` (differs from `sha256` for a dataset's SQLite file). */
  copySha256?: string;
}

/** What `job.json` records about the inputs, so a rerun can verify them (internal; never public). */
export interface RecordedInputs {
  inputs: JobInput[];
  /** The `input/inputs.json` entries the script reads. */
  manifest: unknown[];
  /** Extras the run asked for (`python_run { extras }`), so a rerun asks for the same. */
  extras?: string[];
}

export interface ExecutionDetails {
  id: string;
  sessionId: string;
  rootSessionId: string;
  workspace: string;
  runtime: "managed" | "oci";
  status: ExecutionStatus;
  scriptSha256: string;
  exitCode?: number;
  relDir: string;
  rerunOf?: string;
  createdAt: number;
  endedAt?: number;
}

const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

/** Executions of `python_run` (`analysis_executions`) and their job folders. */
export class AnalysisJobs {
  constructor(private options: { root: string; db: SqlDatabase; now?: () => number }) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Creates the job folder (script, runtime helpers, empty input/work/staging/logs) and its row. */
  async create(input: {
    sessionId: string;
    rootSessionId: string;
    workspace: string;
    runId?: string;
    callId?: string;
    code: string;
    runtime: "managed" | "oci";
    /** The execution this one repeats (a rerun); recorded in the row and in `job.json`. */
    rerunOf?: string;
  }): Promise<JobPaths & { scriptSha256: string }> {
    const id = newId("exec", this.now());
    const root = join(
      this.options.root,
      "analysis",
      "jobs",
      workspaceKey(input.workspace),
      input.rootSessionId,
      id,
    );
    const paths: JobPaths = {
      id,
      root,
      script: join(root, "script"),
      main: join(root, "script", "main.py"),
      input: join(root, "input"),
      work: join(root, "work"),
      staging: join(root, "staging"),
      logs: join(root, "logs"),
    };
    for (const dir of [paths.script, paths.input, paths.work, paths.staging, paths.logs])
      await mkdir(dir, { recursive: true });
    await writeFile(paths.main, input.code, { flag: "wx" });
    const runtimeDir = join(paths.script, "alisio_runtime");
    await mkdir(runtimeDir);
    for (const [name, text] of Object.entries(ALISIO_RUNTIME_FILES))
      await writeFile(join(runtimeDir, name), text, { flag: "wx" });
    const scriptSha256 = sha256(input.code);
    const createdAt = this.now();
    await writeFile(
      join(root, "job.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id,
          sessionId: input.sessionId,
          rootSessionId: input.rootSessionId,
          runId: input.runId,
          callId: input.callId,
          runtime: input.runtime,
          scriptSha256,
          ...(input.rerunOf ? { rerunOf: input.rerunOf } : {}),
          createdAt,
        },
        null,
        2,
      )}\n`,
    );
    this.options.db
      .prepare(
        `INSERT INTO analysis_executions(id,session,root_session,workspace,run_id,call_id,runtime,
           status,script_sha256,rel_dir,rerun_of,created_at) VALUES(?,?,?,?,?,?,?,'running',?,?,?,?)`,
      )
      .run(
        id,
        input.sessionId,
        input.rootSessionId,
        input.workspace,
        input.runId ?? null,
        input.callId ?? null,
        input.runtime,
        scriptSha256,
        relative(this.options.root, root),
        input.rerunOf ?? null,
        createdAt,
      );
    return { ...paths, scriptSha256 };
  }

  /**
   * Copies an input file (already resolved by the path policy) into `input/`, as `name` (default:
   * its own name). Copy-on-write clones are used where the file system has them; the copy is
   * never a link, so a script cannot alter the original.
   */
  async addInput(job: JobPaths, source: string, preferred?: string): Promise<JobInput> {
    const info = await lstat(source);
    if (!info.isFile()) throw new Error(`Input ${source} is not a regular file`);
    const wanted = preferred ?? basename(source);
    let name = wanted;
    for (let n = 2; await exists(join(job.input, name)); n++)
      name = wanted.replace(/(\.[^.]*)?$/, (ext) => `-${n}${ext}`);
    const target = join(job.input, name);
    await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    const bytes = await readFile(target);
    return { name, sha256: sha256(bytes), bytes: bytes.byteLength };
  }

  /** `input/inputs.json`: what each input is (the script reads it with `alisio_runtime.datasets.inputs()`). */
  async writeInputsManifest(job: JobPaths, entries: unknown[]): Promise<void> {
    await writeFile(join(job.input, "inputs.json"), `${JSON.stringify(entries, null, 2)}\n`);
  }

  /** Adds the inputs to `job.json` (atomically), once they are copied into `input/`. */
  async recordInputs(job: JobPaths, recorded: RecordedInputs): Promise<void> {
    const file = join(job.root, "job.json");
    const current = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ ...current, ...recorded }, null, 2)}\n`);
    await rename(temporary, file);
  }

  /** The inputs a finished job recorded; `undefined` when `job.json` is missing or has none. */
  async recordedInputs(relDir: string): Promise<RecordedInputs | undefined> {
    try {
      const value = JSON.parse(
        await readFile(join(this.options.root, relDir, "job.json"), "utf8"),
      ) as Partial<RecordedInputs>;
      return Array.isArray(value.inputs)
        ? {
            inputs: value.inputs,
            manifest: Array.isArray(value.manifest) ? value.manifest : [],
            ...(Array.isArray(value.extras) ? { extras: value.extras } : {}),
          }
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Absolute folder of an execution (`rel_dir` is always relative to the state root). */
  folder(relDir: string): string {
    const folder = join(this.options.root, relDir);
    const inside = relative(this.options.root, folder);
    if (!inside || inside.startsWith("..") || isAbsolute(inside) || inside.split(sep)[0] === "..")
      throw new Error("The execution folder is outside the state folder");
    return folder;
  }

  /** The whole row of an execution. */
  details(id: string): ExecutionDetails | undefined {
    const row = this.options.db.prepare("SELECT * FROM analysis_executions WHERE id=?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      sessionId: String(row.session),
      rootSessionId: String(row.root_session),
      workspace: String(row.workspace),
      runtime: String(row.runtime) as "managed" | "oci",
      status: String(row.status) as ExecutionStatus,
      scriptSha256: String(row.script_sha256),
      ...(row.exit_code != null ? { exitCode: Number(row.exit_code) } : {}),
      relDir: String(row.rel_dir),
      ...(row.rerun_of != null ? { rerunOf: String(row.rerun_of) } : {}),
      createdAt: Number(row.created_at),
      ...(row.ended_at != null ? { endedAt: Number(row.ended_at) } : {}),
    };
  }

  finish(id: string, status: ExecutionStatus, details: { exitCode?: number; error?: string } = {}) {
    this.options.db
      .prepare(
        "UPDATE analysis_executions SET status=?, exit_code=?, error=?, ended_at=? WHERE id=?",
      )
      .run(status, details.exitCode ?? null, details.error ?? null, this.now(), id);
  }

  get(id: string): { status: ExecutionStatus; exitCode?: number; relDir: string } | undefined {
    const row = this.options.db
      .prepare("SELECT status, exit_code, rel_dir FROM analysis_executions WHERE id=?")
      .get(id) as
      | { status: ExecutionStatus; exit_code: number | null; rel_dir: string }
      | undefined;
    return row
      ? {
          status: row.status,
          ...(row.exit_code != null ? { exitCode: row.exit_code } : {}),
          relDir: row.rel_dir,
        }
      : undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
