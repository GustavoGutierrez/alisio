/**
 * Plugin creator projects: a source folder per project (also the creator session's workspace), a
 * metadata record written atomically, and the last package. Building validates the project,
 * runs its tests, probes the exported plugin object and packs a `.tgz` that the existing
 * "install from file" flow accepts. Installing is the server's job (it shares the install lock);
 * `status` always cross-checks the real plugins directory, never the record alone.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type {
  PluginCreatorBuildStats,
  PluginCreatorIssue,
  PluginCreatorProjectInfo,
  PluginCreatorStatus,
  PluginCreatorStep,
  PluginCreatorStepId,
  PluginCreatorStepStatus,
  PluginCreatorTestRun,
} from "@alisio/sdk";
import { configHome } from "../../config.ts";
import { WORKSPACE_MARKER } from "../../runtime/paths.ts";
import { installedGlobalPlugins, pluginDependencySpec } from "../install.ts";
import { storedTarballName } from "../local-install.ts";
import { packDirectory } from "../tarball-writer.ts";
import { hashProject, projectFilePath, walkProject } from "./files.ts";
import { type GateCommand, runInstalledGate } from "./gate-runner.ts";
import { checkSyntax, type NodeCommand, probePlugin, runNodeTests } from "./node-test.ts";
import { type PluginCreatorPaths, PROJECT_ID, pluginCreatorPaths } from "./paths.ts";
import { pluginTemplateFiles } from "./template.ts";
import {
  PLUGIN_CREATOR_LIMITS,
  PLUGIN_CREATOR_STEPS,
  PluginCreatorError,
  type PluginCreatorErrorCode,
} from "./types.ts";
import {
  ASSET_LIMITS,
  type ProjectValidation,
  sniffImage,
  svgProblem,
  validateProject,
} from "./validate.ts";

export interface PluginCreatorProjectsOptions {
  /** Config home (default `configHome()`). */
  home?: string;
  /** `peerDependencies["@alisio/sdk"]` of new projects, e.g. `^0.11.0` (default: from `sdkVersion`). */
  sdkRange?: string;
  /** Version of the `@alisio/sdk` this Alisio runs; every validation checks the peer range against it. */
  sdkVersion?: string;
  now?: () => number;
  node?: NodeCommand;
  /** Time limit of the real-host gate of a build (default 30 s). */
  gateTimeoutMs?: number;
  /** How to start the gate child (default: this runtime, see `gateCommand`). */
  gateCommand?: GateCommand;
}

/** Failed builds in a row after which the creator agent must stop and hand over to the person. */
export const MAX_BUILD_ATTEMPTS = 3;

export interface PluginBuildOutcome {
  ok: boolean;
  stats: PluginCreatorBuildStats;
  issues: PluginCreatorIssue[];
  tests?: PluginCreatorTestRun;
  error?: { code: PluginCreatorErrorCode; message: string };
}

interface BuildRecord {
  file: string;
  hash: string;
  version: string;
}

const PLUGIN_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
/** Serializes record updates per project inside this process. */
const chains = new Map<string, Promise<unknown>>();
/** Projects with a build running in this process. */
const building = new Set<string>();

function slugify(text: string): string {
  const slug = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
  return slug || "plugin";
}

/** Words a short title must not end on ("Track the expenses of" -> "Track the expenses"). */
const DANGLING =
  /^(a|an|the|of|to|in|on|at|for|with|and|or|by|from|into|my|your|en|de|del|la|el|los|las|un|una|unos|unas|y|o|con|para|por|al|mi|mis|su|sus|que)$/i;

/**
 * A short provisional title from the request: its first clause, at most five words and 48
 * characters, cut only between words and never on a dangling article or preposition. The plugin's
 * own `name` replaces it after the first successful build.
 */
