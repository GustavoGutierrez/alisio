/**
 * Re-records the cassettes of the bundled reliability-lab suites (specs/010 Phase 5).
 *
 *   pnpm eval:record-bundled [--tasks suite/task,suite/task] [--out DIR]
 *
 * The cassettes are NOT recorded from a live model. They are recorded from the deterministic turn
 * scripts below: a scripted provider that answers each call with a fixed list of tool calls, as an
 * ideal model would. That pins what the HARNESS does (the instructions, tool definitions and
 * messages it sends, how it executes the calls, the verifiers) against a fixed model, so CI can
 * replay them with no network and no credentials. It says nothing about the quality of any real
 * model. To record a real model with your own provider use `alisio eval record <suite>`.
 *
 * Re-record whenever the harness changes what it asks of the provider on purpose (a tool
 * description, the system instructions, a default). Running this command twice writes
 * byte-identical files: the header carries `recordedAt: 0` and ids come from a seeded source.
 *
 * Runs with `node --conditions=alisio-source --experimental-transform-types` (see the package.json
 * script): it imports the core and CLI sources, which use parameter properties.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { EvalRunRecord, ModelProvider, ProviderEvent, ToolCall, Usage } from "@alisio/sdk";
import { BUILTIN_PLUGINS } from "../packages/cli/src/builtin.ts";
import {
  CASSETTE_SUFFIX,
  type Cassette,
  CassetteRecorder,
} from "../packages/core/src/eval/cassette.ts";
import type { InvokerPermissions } from "../packages/core/src/eval/engine.ts";
import {
  type BuiltinPlugin,
  configSchema,
  loadSuite,
  runTask,
  writeCassette,
} from "../packages/core/src/index.ts";

/** `tests/fixtures/eval` of this checkout. */
export const BUNDLED_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../tests/fixtures/eval",
);

/** What the cassette headers say the model was. */
export const SCRIPT_PROVIDER_ID = "scripted";
export const SCRIPT_MODEL = "scripted-reference-v1";

// ---------------------------------------------------------------------------------------------
// The scripted provider
// ---------------------------------------------------------------------------------------------

type Request = Parameters<ModelProvider["stream"]>[0];

export interface ScriptedTurn {
  text?: string;
  calls?: Array<{ name: string; args: Record<string, unknown> }>;
}

/** What a dynamic turn may look at: every tool result of the conversation so far, in order. */
export interface TurnContext {
  /** JSON-parsed text of the tool results (the text itself when it is not JSON). */
  results: unknown[];
}

export type ScriptTurn = ScriptedTurn | ((context: TurnContext) => ScriptedTurn);

const TURN_USAGE: Usage = { input: 1000, output: 100 };

function toolResults(request: Request): unknown[] {
  return request.messages.flatMap((message) => {
    if (message.role !== "tool") return [];
    const text = message.result.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    try {
      return [JSON.parse(text) as unknown];
    } catch {
      return [text];
    }
  });
}

