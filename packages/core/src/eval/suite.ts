/** Loader and validator of reliability-lab suites (specs/010 D1). */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EvalSuite } from "@alisio/sdk";
import { z } from "zod";
import { EvalPathError, resolveInside, unsafeRelativeReason } from "./paths.ts";

export class EvalSuiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalSuiteError";
  }
}

export interface LoadedSuite {
  suite: EvalSuite;
  /** Absolute suite directory. */
  dir: string;
  /** Absolute fixture directory per task id. */
  fixtureDirs: Record<string, string>;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Upper bound of a `command` verifier timeout: a suite cannot park a run for hours. */
export const MAX_VERIFIER_TIMEOUT_MS = 600_000;
/** Effects a task policy may add to its mode; MCP and agents are never grantable by a suite. */
const TASK_ALLOW = ["write", "process", "external", "analysis"] as const;

const id = z.string().min(1);
const verifier = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("command"),
    id,
    command: z.array(z.string()).min(1),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(
        MAX_VERIFIER_TIMEOUT_MS,
        `must be at most ${MAX_VERIFIER_TIMEOUT_MS} ms; split the check or lower timeoutMs`,
      ),
    expectExit: z.number().int().optional(),
    expectStdoutIncludes: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("file-equals"),
    id,
    path: id,
    sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex sha256"),
  }),
  z.strictObject({ kind: z.literal("file-contains"), id, path: id, text: z.string() }),
  z.strictObject({ kind: z.literal("file-absent"), id, path: id }),
  z.strictObject({ kind: z.literal("tree-diff-within"), id, allowed: z.array(id) }),
  z.strictObject({
    kind: z.literal("tool-sequence"),
    id,
    rule: z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("before"), first: id, then: id }),
      z.strictObject({ type: z.literal("never"), tool: id }),
      z.strictObject({
        type: z.literal("max-calls"),
        tool: id,
        max: z.number().int().nonnegative(),
      }),
      z.strictObject({ type: z.literal("no-repeat-failure"), tool: id }),
    ]),
  }),
]);

const task = z.strictObject({
  id,
  prompt: id,
  fixture: id,
  agent: z.string().optional(),
  budget: z.strictObject({
    maxTurns: z.number().int().positive(),
    maxTokens: z.number().int().positive().optional(),
    maxWallMs: z.number().int().positive(),
    maxToolCalls: z.number().int().positive().optional(),
  }),
  policy: z.strictObject({
    mode: z.enum(["ask", "auto", "full"]),
    readOnly: z.boolean().optional(),
    allow: z
      .array(
        z.enum(TASK_ALLOW, {
          error: `must be one of ${TASK_ALLOW.join(", ")} (MCP and agents cannot be granted by a suite)`,
        }),
      )
      .optional(),
  }),
  verifiers: z.array(verifier),
  tags: z.array(z.string()).optional(),
  fixtureGit: z.boolean().optional(),
  replayNormalize: z
    .array(
      z.strictObject({
        pattern: z.string().superRefine((value, ctx) => {
          try {
            new RegExp(value, "g");
          } catch {
            ctx.addIssue({ code: "custom", message: "must be a valid regular expression" });
          }
        }),
        replace: z.string(),
      }),
    )
    .optional(),
});

const suiteSchema = z.strictObject({
  schemaVersion: z.literal(1),
  suiteId: id,
  suiteVersion: z.string().regex(SEMVER, "must be a semver version such as 1.0.0"),
  description: z.string(),
  tasks: z.array(task).min(1, "must declare at least one task"),
});

/**
 * Reads `<dir>/suite.json` and proves the suite is internally consistent: schema, unique ids,
 * existing fixture directories and every path confined to the suite (or, for verifiers, to the
 * task working directory). Every failure names the task, the field and how to fix it.
 */
export function loadSuite(dir: string): LoadedSuite {
  const suiteDir = resolve(dir);
  const file = join(suiteDir, "suite.json");
  if (!existsSync(file))
    throw new EvalSuiteError(
      `suite.json not found in ${suiteDir}. Create it or pass the suite directory.`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new EvalSuiteError(`${file} is not valid JSON. Fix the syntax error and retry.`);
  }
  const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (version !== 1)
    throw new EvalSuiteError(
      `Unsupported schemaVersion in ${file}: expected 1, found ${JSON.stringify(version)}.`,
    );
  const parsed = suiteSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new EvalSuiteError(`Invalid suite ${file}: ${issues}`);
  }
  const suite = parsed.data as EvalSuite;

  const seen = new Set<string>();
  const fixtureDirs: Record<string, string> = {};
  for (const t of suite.tasks) {
    if (seen.has(t.id))
      throw new EvalSuiteError(`Duplicate task id "${t.id}" in ${file}. Task ids must be unique.`);
    seen.add(t.id);

    let fixtureDir: string;
    try {
      fixtureDir = resolveInside(suiteDir, t.fixture, "fixture");
    } catch (error) {
      if (!(error instanceof EvalPathError)) throw error;
      throw new EvalSuiteError(
        `Task "${t.id}": fixture "${t.fixture}" must be a relative path inside the suite directory (${error.message})`,
      );
    }
    if (!existsSync(fixtureDir))
      throw new EvalSuiteError(
        `Task "${t.id}": fixture "${t.fixture}" does not exist (looked for ${fixtureDir}). Create the directory or fix the path.`,
      );
    if (!statSync(fixtureDir).isDirectory())
      throw new EvalSuiteError(`Task "${t.id}": fixture "${t.fixture}" is not a directory.`);
    fixtureDirs[t.id] = fixtureDir;

    const verifierIds = new Set<string>();
    for (const v of t.verifiers) {
      if (verifierIds.has(v.id))
        throw new EvalSuiteError(`Task "${t.id}": duplicate verifier id "${v.id}".`);
      verifierIds.add(v.id);
      const paths =
        v.kind === "tree-diff-within"
          ? { field: "allowed", values: v.allowed }
          : "path" in v
            ? { field: "path", values: [v.path] }
            : undefined;
      for (const value of paths?.values ?? []) {
        const reason = unsafeRelativeReason(value);
        if (reason)
          throw new EvalSuiteError(
            `Task "${t.id}": verifier "${v.id}" ${paths?.field} "${value}" ${reason}. Verifier paths are relative to the task working directory.`,
          );
      }
    }
  }
  return { suite, dir: suiteDir, fixtureDirs };
}
