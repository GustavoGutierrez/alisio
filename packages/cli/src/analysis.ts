/**
 * `alisio analysis …` and the analysis line of `alisio doctor`: the state of the Python runtime,
 * the optional extras (`setup --extras`, hash-locked, needs network), the optional container
 * runtime (`setup --oci`) and the retention sweep (`sweep`). None of these is needed to run
 * `python_run`: the base runtime is the discovered Python with only the standard library.
 */
import { dirname, join } from "node:path";
import type { AnalysisStatus } from "@alisio/sdk";

type Common = {
  db?: string;
  python?: string;
  cwd?: string;
  config?: string;
  trustProject?: boolean;
};

async function context(o: Common) {
  const core = await import("@alisio/core");
  const workspace = await core.findWorkspace(o.cwd ?? process.cwd());
  const { config, provenance } = await core.loadConfigWithProvenance(workspace, {
    file: o.config,
    trustProject: o.trustProject,
  });
  const stateDir = o.db && o.db !== ":memory:" ? dirname(o.db) : core.stateHome();
  const manager = new core.AnalysisRuntimeManager({
    stateDir,
    ...(o.python ? { python: o.python } : {}),
  });
  const oci = () => new core.OciRuntime({ ...config.analysis.oci });
  return { core, config, provenance, stateDir, manager, oci };
}

/** The unified runtime state and, when Python is missing, the install guidance for this system. */
export async function analysisState(o: Common): Promise<{
  status: AnalysisStatus;
  guidance?: string;
  ignored: string[];
}> {
  const { core, config, provenance, stateDir, manager, oci } = await context(o);
  const janitor = {
    lastSweep: () =>
      import("node:fs/promises")
        .then((fs) => fs.readFile(join(stateDir, "analysis", ".last-sweep"), "utf8"))
        .then((text) => {
          const value = Number(text.trim());
          return Number.isFinite(value) ? value : undefined;
        })
        .catch(() => undefined),
  };
  const status = await core.analysisStatus({
    config: config.analysis,
    runtime: manager,
    oci,
    janitor,
    enabled: config.analysis.enabled,
    readOnly: false,
  });
  const guidance = status.python.found
    ? undefined
    : (async () => {
        const resolved = await manager.interpreter();
        return resolved.ok
          ? undefined
          : core.installHintsText(
              core.pythonInstallHints(await core.detectHintHost(resolved.found)),
            );
      })();
  return {
    status,
    ...(guidance ? { guidance: await guidance } : {}),
    ignored: provenance.ignored ?? [],
  };
}

/** Prints `alisio analysis status`. */
export async function printAnalysisStatus(o: Common): Promise<void> {
  const { status, guidance, ignored } = await analysisState(o);
  console.log(JSON.stringify(status, null, 2));
  if (guidance) process.stderr.write(`\n${guidance}\n`);
  if (status.mode === "oci" && status.oci.available === false)
    process.stderr.write(
      `\nThe container runtime is configured but not usable: ${status.oci.reason ?? "unknown reason"}\n`,
    );
  for (const key of ignored)
    process.stderr.write(
      `\nIgnored ${key} from the project configuration: only your user configuration decides it.\n`,
    );
}

/** `alisio analysis setup --extras analysis|science`: needs network; offline it fails cleanly. */
export async function setupExtras(o: Common, extras: string | undefined): Promise<void> {
  if (extras !== "analysis" && extras !== "science")
    throw new Error("Choose the extras to install: --extras analysis or --extras science");
  const { core, manager } = await context(o);
  const preview = core.installPreview(extras);
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort(new Error("Interrupted")));
  process.stderr.write(
    `Installing the ${extras} extras: ${preview.packages.join(", ")} (+ dependencies, ${preview.packageCount} packages, about ${Math.round(preview.estimatedBytes / (1024 * 1024))} MB). ` +
      "Wheels only, hashes required, needs network.\n",
  );
  try {
    const state = await manager.installExtras(extras, {
      signal: controller.signal,
      onOutput: (text) => process.stderr.write(text),
    });
    console.log(JSON.stringify(state, null, 2));
  } catch (error) {
    // A clean message and a failing exit code; the base runtime is untouched.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * `alisio analysis setup --oci [--image <name>]`: pulls the image once and verifies it. With a
 * digest-pinned reference the pull verifies the digest; with a tag it prints the digest to put in
 * `analysis.oci.image` (Alisio never writes it: only you choose what runs your code).
 */
export async function setupOci(o: Common, image: string | undefined): Promise<void> {
  const { core, config } = await context(o);
  const reference = image ?? config.analysis.oci.image;
  if (!reference)
    throw new Error(
      "Pass --image <name[:tag]> (or set analysis.oci.image in your user configuration) to pull.",
    );
  const runtime = new core.OciRuntime({ ...config.analysis.oci, image: undefined });
  const status = await runtime.status();
  if (!status.ok)
    throw new Error(
      `${status.reason}${status.alternative ? `; ${status.alternative} is installed (set analysis.oci.engine to "${status.alternative}")` : ""}. The container runtime is optional; python_run works without it.`,
    );
  process.stderr.write(`Pulling ${reference} with ${status.engine} ${status.version}…\n`);
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort(new Error("Interrupted")));
  const { digest } = await runtime.pull(reference, controller.signal);
  const pinned = core.OCI_IMAGE_PATTERN.test(reference);
  if (pinned) {
    const wanted = reference.slice(reference.indexOf("@") + 1);
    if (digest && !digest.endsWith(wanted))
      throw new Error(`The pulled image reports ${digest}, not the pinned ${wanted}`);
    console.log(`Verified ${reference}. Set analysis.runtime to "oci" to use it.`);
  } else if (digest)
    console.log(
      `Pulled ${reference}. To use it, put this in your user configuration (${core.configHome()}):\n` +
        `  "analysis": { "runtime": "oci", "oci": { "engine": "${status.engine}", "image": "${digest}" } }`,
    );
  else
    throw new Error(
      `${reference} has no repository digest (a locally built image?). Push it to a registry or pull a published image.`,
    );
}

/** `alisio analysis sweep [--force]`: the retention sweep now (it also runs by itself, daily). */
export async function sweep(o: Common, force: boolean): Promise<void> {
  const { core, config, stateDir } = await context(o);
  const store = new core.SQLiteStore(o.db ?? join(stateDir, "sessions.sqlite"));
  try {
    const artifacts = new core.ArtifactStore({ root: stateDir, db: store.db });
    const datasets = new core.DatasetService({ root: stateDir, db: store.db });
    const blobs = new core.BlobStore({ root: join(stateDir, "blobs"), db: store.db });
    const janitor = new core.AnalysisJanitor({
      root: stateDir,
      db: store.db,
      artifacts,
      datasets,
      blobs,
      retention: () => config.analysis.retention,
    });
    const report = await janitor.sweep({ force });
    console.log(JSON.stringify(report, null, 2));
    datasets.close();
  } finally {
    store.close();
  }
}