/** Answers call N with turn N. Asking for more calls than scripted is an error, never a repeat. */
export function scriptProvider(turns: ScriptTurn[]): ModelProvider {
  let call = 0;
  return {
    id: SCRIPT_PROVIDER_ID,
    model: SCRIPT_MODEL,
    async *stream(request): AsyncGenerator<ProviderEvent> {
      const index = call++;
      const turn = turns[index];
      if (turn === undefined)
        throw new Error(
          `The turn script has no turn ${index}: it asked for more calls than scripted.`,
        );
      const resolved = typeof turn === "function" ? turn({ results: toolResults(request) }) : turn;
      const calls: ToolCall[] = (resolved.calls ?? []).map((c, n) => ({
        id: `call-${index}-${n}`,
        name: c.name,
        arguments: JSON.stringify(c.args),
      }));
      if (resolved.text) yield { type: "text_delta", delta: resolved.text };
      yield {
        type: "completed",
        message: { role: "assistant", text: resolved.text ?? "", calls },
        usage: TURN_USAGE,
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Script helpers
// ---------------------------------------------------------------------------------------------

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The pristine text of a fixture file, so the scripts never hard-code a hash that can go stale. */
function fixture(suite: string, task: string, path: string): string {
  return readFileSync(join(BUNDLED_DIR, suite, "fixtures", task, path), "utf8");
}

const read = (path: string): ScriptedTurn => ({ calls: [{ name: "read_file", args: { path } }] });
const done = (text: string): ScriptedTurn => ({ text });

function edit(path: string, oldText: string, newText: string, before: string): ScriptedTurn {
  return {
    calls: [{ name: "edit_file", args: { path, oldText, newText, expectedHash: sha256(before) } }],
  };
}

function write(path: string, content: string, before: string | null): ScriptedTurn {
  return {
    calls: [
      {
        name: "write_file",
        args: { path, content, expectedHash: before === null ? null : sha256(before) },
      },
    ],
  };
}

/** The id of the background task a `bg_run` result reported. */
function taskIdOf(context: TurnContext): string {
  for (const result of context.results) {
    const id = (result as { id?: unknown } | null)?.id;
    if (typeof id === "string") return id;
  }
  throw new Error("bg_run did not return a task id.");
}

// ---------------------------------------------------------------------------------------------
// The turn scripts, one per bundled task ("<suite>/<task>")
// ---------------------------------------------------------------------------------------------

const SMOKE = "smoke-coding";
const SEQ = "tool-sequences";
const LONG = "long-context";

// rename-symbol ---------------------------------------------------------------------------------

const RENAME_FILES = [
  "src/api.ts",
  "src/index.ts",
  "src/cache.ts",
  "src/service.ts",
  "src/cli.ts",
  "src/lazy.ts",
  "src/legacy.ts",
];
/** `legacy.ts` has its own unrelated `fetchUser` method: a correct rename never touches it. */
const RENAME_TO_REWRITE = RENAME_FILES.filter((path) => path !== "src/legacy.ts");

/** The function and every reference to it; not the metric key, not look-alike names. */
const renameFunction = (text: string) => text.replace(/\bfetchUser\b(?!\.calls)/g, "loadUser");

function renameWrites(paths: string[], rewrite: (text: string, path: string) => string) {
  return paths.map((path) => {
    const before = fixture(SMOKE, "rename-symbol", path);
    return write(path, rewrite(before, path), before);
  });
}

// edit-respects-hash ----------------------------------------------------------------------------

/** One `edit_file` per change, each with the hash the previous edit left behind. */
function editRespectsHashScript(options: { skipLimits?: boolean } = {}): ScriptTurn[] {
  const task = "edit-respects-hash";
  const defaults = fixture(SMOKE, task, "src/defaults.ts");
  const limits = fixture(SMOKE, task, "src/limits.ts");
  const head = "httpDefaults = {\r\n  retries: ";
  const steps = [
    [`${head}3,`, `${head}5,`],
    ["retries: 5,\r\n  timeoutMs: 3000,", "retries: 5,\r\n  timeoutMs: 8000,"],
    ['timeoutMs: 8000,\r\n  backoff: "linear",', 'timeoutMs: 8000,\r\n  backoff: "exponential",'],
  ] as const;
  const turns: ScriptTurn[] = [read("src/defaults.ts"), read("src/limits.ts")];
  let current = defaults;
  for (const [from, to] of steps) {
    turns.push(edit("src/defaults.ts", from, to, current));
    current = current.replace(from, to);
  }
  if (!options.skipLimits)
    turns.push(
      edit(
        "src/limits.ts",
        "uploadLimits = {\n  maxBodyKb: 256,",
        "uploadLimits = {\n  maxBodyKb: 512,",
        limits,
      ),
    );
  turns.push(done("httpDefaults and uploadLimits are updated."));
  return turns;
}

// off-by-one-among-passing ----------------------------------------------------------------------

interface PaginationFixes {
  /** Fix ceilDiv itself (the root cause of the visible failure). */
  root?: boolean;
  /** An empty list has one page. */
  empty?: boolean;
  /** Pages below 1 are page 1. */
  clamp?: boolean;
  /** pageRange stops at itemCount and handles the empty list. */
  range?: boolean;
  /** pagesRemaining is never negative. */
  remaining?: boolean;
}

/** Edits for the chosen fixes; `patchTotalPages` fixes the visible symptom in totalPages instead. */
function paginationFixes(fixes: PaginationFixes, patchTotalPages = false): ScriptTurn[] {
  const task = "off-by-one-among-passing";
  const turns: ScriptTurn[] = [];
  if (fixes.root) {
    const math = fixture(SMOKE, task, "src/math.ts");
    turns.push(edit("src/math.ts", "Math.floor(a / b) + 1", "Math.ceil(a / b)", math));
  }
  let paginate = fixture(SMOKE, task, "src/paginate.ts");
  const change = (from: string, to: string) => {
    turns.push(edit("src/paginate.ts", from, to, paginate));
    paginate = paginate.replace(from, to);
  };
  if (patchTotalPages)
    change("return ceilDiv(itemCount, pageSize);", "return Math.ceil(itemCount / pageSize);");
  if (fixes.empty)
    change(
      "return ceilDiv(itemCount, pageSize);",
      "return Math.max(1, ceilDiv(itemCount, pageSize));",
    );
  if (fixes.clamp)
    change(
      "const start = (page - 1) * pageSize;",
      "const start = (Math.max(1, page) - 1) * pageSize;",
    );
  if (fixes.range)
    change(
      "return { from: (page - 1) * pageSize + 1, to: page * pageSize };",
      "if (itemCount === 0) return { from: 0, to: 0 };\n  return { from: (page - 1) * pageSize + 1, to: Math.min(itemCount, page * pageSize) };",
    );
  if (fixes.remaining)
    turns.push(
      edit(
        "src/summary.ts",
        "return ceilDiv(itemCount, pageSize) - page;",
        "return Math.max(0, ceilDiv(itemCount, pageSize) - page);",
        fixture(SMOKE, task, "src/summary.ts"),
      ),
    );
  return turns;
}

export const REFERENCE_SCRIPTS: Record<string, ScriptTurn[]> = {
  // smoke-coding ------------------------------------------------------------------------------
  [`${SMOKE}/fix-add`]: [
    read("src/math.ts"),
    edit("src/math.ts", "a - b", "a + b", fixture(SMOKE, "fix-add", "src/math.ts")),
    done("add now sums its arguments."),
  ],
  [`${SMOKE}/add-slugify`]: [
    read("src/strings.ts"),
    write(
      "src/strings.ts",
      `${fixture(SMOKE, "add-slugify", "src/strings.ts")}export const slugify = (s: string) =>\n  s\n    .trim()\n    .toLowerCase()\n    .replace(/[^a-z0-9]+/g, "-")\n    .replace(/^-+|-+$/g, "");\n`,
      fixture(SMOKE, "add-slugify", "src/strings.ts"),
    ),
    done("slugify added."),
  ],
  [`${SMOKE}/implement-chunk`]: [
    read("src/list.ts"),
    write(
      "src/list.ts",
      "export function chunk<T>(items: T[], size: number): T[][] {\n  const out: T[][] = [];\n  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));\n  return out;\n}\n",
      fixture(SMOKE, "implement-chunk", "src/list.ts"),
    ),
    done("chunk implemented."),
  ],
  [`${SMOKE}/rename-symbol`]: [
    ...RENAME_FILES.map((path) => read(path)),
    ...renameWrites(RENAME_TO_REWRITE, renameFunction),
    done("fetchUser is now loadUser where it is defined, re-exported and used."),
  ],
  [`${SMOKE}/edit-respects-hash`]: editRespectsHashScript(),
  [`${SMOKE}/bug-across-modules`]: [
    read("src/order.ts"),
    read("src/format.ts"),
    read("src/money.ts"),
    edit(
      "src/money.ts",
      "Math.floor(amount * 100)",
      "Math.round(amount * 100)",
      fixture(SMOKE, "bug-across-modules", "src/money.ts"),
    ),
    done("toCents rounded down; it now rounds to the nearest cent."),
  ],
  [`${SMOKE}/off-by-one-among-passing`]: [
    read("checks/paginate.check.mjs"),
    read("src/paginate.ts"),
    read("src/math.ts"),
    read("src/summary.ts"),
    ...paginationFixes({ root: true, empty: true, clamp: true, range: true, remaining: true }),
    done("ceilDiv rounds up and the documented edge cases of the pagination module hold."),
  ],

  // tool-sequences ----------------------------------------------------------------------------
  [`${SEQ}/read-before-edit`]: [
    read("src/version.ts"),
    edit("src/version.ts", "1.0.0", "1.1.0", fixture(SEQ, "read-before-edit", "src/version.ts")),
    done("Version bumped to 1.1.0."),
  ],
  [`${SEQ}/stop-bg-before-delete`]: [
    {
      calls: [
        {
          name: "bg_run",
          args: { command: "node server.js", cwd: "work", label: "server", timeoutMs: 60000 },
        },
      ],
    },
    (context) => ({ calls: [{ name: "bg_stop", args: { id: taskIdOf(context) } }] }),
    { calls: [{ name: "shell", args: { command: "rm -rf work" } }] },
    done("The server was stopped and work/ was removed."),
  ],
  [`${SEQ}/no-repeat-failed-call`]: [
    read("settings.local.json"),
    read("settings.example.json"),
    write("settings.local.json", '{ "theme": "dark", "retries": 5 }\n', null),
    done("settings.local.json created with retries 5."),
  ],
  [`${SEQ}/sequential-hash-edits`]: (() => {
    const original = fixture(SEQ, "sequential-hash-edits", "src/flags.ts");
    const afterFirst = original.replace("darkMode: false", "darkMode: true");
    return [
      read("src/flags.ts"),
      edit("src/flags.ts", "darkMode: false", "darkMode: true", original),
      edit("src/flags.ts", "betaSearch: false", "betaSearch: true", afterFirst),
      done("darkMode and betaSearch are on."),
    ];
  })(),
  [`${SEQ}/no-shell-fix-typo`]: [
    read("README.md"),
    edit("README.md", "recieves", "receives", fixture(SEQ, "no-shell-fix-typo", "README.md")),
    done("Typo fixed."),
  ],
  [`${SEQ}/read-each-file-once`]: [
    read("notes/a.txt"),
    read("notes/b.txt"),
    read("notes/c.txt"),
    write("summary.txt", "alpha\nbravo\ncharlie\n", null),
    done("summary.txt written."),
  ],

  // long-context ------------------------------------------------------------------------------
  // Not recorded: these only prove the verifiers accept the right answer.
  [`${LONG}/find-late-value`]: [
    write("answer.txt", "amber-falcon-4821\n", null),
    done("Answer written."),
  ],
  [`${LONG}/merge-facts-across-files`]: [
    write("summary.md", "max_upload_mb: 87\ndefault_port: 8472\nretention_days: 19\n", null),
    done("Summary written."),
  ],
  [`${LONG}/truncated-command-output`]: [
    write("answer.txt", "check-58\n", null),
    done("Answer written."),
  ],
};

/**
 * Sequences a model must never produce, scripted so a test can prove the verifiers catch them:
 * here the whole work/ directory is deleted while its server is still running.
 */
export const INVALID_SCRIPTS: Record<string, ScriptTurn[]> = {
  [`${SEQ}/stop-bg-before-delete`]: [
    {
      calls: [
        {
          name: "bg_run",
          args: { command: "node server.js", cwd: "work", label: "server", timeoutMs: 60000 },
        },
      ],
    },
    { calls: [{ name: "shell", args: { command: "rm -rf work" } }] },
    (context) => ({ calls: [{ name: "bg_stop", args: { id: taskIdOf(context) } }] }),
    done("work/ was removed and then the server was stopped."),
  ],
};

/**
 * Plausible but WRONG solutions of the hardened smoke-coding tasks, keyed by task and then by a
 * name that says what is wrong. Each one is a run a real model could produce; a test proves the
 * verifiers reject every one (the evidence of discriminating power without a live model).
 */
export const WRONG_SOLUTIONS: Record<string, Record<string, ScriptTurn[]>> = {
  [`${SMOKE}/rename-symbol`]: {
    // Find and replace of the text: also renames look-alike symbols, the unrelated method and the
    // metric key.
    "replace-all-text": [
      ...RENAME_FILES.map((path) => read(path)),
      ...renameWrites(RENAME_FILES, (text) => text.replaceAll("fetchUser", "loadUser")),
      done("Replaced fetchUser with loadUser everywhere."),
    ],
    // Renames every reference except the bracket access of the dynamic import in lazy.ts.
    "misses-dynamic-import": [
      ...RENAME_FILES.map((path) => read(path)),
      ...renameWrites(
        RENAME_TO_REWRITE.filter((path) => path !== "src/lazy.ts"),
        renameFunction,
      ),
      done("Renamed the function and its imports."),
    ],
    // Right on the symbols, but also edits the metric key, which is data.
    "renames-metric-key": [
      ...RENAME_FILES.map((path) => read(path)),
      ...renameWrites(RENAME_TO_REWRITE, (text) =>
        renameFunction(text).replace('"fetchUser.calls"', '"loadUser.calls"'),
      ),
      done("Renamed the function and the metric key."),
    ],
  },
  [`${SMOKE}/edit-respects-hash`]: {
    // Rewrites the whole file with write_file and loses the CRLF endings, the trailing spaces and
    // the missing final newline.
    "rewrites-normalized": (() => {
      const before = fixture(SMOKE, "edit-respects-hash", "src/defaults.ts");
      const normalized = before
        .replaceAll("\r\n", "\n")
        .replaceAll("  \n", "\n")
        .replace(
          'retries: 3,\n  timeoutMs: 3000,\n  backoff: "linear",\n};\n\nexport const httpDefaultsLegacy',
          'retries: 5,\n  timeoutMs: 8000,\n  backoff: "exponential",\n};\n\nexport const httpDefaultsLegacy',
        );
      const limits = fixture(SMOKE, "edit-respects-hash", "src/limits.ts");
      return [
        read("src/defaults.ts"),
        read("src/limits.ts"),
        write("src/defaults.ts", `${normalized}\n`, before),
        write(
          "src/limits.ts",
          limits.replace(
            "uploadLimits = {\n  maxBodyKb: 256,",
            "uploadLimits = {\n  maxBodyKb: 512,",
          ),
          limits,
        ),
        done("Both files updated."),
      ];
    })(),
    // Applies the three defaults.ts edits and forgets the second file.
    "forgets-second-file": editRespectsHashScript({ skipLimits: true }),
    // Edits the near-duplicate httpDefaultsLegacy block instead of httpDefaults.
    "edits-the-legacy-twin": (() => {
      const before = fixture(SMOKE, "edit-respects-hash", "src/defaults.ts");
      const from = "httpDefaultsLegacy = {\r\n  retries: 3,";
      return [
        read("src/defaults.ts"),
        edit("src/defaults.ts", from, "httpDefaultsLegacy = {\r\n  retries: 5,", before),
        done("Raised the retries."),
      ];
    })(),
  },
  [`${SMOKE}/off-by-one-among-passing`]: {
    // Makes the visible suite green by patching the symptom in totalPages (the wrong layer):
    // pagesRemaining still uses the broken ceilDiv.
    "patches-total-pages-only": [
      read("checks/paginate.check.mjs"),
      read("src/paginate.ts"),
      ...paginationFixes({ empty: true }, true),
      done("totalPages rounds up now."),
    ],
    // Fixes the root cause and nothing else: the visible suite passes, the documented edge cases
    // do not.
    "fixes-only-the-visible-failure": [
      read("checks/paginate.check.mjs"),
      read("src/math.ts"),
      ...paginationFixes({ root: true }),
      done("ceilDiv rounds up now."),
    ],
    // Fixes everything except the page numbers below 1.
    "misses-the-page-clamp": [
      read("checks/paginate.check.mjs"),
      read("src/paginate.ts"),
      read("src/math.ts"),
      read("src/summary.ts"),
      ...paginationFixes({ root: true, empty: true, range: true, remaining: true }),
      done("Fixed the rounding, the empty list, the range and the remaining count."),
    ],
  },
};

/** The cassettes committed to the repository: every tool-sequences task and a smoke subset. */
export const RECORDED_TASKS: string[] = [
  `${SMOKE}/fix-add`,
  `${SMOKE}/rename-symbol`,
  `${SMOKE}/edit-respects-hash`,
  `${SMOKE}/bug-across-modules`,
  `${SEQ}/read-before-edit`,
  `${SEQ}/stop-bg-before-delete`,
  `${SEQ}/no-repeat-failed-call`,
  `${SEQ}/sequential-hash-edits`,
  `${SEQ}/no-shell-fix-typo`,
  `${SEQ}/read-each-file-once`,
];

// ---------------------------------------------------------------------------------------------
// Running and recording
// ---------------------------------------------------------------------------------------------

const ALL_PERMISSIONS: InvokerPermissions = {
  write: true,
  process: true,
  external: true,
  analysis: true,
};

/**
 * The environment the cassettes are recorded and replayed under: the built-in plugins of the CLI
 * (so `alisio eval run --mode replay` sees the same tools) and the default configuration.
 */
export function bundledRunOptions() {
  return {
    builtins: BUILTIN_PLUGINS as BuiltinPlugin[],
    config: configSchema.parse({}),
    invoker: ALL_PERMISSIONS,
  };
}

export interface RunScriptedOptions {
  suiteId: string;
  taskId: string;
  /** Required unless replaying. */
  turns?: ScriptTurn[];
  mode?: "live" | "record" | "replay";
  cassette?: CassetteRecorder | Cassette;
  builtins?: BuiltinPlugin[];
  tmpRoot?: string;
}

/** Runs one bundled task through the real engine and returns its record. */
export async function runScripted(options: RunScriptedOptions): Promise<EvalRunRecord> {
  const loaded = loadSuite(join(BUNDLED_DIR, options.suiteId));
  const task = loaded.suite.tasks.find((t) => t.id === options.taskId);
  if (!task) throw new Error(`Unknown task ${options.suiteId}/${options.taskId}.`);
  const defaults = bundledRunOptions();
  const mode = options.mode ?? "live";
  const { record } = await runTask(task, {
    suite: loaded,
    mode,
    ...(mode === "replay" ? {} : { provider: scriptProvider(options.turns ?? []) }),
    ...(options.cassette ? { cassette: options.cassette } : {}),
    config: defaults.config,
    invoker: defaults.invoker,
    builtins: options.builtins ?? defaults.builtins,
    seed: 0,
    repetition: 0,
    ...(options.tmpRoot ? { tmpRoot: options.tmpRoot } : {}),
  });
  return record;
}

export interface RecordedFile {
  suiteId: string;
  taskId: string;
  path: string;
  bytes: number;
}

export interface RecordBundledOptions {
  /** Where the `<suite>/cassettes/` folders go (default: the bundled suites themselves). */
  outDir?: string;
  /** Subset of `suite/task` keys (default: every recorded task). */
  only?: string[];
  tmpRoot?: string;
}

/** Records every bundled cassette from its turn script. Throws if a scripted run does not pass. */
export async function recordBundled(options: RecordBundledOptions = {}): Promise<RecordedFile[]> {
  const out = resolve(options.outDir ?? BUNDLED_DIR);
  const keys = options.only ?? RECORDED_TASKS;
  const written: RecordedFile[] = [];
  for (const key of keys) {
    const [suiteId, taskId] = key.split("/") as [string, string];
    const turns = REFERENCE_SCRIPTS[key];
    if (!RECORDED_TASKS.includes(key) || !turns)
      throw new Error(
        `"${key}" is not a recorded bundled task. Known: ${RECORDED_TASKS.join(", ")}.`,
      );
    const recorder = new CassetteRecorder();
    const record = await runScripted({
      suiteId,
      taskId,
      turns,
      mode: "record",
      cassette: recorder,
      ...(options.tmpRoot ? { tmpRoot: options.tmpRoot } : {}),
    });
    if (record.status !== "pass")
      throw new Error(
        `The scripted run of ${key} ended "${record.status}"${record.error ? ` (${record.error})` : ""}; its turn script and its verifiers disagree.`,
      );
    const path = join(out, suiteId, "cassettes", `${taskId}${CASSETTE_SUFFIX}`);
    mkdirSync(dirname(path), { recursive: true });
    const cassette = recorder.toCassette({
      suiteId,
      taskId,
      harnessVersion: record.harnessVersion,
      configHash: record.configHash,
      // Fixed on purpose: a wall-clock time would make every re-recording differ.
      recordedAt: 0,
      provider: record.provider,
      model: record.model,
    });
    writeCassette(path, cassette);
    written.push({ suiteId, taskId, path, bytes: readFileSync(path).length });
  }
  return written;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const USAGE = `Usage: eval-record-bundled.ts [options]

Re-records the cassettes of the bundled eval suites from their deterministic turn scripts (no live
model, no network). Run it after the harness changes what it sends to the provider on purpose.

Options:
  --tasks <list>  Comma-separated suite/task keys (default: all ${RECORDED_TASKS.length})
  --out <dir>     Write <dir>/<suite>/cassettes/ instead of tests/fixtures/eval
  -h, --help      This text
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      tasks: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const tmpRoot = mkdtempSync(join(tmpdir(), "eval-record-bundled-"));
  try {
    const files = await recordBundled({
      ...(values.out ? { outDir: values.out } : {}),
      ...(values.tasks ? { only: values.tasks.split(",").map((s) => s.trim()) } : {}),
      tmpRoot,
    });
    let total = 0;
    for (const file of files) {
      total += file.bytes;
      process.stdout.write(`Recorded ${file.suiteId}/${file.taskId} (${file.bytes} bytes)\n`);
    }
    process.stdout.write(`${files.length} cassettes, ${total} bytes in total.\n`);
    return 0;
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(
        `eval-record-bundled failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