export function titleFrom(request: string): string {
  const clause =
    request
      .replace(/\s+/g, " ")
      .trim()
      .split(/[.,;:!?¿¡()\n]/)[0]
      ?.trim() ?? "";
  const words = clause.split(" ").filter(Boolean).slice(0, 5);
  while (words.join(" ").length > 48 && words.length > 1) words.pop();
  while (words.length > 1 && DANGLING.test(words.at(-1) ?? "")) words.pop();
  const title = words.join(" ").slice(0, 48) || request.trim().slice(0, 48);
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function descriptionFrom(request: string): string {
  const text = request.replace(/\s+/g, " ").trim();
  const sentence = /^(.{10,200}?[.!?])(\s|$)/.exec(text)?.[1] ?? text.slice(0, 200);
  return sentence;
}

/** A `^major.minor.0` range for a version (`0.11.7` -> `^0.11.0`); `*` when unknown. */
export function sdkRangeFor(version: string | undefined): string {
  const match = version ? /^(\d+)\.(\d+)\.\d+/.exec(version) : undefined;
  return match ? `^${match[1]}.${match[2]}.0` : "*";
}

export class PluginCreatorProjects {
  readonly paths: PluginCreatorPaths;
  private readonly home: string;
  private readonly now: () => number;

  constructor(private readonly options: PluginCreatorProjectsOptions = {}) {
    this.home = options.home ?? configHome();
    this.paths = pluginCreatorPaths(this.home);
    this.now = options.now ?? Date.now;
  }

  private validateOptions() {
    return this.options.sdkVersion ? { sdkVersion: this.options.sdkVersion } : {};
  }

  /** The source folder of a project (not checked for existence). */
  dir(id: string): string {
    return join(this.paths.projects, id);
  }

  private recordFile(id: string): string {
    return join(this.paths.records, `${id}.json`);
  }

  private notFound(): PluginCreatorError {
    return new PluginCreatorError("plugin_project_not_found", "Plugin project not found");
  }

  private async readRecord(id: string): Promise<PluginCreatorProjectInfo> {
    if (!PROJECT_ID.test(id)) throw this.notFound();
    let record: PluginCreatorProjectInfo;
    try {
      record = JSON.parse(await readFile(this.recordFile(id), "utf8"));
    } catch {
      throw this.notFound();
    }
    if (!record || record.id !== id) throw this.notFound();
    return record;
  }

  private async writeRecord(record: PluginCreatorProjectInfo): Promise<void> {
    await mkdir(this.paths.records, { recursive: true, mode: 0o700 });
    const file = this.recordFile(record.id);
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  }

  /** Read-modify-write of one record, serialized per project. */
  private update(
    id: string,
    change: (record: PluginCreatorProjectInfo) => void,
  ): Promise<PluginCreatorProjectInfo> {
    const run = async () => {
      const record = await this.readRecord(id);
      change(record);
      record.updatedAt = this.now();
      await this.writeRecord(record);
      return record;
    };
    const previous = chains.get(id) ?? Promise.resolve();
    const next = previous.then(run, run);
    chains.set(
      id,
      next.catch(() => {}),
    );
    return next;
  }

  /**
   * The record with `version`/`description` refreshed from the project's package.json, plus the
   * derived `dir` and `icon` (never stored: `update` writes the raw record).
   */
  private async withSources(record: PluginCreatorProjectInfo): Promise<PluginCreatorProjectInfo> {
    record.dir = this.dir(record.id);
    try {
      const pkg = JSON.parse(await readFile(join(this.dir(record.id), "package.json"), "utf8"));
      if (typeof pkg.version === "string") record.version = pkg.version;
      if (typeof pkg.description === "string" && pkg.description.trim())
        record.description = pkg.description.trim();
      const icon = iconPath(pkg);
      if (icon) record.icon = icon;
    } catch {
      /* a broken package.json keeps the recorded values; validation reports it */
    }
    return record;
  }

  /**
   * The project's icon (`package.json` `alisio.icon`) when it is an image inside the project
   * within the icon size limit, sniffed by content; an SVG must pass the same safety check as the
   * build. Undefined otherwise (the UI shows a generic icon).
   */
  async icon(
    id: string,
  ): Promise<{ data: Buffer; type: "svg" | "png" | "webp" | "jpeg" } | undefined> {
    await this.readRecord(id);
    try {
      const pkg = JSON.parse(await readFile(join(this.dir(id), "package.json"), "utf8"));
      const rel = iconPath(pkg);
      if (!rel) return undefined;
      const data = await readFile(await projectFilePath(this.dir(id), rel));
      if (data.length > ASSET_LIMITS.icon) return undefined;
      const type = sniffImage(data);
      if (!type || (type === "svg" && svgProblem(data.toString("utf8")))) return undefined;
      return { data, type };
    } catch {
      return undefined;
    }
  }

  async list(): Promise<PluginCreatorProjectInfo[]> {
    let names: string[] = [];
    try {
      names = await readdir(this.paths.records);
    } catch {
      return [];
    }
    const out: PluginCreatorProjectInfo[] = [];
    for (const name of names) {
      const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!PROJECT_ID.test(id)) continue;
      try {
        out.push(await this.get(id));
      } catch {
        /* an unreadable record is skipped, never fatal for the list */
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<PluginCreatorProjectInfo> {
    return this.withSources(await this.readRecord(id));
  }

  async create(input: {
    request: string;
    displayName?: string;
    model?: string;
  }): Promise<PluginCreatorProjectInfo> {
    const request = typeof input.request === "string" ? input.request.trim() : "";
    if (!request || request.length > PLUGIN_CREATOR_LIMITS.requestChars)
      throw new PluginCreatorError(
        "validation_failed",
        `Describe the plugin in 1 to ${PLUGIN_CREATOR_LIMITS.requestChars} characters`,
        { fields: ["request"] },
      );
    const displayName = (input.displayName?.trim() || titleFrom(request)).slice(
      0,
      PLUGIN_CREATOR_LIMITS.displayNameChars,
    );
    const id = randomBytes(6).toString("hex");
    const slug = slugify(displayName);
    const suffix = id.slice(0, 4);
    const now = this.now();
    const record: PluginCreatorProjectInfo = {
      id,
      packageName: `alisio-plugin-local-${slug}-${suffix}`,
      pluginId: `local.${slug}-${suffix}`,
      displayName,
      description: descriptionFrom(request),
      version: "1.0.0",
      createdAt: now,
      updatedAt: now,
      requests: [{ id: randomBytes(4).toString("hex"), kind: "create", text: request, at: now }],
      progress: {
        steps: PLUGIN_CREATOR_STEPS.map((step) => ({ id: step, status: "pending" })),
        updatedAt: now,
      },
      ...(input.model ? { lastModel: input.model } : {}),
    };
    const dir = this.dir(id);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(
        join(dir, WORKSPACE_MARKER),
        "This folder is an Alisio plugin creator project.\n",
      );
      const files = pluginTemplateFiles({
        packageName: record.packageName,
        pluginId: record.pluginId,
        displayName,
        description: record.description,
        sdkRange: this.options.sdkRange ?? sdkRangeFor(this.options.sdkVersion),
      });
      for (const [rel, text] of Object.entries(files)) {
        await mkdir(join(dir, rel, ".."), { recursive: true });
        await writeFile(join(dir, rel), text);
      }
      await this.writeRecord(record);
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      await rm(this.recordFile(id), { force: true }).catch(() => {});
      throw error;
    }
    return record;
  }

  /** Removes the sources, the record and the builds (uninstalling is the caller's choice). */
  async delete(id: string): Promise<void> {
    await this.readRecord(id);
    if (building.has(id))
      throw new PluginCreatorError("plugin_project_busy", "The plugin is being built right now");
    await rm(this.dir(id), { recursive: true, force: true });
    await rm(join(this.paths.builds, id), { recursive: true, force: true });
    await rm(this.recordFile(id), { force: true });
  }

  async addRequest(
    id: string,
    text: string,
    kind: "create" | "modify" = "modify",
  ): Promise<PluginCreatorProjectInfo> {
    const clean = text.trim();
    if (!clean || clean.length > PLUGIN_CREATOR_LIMITS.requestChars)
      throw new PluginCreatorError("validation_failed", "The request is empty or too long", {
        fields: ["request"],
      });
    return this.update(id, (record) => {
      record.requests = [
        ...record.requests,
        { id: randomBytes(4).toString("hex"), kind, text: clean, at: this.now() },
      ].slice(-PLUGIN_CREATOR_LIMITS.maxRequests);
      // A new request starts a new round of progress and of build attempts.
      record.failedBuilds = 0;
      record.progress = {
        steps: PLUGIN_CREATOR_STEPS.map((step) => ({ id: step, status: "pending" })),
        updatedAt: this.now(),
      };
    });
  }

  async setSession(id: string, sessionId: string, model?: string): Promise<void> {
    await this.update(id, (record) => {
      record.sessionId = sessionId;
      if (model) record.lastModel = model;
    });
  }

  async recordProgress(
    id: string,
    step: PluginCreatorStepId,
    status: PluginCreatorStepStatus,
    note?: string,
  ): Promise<PluginCreatorProjectInfo> {
    if (!PLUGIN_CREATOR_STEPS.includes(step))
      throw new PluginCreatorError("validation_failed", `Unknown step: ${String(step)}`);
    // "Packaged" is only true when the latest build passed every gate on these exact sources.
    if (step === "package" && status === "done" && !(await this.packagePath(id)))
      throw new PluginCreatorError(
        "plugin_not_built",
        "The plugin has not passed every check yet: run the build, fix every issue and build again",
      );
    return this.update(id, (record) => {
      const now = this.now();
      const steps = PLUGIN_CREATOR_STEPS.map(
        (s): PluginCreatorStep =>
          record.progress?.steps.find((x) => x.id === s) ?? { id: s, status: "pending" },
      );
      const index = PLUGIN_CREATOR_STEPS.indexOf(step);
      const finished = step === "package" && status === "done";
      record.progress = {
        steps: steps.map((s, i) =>
          s.id === step
            ? {
                id: s.id,
                status,
                ...(note?.trim() ? { note: note.trim().slice(0, 200) } : {}),
                updatedAt: now,
              }
            : // A later step started or ended: an earlier step still "running" is done. Packaged:
              // every step is done.
              (i < index && s.status === "running") || (finished && s.status !== "done")
              ? { ...s, status: "done", updatedAt: now }
              : s,
        ),
        updatedAt: now,
      };
    });
  }

  /**
   * Called when a creator run ends (completed, failed or cancelled): no step may stay "running".
   * A leftover running step becomes "done" when the latest build passed every gate on the
   * current sources (or the package step is already done), else "failed". Also repairs records
   * written before this rule existed.
   */
  async settleProgress(id: string): Promise<PluginCreatorProjectInfo> {
    const record = await this.readRecord(id);
    if (!record.progress?.steps.some((step) => step.status === "running")) return record;
    const packaged =
      record.progress.steps.some((step) => step.id === "package" && step.status === "done") ||
      (await this.packagePath(id)) !== undefined;
    return this.update(id, (r) => {
      if (!r.progress) return;
      const now = this.now();
      r.progress = {
        steps: r.progress.steps.map((step) =>
          step.status === "running"
            ? { ...step, status: packaged ? "done" : "failed", updatedAt: now }
            : step,
        ),
        updatedAt: now,
      };
    });
  }

  async recordInstall(id: string, version: string): Promise<void> {
    await this.update(id, (record) => {
      record.installedVersion = version;
    });
  }

  async listFiles(id: string) {
    await this.readRecord(id);
    const walk = await walkProject(this.dir(id));
    return { files: walk.files, count: walk.files.length, bytes: walk.bytes };
  }

  async readFile(
    id: string,
    path: string,
  ): Promise<{ path: string; bytes: number; binary: boolean; truncated: boolean; text?: string }> {
    await this.readRecord(id);
    const file = await projectFilePath(this.dir(id), path);
    const data = await readFile(file);
    const rel = path.replace(/\\/g, "/");
    if (data.subarray(0, 8192).includes(0))
      return { path: rel, bytes: data.length, binary: true, truncated: false };
    const text = data.toString("utf8");
    const truncated = text.length > PLUGIN_CREATOR_LIMITS.readChars;
    return {
      path: rel,
      bytes: data.length,
      binary: false,
      truncated,
      text: truncated ? text.slice(0, PLUGIN_CREATOR_LIMITS.readChars) : text,
    };
  }

  /** Static validation; also refreshes the detected schema in the record. */
  async validate(id: string): Promise<ProjectValidation> {
    await this.readRecord(id);
    const result = await validateProject(this.dir(id), this.validateOptions());
    await this.update(id, (record) => {
      if (result.schema.tables.length) record.schema = result.schema;
      else delete record.schema;
    });
    return result;
  }

  async runTests(
    id: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<PluginCreatorTestRun> {
    await this.readRecord(id);
    const validation = await validateProject(this.dir(id), this.validateOptions());
    if (!validation.tests.length)
      return {
        ok: false,
        passed: 0,
        failed: 0,
        durationMs: 0,
        timedOut: false,
        output: "There are no test files (test/<name>.test.js).",
      };
    return runNodeTests(this.dir(id), validation.tests, {
      ...options,
      ...(this.options.node ? { node: this.options.node } : {}),
    });
  }

  /** Validate, test, probe and pack. Never throws for project problems: see `error`. */
  async build(id: string, options: { signal?: AbortSignal } = {}): Promise<PluginBuildOutcome> {
    const record = await this.get(id);
    if (building.has(id))
      throw new PluginCreatorError("plugin_project_busy", "The plugin is already being built");
    building.add(id);
    const started = Date.now();
    const dir = this.dir(id);
    try {
      const validation = await validateProject(dir, this.validateOptions());
      const issues = [...validation.issues];
      const version =
        typeof validation.manifest?.version === "string"
          ? validation.manifest.version
          : record.version;
      let displayName: string | undefined;
      const finish = async (
        outcome: Omit<PluginBuildOutcome, "stats" | "issues">,
        extra: Partial<PluginCreatorBuildStats> = {},
      ): Promise<PluginBuildOutcome> => {
        const at = this.now();
        const lastRequest = record.requests.at(-1);
        const stats: PluginCreatorBuildStats = {
          at,
          ok: outcome.ok,
          durationMs: Date.now() - started,
          ...(lastRequest && lastRequest.at <= at ? { generationMs: at - lastRequest.at } : {}),
          files: validation.walk.files.length,
          bytes: validation.walk.bytes,
          testsPassed: outcome.tests?.passed ?? 0,
          testsFailed: outcome.tests?.failed ?? 0,
          version,
          ...(outcome.error ? { errorCode: outcome.error.code } : {}),
          ...(outcome.ok
            ? {}
            : {
                issues: issues
                  .filter((issue) => issue.severity === "error")
                  .slice(0, 20)
                  .map((issue) => ({ ...issue, message: issue.message.slice(0, 500) })),
              }),
          ...extra,
        };
        await this.update(id, (r) => {
          r.lastBuild = stats;
          r.failedBuilds = outcome.ok ? 0 : (r.failedBuilds ?? 0) + 1;
          if (outcome.ok && displayName)
            r.displayName = displayName.slice(0, PLUGIN_CREATOR_LIMITS.displayNameChars);
          if (validation.schema.tables.length) r.schema = validation.schema;
          else delete r.schema;
        });
        return { ...outcome, stats, issues };
      };
      if (!validation.ok || !validation.entry)
        return finish({
          ok: false,
          error: {
            code: "plugin_project_invalid",
            message: "The plugin breaks a plugin rule: see the issues",
          },
        });
      const shipped = validation.walk.files
        .map((f) => f.path)
        .filter((path) => /\.(?:m|c)?js$/.test(path) && !path.startsWith("test/"));
      for (const problem of await checkSyntax(dir, shipped, {
        ...(this.options.node ? { node: this.options.node } : {}),
      }))
        issues.push({
          code: "syntax_error",
          severity: "error",
          message: `${problem.file} is not a plain JavaScript module: ${problem.message}`,
          file: problem.file,
        });
      if (issues.some((issue) => issue.severity === "error"))
        return finish({
          ok: false,
          error: {
            code: "plugin_project_invalid",
            message: "The plugin breaks a plugin rule: see the issues",
          },
        });
      const tests = await runNodeTests(dir, validation.tests, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(this.options.node ? { node: this.options.node } : {}),
      });
      if (!tests.ok)
        return finish({
          ok: false,
          tests,
          error: {
            code: "plugin_tests_failed",
            message: tests.timedOut
              ? "The tests took too long and were stopped"
              : `${tests.failed} test(s) failed`,
          },
        });
      const probe = await probePlugin(dir, validation.entry, {
        ...(this.options.node ? { node: this.options.node } : {}),
      });
      const fail = (code: string, message: string) =>
        issues.push({ code, severity: "error", message, file: validation.entry });
      if (!probe.ok) fail("load_failed", probe.error ?? "The plugin could not be loaded");
      else {
        if (typeof probe.id !== "string" || !PLUGIN_ID.test(probe.id))
          fail("plugin_id_invalid", "The plugin id must use lowercase letters, digits, . and -");
        if (probe.apiVersion !== 1)
          fail("api_version_invalid", "The plugin must set apiVersion: 1");
        if (!probe.hasSetup) fail("setup_missing", "The plugin must have a setup(api) function");
        for (const member of probe.unknownMembers ?? [])
          fail(
            "api_member_unknown",
            `setup uses ${member}, which the installed Alisio SDK does not have`,
          );
        if (probe.setupError)
          issues.push({
            code: "setup_probe_failed",
            severity: "warning",
            message: `setup failed against the test API: ${probe.setupError}`,
            file: validation.entry,
          });
        else if (!Object.keys(probe.registered ?? {}).length)
          issues.push({
            code: "registers_nothing",
            severity: "warning",
            message: "setup registers no tool, command or view",
            file: validation.entry,
          });
        if (probe.version !== version)
          fail(
            "version_mismatch",
            `The plugin says version ${String(probe.version)} but package.json says ${version}`,
          );
      }
      if (issues.some((issue) => issue.severity === "error"))
        return finish({
          ok: false,
          tests,
          error: {
            code: "plugin_project_invalid",
            message: "The plugin object is not valid: see the issues",
          },
        });
      const buildDir = join(this.paths.builds, id);
      await rm(buildDir, { recursive: true, force: true });
      await mkdir(buildDir, { recursive: true, mode: 0o700 });
      const name = typeof validation.manifest?.name === "string" ? validation.manifest.name : "";
      const file = join(buildDir, storedTarballName(name, version));
      const hash = await hashProject(dir);
      const packed = await packDirectory(dir, file);
      // Gates on the package itself: what ships, then the real host on an installed copy.
      const shippedSet = new Set(packed.files);
      for (const [from, targets] of validation.imports)
        if (shippedSet.has(from))
          for (const target of targets)
            if (!shippedSet.has(target))
              issues.push({
                code: "import_not_packed",
                severity: "error",
                message: `${from} imports ${target}, which the package does not include (check "files" in package.json and the path)`,
                file: from,
              });
      const gate = await runInstalledGate(file, name, {
        ...(this.options.gateTimeoutMs ? { timeoutMs: this.options.gateTimeoutMs } : {}),
        ...(this.options.gateCommand ? { command: this.options.gateCommand } : {}),
      });
      for (const issue of gate.issues)
        issues.push({ ...issue, severity: "error", file: validation.entry });
      if (
        gate.issues.every((i) => i.code !== "activation_failed" && i.code !== "gate_unavailable")
      ) {
        const testText = (
          await Promise.all(
            validation.tests.map((test) => readFile(join(dir, test), "utf8").catch(() => "")),
          )
        ).join("\n");
        for (const tool of gate.tools)
          if (!new RegExp(`(^|[^A-Za-z0-9_])${tool}([^A-Za-z0-9_]|$)`).test(testText))
            issues.push({
              code: "tool_untested",
              severity: "error",
              message: `No test uses the tool ${tool}: add a test that calls it`,
              file: "test",
            });
        if (gate.tools.length > tests.passed)
          issues.push({
            code: "tests_too_few",
            severity: "error",
            message: `${tests.passed} test(s) passed for ${gate.tools.length} tools: add at least one test per tool`,
            file: "test",
          });
      }
      displayName = gate.name ?? (typeof probe.name === "string" ? probe.name.trim() : undefined);
      if (issues.some((issue) => issue.severity === "error")) {
        await rm(buildDir, { recursive: true, force: true });
        return finish({
          ok: false,
          tests,
          error: {
            code: "plugin_project_invalid",
            message: "The plugin did not pass Alisio's checks: see the issues",
          },
        });
      }
      const buildRecord: BuildRecord = { file, hash, version };
      await writeFile(join(buildDir, "build.json"), JSON.stringify(buildRecord), { mode: 0o600 });
      if (typeof probe.id === "string" && probe.id !== record.pluginId)
        await this.update(id, (r) => {
          r.pluginId = probe.id as string;
        });
      return finish(
        { ok: true, tests },
        { files: packed.files.length, bytes: packed.bytes, tarballBytes: packed.tarballBytes },
      );
    } finally {
      building.delete(id);
    }
  }

  /** The package of the last successful build, only while it matches the current sources. */
  async packagePath(id: string): Promise<string | undefined> {
    await this.readRecord(id);
    let build: BuildRecord;
    try {
      build = JSON.parse(await readFile(join(this.paths.builds, id, "build.json"), "utf8"));
    } catch {
      return undefined;
    }
    const present = await readFile(build.file).then(
      () => true,
      () => false,
    );
    if (!present) return undefined;
    return (await hashProject(this.dir(id))) === build.hash ? build.file : undefined;
  }

  async status(id: string): Promise<PluginCreatorStatus> {
    const record = await this.get(id);
    const installed = (await installedGlobalPlugins(this.home)).find(
      (item) => item.name === record.packageName,
    );
    const spec = installed
      ? await pluginDependencySpec(join(this.home, "plugins"), record.packageName)
      : undefined;
    return {
      installed: !!installed,
      ...(installed ? { installedVersion: installed.version } : {}),
      local: spec?.startsWith("file:") ?? false,
      projectVersion: record.version,
      updateAvailable: !!installed && installed.version !== record.version,
      packageReady: (await this.packagePath(id)) !== undefined,
    };
  }
}

/** `alisio.icon` of a manifest as a clean project-relative path, or undefined. */
function iconPath(pkg: unknown): string | undefined {
  const declared = (pkg as { alisio?: { icon?: unknown } } | null)?.alisio?.icon;
  if (typeof declared !== "string") return undefined;
  const rel = posix.normalize(declared.replace(/\\/g, "/").replace(/^\.\//, ""));
  if (!rel || rel === "." || rel.startsWith("..") || posix.isAbsolute(rel) || rel.includes("\0"))
    return undefined;
  return rel;
}
