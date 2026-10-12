/**
 * The Python topics of `forge_guide` (spec §8.3; Python spec §4.3, §6, §7, §8): `python.runtime`,
 * `python.data`, `python.ml`, `python.dashboards` and `python.environment`. Pure functions of a
 * `PythonEnvironment` snapshot: the backend the selector would choose right now and what that
 * backend really provides. No guide ever claims a guarantee the chosen backend does not give.
 */
import type { PythonBackendId } from "../python/backend.ts";

export type PackageKnowledge =
  /** The packages this backend provides right now (a distribution name each). */
  | { known: true; packages: string[]; detail: string }
  /** The backend's packages cannot be listed from here (a container image). */
  | { known: false; detail: string };

export type PythonEnvironment =
  | {
      available: true;
      backend: PythonBackendId;
      /** Why the selector chose it (its own `reason`). */
      reason: string;
      packages: PackageKnowledge;
      /** `analysis.smartDashboard`: `dashboard_generate` exists. */
      smartDashboard: boolean;
    }
  | {
      available: false;
      /** The selector's message: every backend's reason and the shortest fix. */
      reason: string;
      smartDashboard: boolean;
    };

/** Python spec §4.3, one row per backend; the guide never states more than this. */
const GUARANTEES: Readonly<Record<PythonBackendId, readonly string[]>> = {
  managed: [
    "Isolation: none. The script runs with your user permissions: it can read your files and use the network.",
    "Termination: the process is killed on timeout. Memory: no hard limit.",
  ],
  oci: [
    "Isolation: os-container. Network off (`--network=none`); only the job folders are mounted (the scratchpad read-only).",
    "Termination: the container is killed on timeout. Memory: hard limit (cgroup).",
  ],
  wasm: [
    "Isolation: wasm-process (Pyodide in a restricted Node process). It reads only the Pyodide distribution and the job, and writes only its work/ and out/ folders.",
    "Network: NOT blocked by the OS on Node 22/24; do not rely on it being off. Memory: soft limit (RSS watchdog). Termination: the process is killed on timeout.",
  ],
};

const SETUP_NOTE =
  "Setup commands are run by the user, never by you: `alisio analysis setup --wasm [--profile analysis|science]` or `alisio analysis setup --oci`.";

const has = (env: PythonEnvironment, pkg: string): boolean | undefined => {
  if (!env.available) return false;
  if (!env.packages.known) return undefined;
  return env.packages.packages.includes(pkg);
};

/** What the model should know about one package group right now. */
function availability(env: PythonEnvironment, pkgs: readonly string[]): string {
  const states = pkgs.map((pkg) => has(env, pkg));
  if (states.every((s) => s === true)) return "available";
  if (states.every((s) => s === undefined))
    return "depends on the container image (not listed here)";
  const missing = pkgs.filter((_, i) => states[i] === false);
  return `NOT available (${missing.join(", ")} missing)`;
}

function installAdvice(env: PythonEnvironment & { available: true }, profile: string): string {
  if (env.backend === "wasm")
    return `ask the user to run \`alisio analysis setup --wasm --profile ${profile}\``;
  if (env.backend === "managed")
    return `pass \`extras: ["${profile}"]\` (the user approves the download once)`;
  return "use an image that includes them (`analysis.oci.image`)";
}

export function pythonRuntimeGuide(env: PythonEnvironment): string {
  return [
    "# python_run runtime",
    "",
    "Your script runs once in a job folder outside the repository, with `main.py` as the entry. The helper package `alisio_runtime` (standard library only) is importable.",
    "",
    "## Folders (environment variables)",
    "- `ALISIO_OUTPUT_DIR`: everything written here is published as a downloadable artifact only if the script exits 0 (`publishOnError` keeps partial output). Publication is validated by the host: paths, sizes and types. An `outputs.json` limits publishing to the files it declares.",
    "- `ALISIO_INPUT_DIR`: read-only copies of `inputs`. `ALISIO_WORK_DIR`: scratch, also the current directory.",
    "- `ALISIO_SCRATCH_DIR`: the session scratchpad, READ-ONLY (write scripts there with the file tools, run them with `codePath`).",
    "- `ALISIO_EXECUTION_ID` identifies the run. `ALISIO_FORGE_*` belong to the protocol: never print them or fake their lines.",
    "",
    "## alisio_runtime",
    "- `output_dir()`, `input_dir()`, `work_dir()`, `execution_id()`; `outputs.path(name)` makes a new output path, `outputs.declare(name, title)` registers it.",
    "- `forge.progress(message, completed=, total=)`, `forge.text(value)` (explicit output for you), `forge.result(value)` (the final JSON value), `forge.state.get/set/delete` (small JSON shared with js_run; kept only if the run succeeds).",
    "- `datasets`, `html`, `charts`, `svg`: see `python.data` and `python.dashboards`.",
    "",
    "## Rules",
    "- Print little: stdout and stderr return only their last 4 KB. Use `forge.text`/`forge.result` for what you need to read.",
    "- No nested tool calls and no JavaScript from Python. Chain tools yourself, or compose with `js_run` first.",
    "- Keep each script short; save long ones to the scratchpad. Rerun an earlier analysis unchanged with `rerunOf`.",
    `- Packages depend on the backend: see \`python.environment\` (now: ${env.available ? env.backend : "no backend can run"}).`,
  ].join("\n");
}

