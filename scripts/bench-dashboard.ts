/**
 * Manual dashboard benchmark (spec smart-dashboard §11.1). NOT part of `pnpm check`: it calls a
 * real model and costs tokens. Run it from the repository root after `pnpm build`:
 *
 *   ALISIO_BENCH_MODEL=<model> ALISIO_BENCH_BASE_URL=<https://host/v1> \
 *   OPENAI_API_KEY=<key> \
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/bench-dashboard.ts
 *
 * The key is read by Alisio itself (the provider's `apiKeyEnv`); this script never reads, prints or
 * stores it. Every variant of one results file uses the same model; results go to
 * `docs/benchmark-dashboard.json` (model and endpoint HOST only).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type BenchResults,
  BenchUsageError,
  buildResults,
  DATASET_KINDS,
  DATASET_SIZES,
  DatasetChangedError,
  type DatasetKind,
  DEFAULT_SEED,
  type Lang,
  mergeResults,
  PARAMS_USAGE,
  probeSmartDashboardSupport,
  REAL_DATASETS,
  readBenchParams,
  runSeries,
  SeriesDiscardedError,
  serializeBenchResults,
  VARIANTS,
  type Variant,
} from "./bench/lib.ts";

const USAGE = `Usage: bench-dashboard.ts [options]

Environment (required): ALISIO_BENCH_MODEL, ALISIO_BENCH_BASE_URL
  ${PARAMS_USAGE}

Options:
  --variants <A,B,C>   Variants to run (default A; B and C need analysis.smartDashboard)
  --repeats <n>        Repetitions per dataset and variant (default 3)
  --lang <en|es>       Prompt language (default en)
  --kinds <list>       Generated datasets (default sales,operations,inventory,opaque)
  --sizes <list>       Generated row counts (default ${DATASET_SIZES.join(",")})
  --real <list|none>   Real datasets (default all: ${REAL_DATASETS.map((d) => d.id).join(",")})
  --plugin <path>      Plugin loaded by variant C (repeatable or comma list), e.g. the extracted
                       @alisio/plugin-laya/dist/index.js; C requires it. Share one Laya runtime between runs
                       with ALISIO_LAYA_HOME=<abs dir> (already set up with /laya:setup)
  --out <file>         Results file (default docs/benchmark-dashboard.json)
  --command <cmd>      How to start Alisio (default: node packages/cli/dist/main.js)
  --timeout-min <n>    Per-run limit in minutes (default 15)
  --keep               Keep the temp folder
  -h, --help           This text
`;

const list = (value: string | undefined, fallback: string[]) =>
  value
    ? value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
    : fallback;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      variants: { type: "string" },
      repeats: { type: "string" },
      lang: { type: "string" },
      kinds: { type: "string" },
      sizes: { type: "string" },
      real: { type: "string" },
      out: { type: "string" },
      plugin: { type: "string", multiple: true },
      command: { type: "string" },
      "timeout-min": { type: "string" },
      keep: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const params = readBenchParams(process.env);
  const variants = list(values.variants, ["A"]) as Variant[];
  for (const v of variants)
    if (!VARIANTS.includes(v)) throw new BenchUsageError(`Unknown variant ${v}.`);
  const kinds = list(values.kinds, ["sales", "operations", "inventory", "opaque"]) as DatasetKind[];
  for (const k of kinds)
    if (!DATASET_KINDS.includes(k)) throw new BenchUsageError(`Unknown dataset ${k}.`);
  const sizes = list(values.sizes, DATASET_SIZES.map(String)).map(Number);
  if (sizes.some((n) => !Number.isInteger(n) || n < 1))
    throw new BenchUsageError("Invalid --sizes.");
  const repeats = Number(values.repeats ?? 3);
  if (!Number.isInteger(repeats) || repeats < 1) throw new BenchUsageError("Invalid --repeats.");
  const lang = (values.lang ?? "en") as Lang;
  if (lang !== "en" && lang !== "es") throw new BenchUsageError("--lang must be en or es.");
  const realIds =
    values.real === "none"
      ? []
      : list(
          values.real,
          REAL_DATASETS.map((d) => d.id),
        );
  const real = realIds.map((id) => {
    const found = REAL_DATASETS.find((d) => d.id === id);
    if (!found) throw new BenchUsageError(`Unknown real dataset ${id}.`);
    return found;
  });
  const command = values.command
    ? values.command.split(/\s+/).filter(Boolean)
    : [process.execPath, resolve("packages/cli/dist/main.js")];
  if (!values.command && !existsSync(command[1] as string))
    throw new BenchUsageError(
      "packages/cli/dist/main.js not found: run `pnpm build` first or pass --command.",
    );
  const plugins = (values.plugin ?? []).flatMap((v) => list(v, [])).map((p) => resolve(p));
  if (variants.includes("C") && plugins.length === 0)
    throw new BenchUsageError(
      "Variant C needs --plugin <path to the entry file of @alisio/plugin-laya (dist/index.js)>: the isolated config home sees no global plugins.",
    );
  const out = resolve(values.out ?? "docs/benchmark-dashboard.json");

  const probeDir = mkdtempSync(join(tmpdir(), "alisio-bench-probe-"));
  const supportsSmartDashboard = await probeSmartDashboardSupport({
    command,
    env: process.env,
    dir: probeDir,
  });
  rmSync(probeDir, { recursive: true, force: true });
  const version = spawnSync(command[0] as string, [...command.slice(1), "--version"], {
    encoding: "utf8",
  });
  const alisioVersion = version.status === 0 ? version.stdout.trim() : "unknown";

  const runs = await runSeries({
    command,
    params,
    variants,
    kinds,
    sizes,
    real,
    repeats,
    lang,
    supportsSmartDashboard,
    plugins,
    env: process.env,
    keep: values.keep ?? false,
    ...(values["timeout-min"] ? { timeoutMs: Number(values["timeout-min"]) * 60_000 } : {}),
    onProgress: (message) => process.stderr.write(`[bench] ${message}\n`),
  });
  const existing = existsSync(out)
    ? (JSON.parse(readFileSync(out, "utf8")) as BenchResults)
    : undefined;
  const merged = mergeResults(
    existing,
    buildResults({
      params,
      alisioVersion,
      seed: DEFAULT_SEED,
      runs,
      generatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(out, serializeBenchResults(merged, process.env));
  process.stderr.write(`[bench] wrote ${out}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof BenchUsageError) {
      process.stderr.write(`${message}\n\n${USAGE}`);
      process.exit(2);
    }
    process.stderr.write(
      `${error instanceof SeriesDiscardedError || error instanceof DatasetChangedError ? "" : "bench failed: "}${message}\n`,
    );
    process.exit(1);
  },
);
