/**
 * Rerun of a `python_run` execution (spec §19): the same `script/main.py` and the same inputs,
 * verified by sha256, as a NEW execution with new artifacts. Nothing of the original is touched.
 * When the saved script, an input copy or a dataset is missing or no longer matches its recorded
 * hash, nothing runs and every problem is reported.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { DatasetService } from "./data/datasets.ts";
import type { AnalysisJobs, JobInput } from "./jobs.ts";

export interface RerunInput extends JobInput {
  /** Absolute file to copy into the new job's `input/` (verified before). */
  source: string;
}

export interface RerunPlan {
  /** The execution being repeated. */
  executionId: string;
  /** The artifact the user pointed at, when the reference was an artifact. */
  artifactId?: string;
  code: string;
  scriptSha256: string;
  inputs: RerunInput[];
  manifest: unknown[];
  extras: Array<"analysis" | "science">;
  /** The runtime of the original execution (a rerun uses the configured runtime now). */
  runtime: "managed" | "oci";
}

export type RerunPreparation = { ok: true; plan: RerunPlan } | { ok: false; problems: string[] };

export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const fail = (...problems: string[]): RerunPreparation => ({ ok: false, problems });

export class AnalysisRerun {
  constructor(
    private options: {
      jobs: AnalysisJobs;
      store: ArtifactStore;
      datasets?: DatasetService;
    },
  ) {}

  /** The script of a saved execution as a preview (approvals show it), or undefined. */
  async script(ref: string, rootSessionId: string): Promise<string | undefined> {
    const resolved = this.resolve(ref, rootSessionId);
    if (!("executionId" in resolved)) return undefined;
    const details = this.options.jobs.details(resolved.executionId);
    if (!details) return undefined;
    try {
      return await readFile(
        join(this.options.jobs.folder(details.relDir), "script", "main.py"),
        "utf8",
      );
    } catch {
      return undefined;
    }
  }

  private resolve(
    ref: string,
    rootSessionId: string,
  ): { executionId: string; artifactId?: string } | { problem: string } {
    if (ref.startsWith("art_")) {
      const record = this.options.store.get(ref);
      if (!record || record.sessionId !== rootSessionId)
        return { problem: `Artifact ${ref} was not found in this session` };
      if (!record.executionId)
        return {
          problem: `${record.fileName} was not produced by python_run, so it has no script to run again`,
        };
      if (record.status === "deleted")
        return {
          problem: `${record.fileName} was deleted; run the analysis again from its script instead`,
        };
      return { executionId: record.executionId, artifactId: record.id };
    }
    if (ref.startsWith("exec_")) return { executionId: ref };
    return { problem: `${ref} is neither an artifact (art_…) nor an execution (exec_…) id` };
  }

  async prepare(ref: string, rootSessionId: string): Promise<RerunPreparation> {
    const resolved = this.resolve(ref, rootSessionId);
    if ("problem" in resolved) return fail(resolved.problem);
    const { jobs, datasets } = this.options;
    const details = jobs.details(resolved.executionId);
    if (!details || details.rootSessionId !== rootSessionId)
      return fail(`Execution ${resolved.executionId} was not found in this session`);
    let folder: string;
    try {
      folder = jobs.folder(details.relDir);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    let code: string;
    try {
      code = await readFile(join(folder, "script", "main.py"), "utf8");
    } catch {
      return fail(
        `The script of ${details.id} is no longer available (the retention sweep removes the scripts of executions without ready artifacts)`,
      );
    }
    if (createHash("sha256").update(code).digest("hex") !== details.scriptSha256)
      return fail(`The saved script of ${details.id} does not match its recorded hash`);
    const recorded = await jobs.recordedInputs(details.relDir);
    const problems: string[] = [];
    const inputs: RerunInput[] = [];
    if (!recorded) {
      const present = await readdir(join(folder, "input")).catch(() => [] as string[]);
      if (present.some((name) => name !== "inputs.json"))
        problems.push(`The inputs of ${details.id} were not recorded, so they cannot be verified`);
    } else
      for (const input of recorded.inputs) {
        // `job.json` is internal, but a name is never trusted to leave `input/`.
        if (typeof input.name !== "string" || basename(input.name) !== input.name) {
          problems.push("The recorded inputs of this execution are not valid");
          continue;
        }
        if (input.datasetId) {
          const record = datasets?.get(input.datasetId);
          if (!record || record.rootSessionId !== rootSessionId)
            problems.push(`Input ${input.name}: the dataset ${input.datasetId} no longer exists`);
          else if (record.sha256 !== input.sha256)
            problems.push(`Input ${input.name}: the dataset ${input.datasetId} changed`);
          else inputs.push({ ...input, source: datasets?.file(record) as string });
          continue;
        }
        const source = join(folder, "input", input.name);
        let actual: string | undefined;
        try {
          actual = await sha256OfFile(source);
        } catch {
          problems.push(`Input ${input.name} is missing`);
          continue;
        }
        if (actual !== (input.copySha256 ?? input.sha256))
          problems.push(`Input ${input.name} changed (its sha256 no longer matches the original)`);
        else inputs.push({ ...input, source });
      }
    if (problems.length) return { ok: false, problems };
    return {
      ok: true,
      plan: {
        executionId: details.id,
        ...(resolved.artifactId ? { artifactId: resolved.artifactId } : {}),
        code,
        scriptSha256: details.scriptSha256,
        inputs,
        manifest: recorded?.manifest ?? [],
        extras: (recorded?.extras ?? []).filter(
          (e): e is "analysis" | "science" => e === "analysis" || e === "science",
        ),
        runtime: details.runtime,
      },
    };
  }
}