export function pythonDataGuide(env: PythonEnvironment): string {
  const pandas = availability(env, ["pandas"]);
  return [
    "# Data in python_run",
    "",
    "## Which tool",
    "- A SQL question on a loaded dataset: `data_query` (no code, read-only). Use `data_inspect` first for tables and columns.",
    "- Joins across files, statistics, models, exports, or anything SQL cannot do: `python_run`.",
    "",
    "## Inputs",
    "- `inputs: [{ datasetId }]` copies a dataset to `$ALISIO_INPUT_DIR/<name>.sqlite`; `inputs: [{ path }]` copies a workspace file.",
    "- `from alisio_runtime import datasets`: `datasets.inputs()` lists what was placed; `datasets.open(name)` returns a read-only `sqlite3` connection (table `data`, or `s_<sheet>` for workbooks); `datasets.tables(name)` and `datasets.columns(name, table)` describe them.",
    "- XLSX files are converted to SQLite by `alisio_runtime/xlsx_to_sqlite.py` (standard library `sqlite3`); you rarely need to call it yourself.",
    "",
    "## pandas",
    `- pandas is ${pandas} on the backend that would run now.`,
    "- Without pandas use `sqlite3`, `csv`, `statistics` and `json` from the standard library.",
    '- `pandas.read_sql_query("SELECT * FROM data", datasets.open(name))` loads a dataset.',
    ...(env.available && env.backend === "wasm"
      ? ["- The wasm backend limits the total input size (`analysis.wasm.maxInputBytes`)."]
      : []),
  ].join("\n");
}

export function pythonMlGuide(env: PythonEnvironment): string {
  const science = availability(env, ["scipy", "statsmodels", "scikit-learn"]);
  const where = env.available
    ? `Backend that would run now: ${env.backend}.`
    : "No Python backend can run right now (see `python.environment`).";
  return [
    "# Statistics and machine learning",
    "",
    where,
    `- scikit-learn, statsmodels and scipy are ${science}.`,
    ...(env.available && has(env, "scikit-learn") === false
      ? [`- To get them: ${installAdvice(env, "science")}.`]
      : []),
    "",
    "## Patterns",
    "- Split first: `train_test_split(X, y, test_size=0.2, random_state=0)`; fix `random_state` so a rerun gives the same numbers.",
    "- Tabular baseline: `sklearn.ensemble.RandomForestClassifier` or `sklearn.linear_model.LogisticRegression`; report accuracy AND a baseline (majority class) with `forge.result({...})`.",
    "- Inference and tests: `scipy.stats.ttest_ind`, `chi2_contingency`; regression with coefficients and p-values: `statsmodels.api.OLS(y, sm.add_constant(X)).fit().summary()`.",
    '- Return numbers, not objects: `forge.result({"r2": float(r2), "n": int(n)})`. JSON cannot hold NaN or Infinity; convert them first.',
    "- Keep a time budget in mind: heavy training can exceed the call's timeout. Subsample first, then scale up.",
    "- Pandas first, then models; without the science packages use the standard library `statistics` for descriptive work.",
  ].join("\n");
}

export function pythonDashboardsGuide(env: PythonEnvironment): string {
  const plotly = availability(env, ["plotly"]);
  const matplotlib = availability(env, ["matplotlib"]);
  return [
    "# Charts and dashboards",
    "",
    ...(env.smartDashboard
      ? [
          "- A standard dashboard from a dataset: `dashboard_generate` (no code). Use `python_run` only for visuals its catalog does not cover.",
        ]
      : ["- `dashboard_generate` is not enabled here: build dashboards with `alisio_runtime`."]),
    "",
    "## alisio_runtime (no extra packages)",
    "- `charts`: Chart.js is bundled. `charts.pie/donut/bar/hbar/line/area/scatter(labels, values, title=, fmt='currency:USD', locale=)` return HTML; compose with `charts.card(title, chart)`, `charts.grid(*cards)`, `charts.kpis((label, value), ...)`, then `charts.write('dashboard.html', 'Title', body)`.",
    "- `html`: `html.page/table/write` for plain reports. `svg`: static SVG, no script.",
    "- Never hand-write SVG arcs, never load a CDN: HTML is shown offline, so inline every script and style. One chart per card; pie only for 2 to 5 parts.",
    "",
    "## Static images",
    `- matplotlib is ${matplotlib}. It runs with the Agg backend: save a PNG with \`fig.savefig(output_dir() / 'chart.png', dpi=150)\`; \`plt.show()\` does nothing.`,
    `- plotly is ${plotly}. Write a self-contained file with \`fig.write_html(path, include_plotlyjs=True)\` (several MB); prefer \`charts\` when it is enough.`,
    "",
    "A folder under the output directory with an `index.html` is published as one multi-file dashboard.",
  ].join("\n");
}

export function pythonEnvironmentGuide(env: PythonEnvironment): string {
  if (!env.available)
    return [
      "# Python environment",
      "",
      "No Python backend can run a script right now.",
      "",
      env.reason,
      "",
      SETUP_NOTE,
      "Until one is ready, use `js_run` or the dataset tools (`data_inspect`, `data_query`).",
    ].join("\n");
  const packages = env.packages.known
    ? env.packages.packages.length
      ? env.packages.packages.join(", ")
      : "none beyond the standard library"
    : "those baked into the container image (not listed here)";
  return [
    "# Python environment",
    "",
    `Backend that runs your next script: ${env.backend} (${env.reason}).`,
    "",
    "## Guarantees of this backend",
    ...GUARANTEES[env.backend].map((line) => `- ${line}`),
    "",
    "## Packages here",
    `- Standard library and \`alisio_runtime\` always. ${env.packages.detail}`,
    `- Installed: ${packages}.`,
    "- Anything else fails with `PACKAGE_UNAVAILABLE`/`ModuleNotFoundError` and is never retried on another backend.",
    ...(env.packages.known && !env.packages.packages.includes("scikit-learn")
      ? ["", `For scikit-learn, statsmodels and scipy: ${installAdvice(env, "science")}.`]
      : []),
    "",
    SETUP_NOTE,
  ].join("\n");
}
