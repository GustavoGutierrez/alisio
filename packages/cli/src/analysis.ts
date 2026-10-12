/**
 * `alisio analysis …` and the analysis line of `alisio doctor`: the state of the Python runtime,
 * the optional extras (`setup --extras`, hash-locked, needs network), the optional container
 * runtime (`setup --oci`) and the retention sweep (`sweep`). None of these is needed to run
 * `python_run`: the base runtime is the discovered Python with only the standard library.
 */
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { AnalysisStatus, EngineDescriptor } from "@alisio/sdk";

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

type Context = Awaited<ReturnType<typeof context>>;

/** The Python backends of this configuration, described with their live readiness. */
function describeBackends(c: Context): (signal?: AbortSignal) => Promise<EngineDescriptor[]> {
  const backends = c.core.createPythonBackends({
    runtime: c.manager,
    oci: { runtime: c.oci, mode: () => c.config.analysis.runtime },
    wasm: { stateRoot: c.stateDir, settings: () => c.config.analysis.wasm },
  });
  return (signal) => c.core.describePythonBackends(backends, signal);
}

/** `alisio forge status` reuses this for its Python lines. */
export async function pythonBackendDescriptors(o: Common): Promise<EngineDescriptor[]> {
  return describeBackends(await context(o))();
}

/** A fixed-width table of the backends: readiness, isolation, profiles and why not. */
export function backendsTable(backends: readonly EngineDescriptor[]): string {
  const rows = backends.map((b) => [
    b.id.replace(/^python-/, ""),
    b.isolation,
    b.ready ? "ready" : "not ready",
    b.profiles?.length ? b.profiles.join(",") : "-",
    b.capabilities.networkDeniedByOS ? "denied" : "open",
    b.reason ?? (b.isolation === "none" ? "host (not sandboxed)" : ""),
  ]);
  const head = ["BACKEND", "ISOLATION", "STATE", "PROFILES", "NETWORK", "NOTE"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(head), ...rows.map(line)].join("\n");
}

/** The unified runtime state and, when Python is missing, the install guidance for this system. */
export async function analysisState(o: Common): Promise<{
  status: AnalysisStatus;
  guidance?: string;
  ignored: string[];
}> {
  const ctx = await context(o);
  const { core, config, provenance, stateDir, manager, oci } = ctx;
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
    backends: describeBackends(ctx),
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
  if (status.backends?.length)
    process.stderr.write(
      `\nPython backends (analysis.runtime=${status.mode}, analysis.isolation=${status.isolation ?? "preferred"}):\n${backendsTable(status.backends)}\n`,
    );
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

export interface WasmSetupDeps {
  /** Replaceable in tests; the global `fetch` otherwise. */
  fetch?: typeof fetch;
  manifest?: import("@alisio/core").PyodideManifest;
  /** Whether someone can answer a question (a terminal). */
  interactive?: boolean;
  ask?: (question: string) => Promise<boolean>;
  write?: (text: string) => void;
}

const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/**
 * `alisio analysis setup --wasm [--profile analysis|science] [--yes]`: the only place the wasm
 * backend uses the network. Downloads the pinned Pyodide distribution into
 * `<analysis dir>/pyodide/<version>/`, verifies every hash and size, and on any mismatch deletes
 * what it fetched and leaves the backend not ready. It never touches the venv or the OCI image.
 */
export async function setupWasm(
  o: Common,
  flags: { profile?: string; yes?: boolean },
  deps: WasmSetupDeps = {},
): Promise<void> {
  const profile = flags.profile ?? "analysis";
  if (profile !== "analysis" && profile !== "science")
    throw new Error("Choose the profile: --profile analysis (default) or --profile science");
  const { core, stateDir } = await context(o);
  const manifest = deps.manifest ?? core.PYODIDE_MANIFEST;
  const write = deps.write ?? ((text: string) => void process.stderr.write(text));
  const dir = core.pyodideDir(stateDir, manifest);
  const bytes = core.pyodideDownloadSize(manifest, profile);
  const hosts = [
    ...new Set(
      [...manifest.core, ...Object.values(manifest.packages)].map((f) => new URL(f.url).host),
    ),
  ];
  write(
    `Pyodide ${manifest.version} (Python ${manifest.python}), profile ${profile}: about ${megabytes(bytes)} from ${hosts.join(", ")}.\n` +
      `It goes to ${dir}. Every file is checked against a pinned SHA-256; this command is the only time the wasm backend uses the network.\n`,
  );
  if (!flags.yes) {
    const interactive = deps.interactive ?? (!!process.stdin.isTTY && !!process.stderr.isTTY);
    if (!interactive)
      throw new Error(
        "This download needs your confirmation: pass --yes in a non-interactive run.",
      );
    const ok = await (deps.ask ?? confirm)("Download now? [y/N] ");
    if (!ok) {
      write("Cancelled; nothing was downloaded.\n");
      return;
    }
  }
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort(new Error("Interrupted")));
  try {
    const result = await core.installPyodide({
      dir,
      profile,
      manifest,
      signal: controller.signal,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      onProgress: (e) => write(`  [${e.index}/${e.total}] ${e.file}\n`),
    });
    write(
      `Pyodide ${manifest.version} is ready (profile ${result.ok ? result.profile : profile}). ` +
        'With analysis.runtime "auto" it is used when no container is ready; set analysis.runtime to "wasm" to require it.\n',
    );
  } catch (error) {
    const integrity = error instanceof core.PyodideIntegrityError;
    write(
      `${error instanceof Error ? error.message : String(error)}\n` +
        (integrity
          ? "Nothing from this download was kept. The wasm backend is not ready.\n"
          : "Nothing from this download was kept.\n"),
    );
    process.exitCode = 1;
  }
}
