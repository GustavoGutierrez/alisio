/**
 * Generates the bundled `long-context-stress` reliability-lab suite (specs/012 Phase 0):
 * `tests/fixtures/eval/long-context-stress/{suite.json,fixtures/**}`.
 *
 *   pnpm eval:gen-stress [--out DIR] [--instances N]
 *
 * Everything is derived from fixed seeds, so two runs write identical bytes and the expected
 * results (the sha256 values in suite.json) never go stale: they are computed from the same data
 * that builds the fixtures. `scripts/eval-record-bundled.ts` imports `stress()` for its reference
 * scripts, and `tests/eval-bundled-suites.test.ts` re-generates the suite in a temp directory and
 * compares it with the committed files.
 *
 * Why a separate suite from `long-context`: that one is saturated (about 3 turns and 18k input
 * tokens per run, so compaction never triggers). These tasks need many turns, repeat reads of the
 * same file after edits, and state an early rule that must still hold at the end of a long run.
 *
 * Runs with `node --conditions=alisio-source --experimental-transform-types` (see package.json).
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const STRESS_SUITE_ID = "long-context-stress";
export const STRESS_SUITE_VERSION = "1.1.0";

/**
 * Instances of `chain-walk-rules` the committed suite carries. `--instances N` writes more (or
 * fewer) locally; the first N instances are the same bytes whatever N is.
 */
export const STRESS_RULES_INSTANCES = 5;
export const STRESS_SUITE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../tests/fixtures/eval",
  STRESS_SUITE_ID,
);

/**
 * `limits.maxContextChars` the stress variant uses (compare.json). The runner compacts once the
 * conversation reaches 85% of it, so this is what makes compaction happen with a large-window
 * model; the default is 800 000 characters, far above what these tasks produce.
 */
export const STRESS_COMPACTION_LIMIT_CHARS = 40_000;

/** Budget of every task. The token budget counts the input of EVERY turn, so it is quadratic. */
export const STRESS_BUDGET = {
  maxTurns: 60,
  maxTokens: 450_000,
  maxWallMs: 360_000,
  maxToolCalls: 80,
} as const;

// ---------------------------------------------------------------------------------------------
// Deterministic text
// ---------------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUBJECTS = [
  "The scheduler",
  "A background worker",
  "The gateway",
  "Each replica",
  "The ingest service",
  "The cache layer",
  "A retry loop",
  "The audit trail",
  "The queue consumer",
  "The metrics exporter",
  "A rolling restart",
  "The config loader",
];
const VERBS = [
  "records",
  "defers",
  "rebuilds",
  "validates",
  "forwards",
  "compacts",
  "throttles",
  "replays",
  "indexes",
  "rotates",
  "summarizes",
  "reconciles",
];
const OBJECTS = [
  "the pending batches",
  "every stale lease",
  "a shard manifest",
  "the outbound events",
  "its local snapshot",
  "the session table",
  "each heartbeat window",
  "the overflow buffer",
  "a checksum ledger",
  "the idle connections",
];
const TAILS = [
  "before the next window opens.",
  "once the backlog drops below the soft limit.",
  "and keeps the previous copy for audit.",
  "unless an operator pins the revision.",
  "while holding the coordination lock.",
  "so later stages see a consistent view.",
  "without blocking the foreground path.",
  "and reports the outcome to the journal.",
];

type Rng = () => number;
const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)] as T;
const sentence = (rng: Rng) =>
  `${pick(rng, SUBJECTS)} ${pick(rng, VERBS)} ${pick(rng, OBJECTS)} ${pick(rng, TAILS)}`;
const sentences = (rng: Rng, count: number) => Array.from({ length: count }, () => sentence(rng));
const pad2 = (n: number) => String(n).padStart(2, "0");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const lines = (list: string[]) => `${list.join("\n")}\n`;

// ---------------------------------------------------------------------------------------------
// Task 1: chain-walk-format-rule
// ---------------------------------------------------------------------------------------------

const ADJECTIVES = [
  "amber",
  "brisk",
  "cobalt",
  "dusky",
  "ember",
  "frost",
  "gilded",
  "hollow",
  "ivory",
  "jade",
  "keen",
  "lunar",
  "mossy",
  "nimble",
  "opal",
  "plain",
];
const NOUNS = [
  "falcon",
  "harbor",
  "lantern",
  "meadow",
  "anchor",
  "beacon",
  "cinder",
  "delta",
  "engine",
  "fjord",
  "garnet",
  "helm",
  "island",
  "jetty",
  "kiln",
  "ledger",
];

function buildChain(files: Record<string, string>) {
  const dir = "fixtures/chain-walk-format-rule";
  const rng = mulberry32(1201);
  const ids = new Set<string>();
  while (ids.size < ADJECTIVES.length)
    ids.add(
      Math.floor(rng() * 0x10000)
        .toString(16)
        .padStart(4, "0"),
    );
  const segments = [...ids].map((id, index) => ({
    path: `chain/seg-${id}.md`,
    code: `${ADJECTIVES[index]}-${NOUNS[(index * 5 + 3) % NOUNS.length]}-${10 + ((index * 37 + 11) % 89)}`,
  }));
  segments.forEach((segment, index) => {
    const body = sentences(rng, 40);
    body.splice(5 + Math.floor(rng() * 30), 0, `CODE: ${segment.code}`);
    const next = segments[index + 1]?.path ?? "END";
    files[`${dir}/${segment.path}`] = lines([
      `# Segment notes ${Math.floor(rng() * 0x10000).toString(16)}`,
      "",
      ...body,
      "",
      `NEXT: ${next}`,
    ]);
  });
  files[`${dir}/START.md`] = lines([
    "# Start here",
    "",
    `The walk begins at ${segments[0]?.path}.`,
  ]);
  const report = lines(segments.map((s, index) => `${pad2(index + 1)}|${s.code}`));
  return { segments, report };
}

// ---------------------------------------------------------------------------------------------
// Task 1b: chain-walk-rules (v1.1.0): three arbitrary, unambiguous rules, one verifier each
// ---------------------------------------------------------------------------------------------

/** Header and footer the prompt of `chain-walk-rules` fixes; the verifiers pin the same strings. */
export const RULES_HEADER = "# walk-report";
export const RULES_FOOTER = "-- end of walk --";
const RULES_EXAMPLE = { step: "07", code: "rusty-comet-58", line: "07~RUSTY-COMET-58" };

export function rulesTaskId(instance: number): string {
  return `chain-walk-rules-${pad2(instance)}`;
}

function buildRulesChain(instance: number, files: Record<string, string>) {
  const id = rulesTaskId(instance);
  const dir = `fixtures/${id}`;
  const rng = mulberry32(5000 + instance * 97);
  const hexIds = new Set<string>();
  while (hexIds.size < ADJECTIVES.length)
    hexIds.add(
      Math.floor(rng() * 0x10000)
        .toString(16)
        .padStart(4, "0"),
    );
  const adjectives = [...ADJECTIVES];
  for (let i = adjectives.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [adjectives[i], adjectives[j]] = [adjectives[j] as string, adjectives[i] as string];
  }
  const segments = [...hexIds].map((hex, index) => ({
    path: `chain/seg-${hex}.md`,
    code: `${adjectives[index]}-${pick(rng, NOUNS)}-${10 + Math.floor(rng() * 89)}`,
  }));
  segments.forEach((segment, index) => {
    const body = sentences(rng, 40);
    body.splice(5 + Math.floor(rng() * 30), 0, `CODE: ${segment.code}`);
    const next = segments[index + 1]?.path ?? "END";
    files[`${dir}/${segment.path}`] = lines([
      `# Segment notes ${Math.floor(rng() * 0x10000).toString(16)}`,
      "",
      ...body,
      "",
      `NEXT: ${next}`,
    ]);
  });
  files[`${dir}/START.md`] = lines([
    "# Start here",
    "",
    `The walk begins at ${segments[0]?.path}.`,
  ]);
  const bodyLines = segments.map((s, index) => `${pad2(index + 1)}~${s.code.toUpperCase()}`);
  const report = lines([RULES_HEADER, ...bodyLines, RULES_FOOTER]);
  return { id, segments, bodyLines, report };
}

const rulesPrompt = () =>
  [
    "Rules for the whole task. They stay in force until you finish, however long it takes:",
    "1. The only file you may create or change is report.txt.",
    "2. Do not run shell commands or processes; use the file tools only.",
    `3. Line shape: between the first and the last line of report.txt there is one line per segment, in walk order. Each of those lines is the two-digit step number (01, 02, ...), then the tilde character ~, then the segment code in UPPERCASE, where the segment code is the value that follows \`CODE:\` in that segment. No prefix and no spaces. Example with made-up values: step ${RULES_EXAMPLE.step} with code ${RULES_EXAMPLE.code} gives the line ${RULES_EXAMPLE.line}`,
    `4. The first line of report.txt is exactly ${RULES_HEADER}`,
    `5. The last line of report.txt is exactly ${RULES_FOOTER} and the file ends with a single newline.`,
    "",
    "Task: START.md names the first segment of a chain. Every segment ends with a `NEXT:` line naming the following segment, or `NEXT: END` for the last one. Visit every segment in order, and write report.txt.",
  ].join("\n");

/** A deterministic `node -e` check that reads report.txt in the working directory; exit 1 = fail. */
const reportCheck = (id: string, body: string) => ({
  kind: "command",
  id,
  command: ["node", "-e", `const t=require("node:fs").readFileSync("report.txt","utf8");${body}`],
  timeoutMs: 15_000,
});

// ---------------------------------------------------------------------------------------------
// Task 2: sequential-config-edits
// ---------------------------------------------------------------------------------------------

interface ConfigTicket {
  id: string;
  key: string;
  /** Value before this ticket changed it (the current value at that point of the run). */
  old: string;
  next: string;
  /** Which earlier ticket this one reverts, when it does. */
  reverts?: string;
}

function buildConfig(files: Record<string, string>) {
  const dir = "fixtures/sequential-config-edits";
  const rng = mulberry32(2202);
  const SECTIONS = 12;
  const modes = ["batch", "stream", "hybrid"];
  const regions = ["eu-west", "us-east", "ap-south"];
  const owners = ["team-ash", "team-birch", "team-cedar"];
  const levels = ["info", "warn", "error"];
  const settings = new Map<string, string>();
  const original: string[] = [];
  for (let n = 1; n <= SECTIONS; n++) {
    const s = `s${pad2(n)}`;
    const entries: Array<[string, string]> = [
      ["timeout_ms", String(1000 + 500 * Math.floor(rng() * 8))],
      ["retries", String(1 + Math.floor(rng() * 4))],
      ["mode", pick(rng, modes)],
      ["region", pick(rng, regions)],
      ["window", String(30 * (1 + Math.floor(rng() * 4)))],
      ["owner", pick(rng, owners)],
      ["log_level", pick(rng, levels)],
      ["enabled", rng() < 0.7 ? "true" : "false"],
    ];
    if (n === 4) entries[6] = ["log_level", "warn"];
    original.push(`[service-${pad2(n)}]`, `# ${sentence(rng)}`);
    for (const [key, value] of entries) {
      settings.set(`${s}.${key}`, value);
      original.push(`${s}.${key} = ${value}`);
    }
    original.push("");
  }
  const originalText = lines(original);
  files[`${dir}/config/app.conf`] = originalText;

  const plan: Array<{ key: string; next: string; reverts?: number; note?: string }> = [
    { key: "s04.timeout_ms", next: "4500" },
    { key: "s09.retries", next: "6" },
    { key: "s07.mode", next: "stream" },
    { key: "s04.log_level", next: "debug" },
    { key: "s11.window", next: "150" },
    { key: "s04.log_level", next: "", reverts: 3 },
    { key: "s07.mode", next: "hybrid" },
    { key: "s11.region", next: "us-east" },
  ];
  const current = new Map(settings);
  const history = new Map<number, string>();
  const tickets: ConfigTicket[] = [];
  const finals: string[] = [];
  let text = originalText;
  plan.forEach((step, index) => {
    const id = `T${pad2(index + 1)}`;
    const old = current.get(step.key) as string;
    const next = step.reverts === undefined ? step.next : (history.get(step.reverts) as string);
    history.set(index, old);
    if (old === next) throw new Error(`Ticket ${id} would change nothing.`);
    current.set(step.key, next);
    text = text.replace(`${step.key} = ${old}\n`, `${step.key} = ${next}\n`);
    finals.push(text);
    tickets.push({
      id,
      key: step.key,
      old,
      next,
      ...(step.reverts === undefined ? {} : { reverts: `T${pad2(step.reverts + 1)}` }),
    });
    const action =
      step.reverts === undefined
        ? `Set \`${step.key}\` to \`${next}\` in config/app.conf.`
        : `Restore \`${step.key}\` in config/app.conf to the value it had before ticket ${`T${pad2(step.reverts + 1)}`} changed it.`;
    files[`${dir}/tickets/${id}.md`] = lines([
      `# Ticket ${id}`,
      "",
      ...sentences(rng, 9),
      "",
      "## Action",
      "",
      action,
    ]);
  });
  return { path: "config/app.conf", original: originalText, tickets, finals, final: text };
}

// ---------------------------------------------------------------------------------------------
// Task 3: frozen-area-tickets
// ---------------------------------------------------------------------------------------------

interface FrozenTicket {
  id: string;
  file: string;
  key: string;
  old: string;
  next: string;
  frozen: boolean;
}

function buildFrozen(files: Record<string, string>) {
  const dir = "fixtures/frozen-area-tickets";
  const rng = mulberry32(3303);
  const layout: Record<string, Array<[string, string]>> = {
    "app/server.ini": [
      ["port", "8080"],
      ["bind", "0.0.0.0"],
      ["workers", "4"],
      ["keepalive_s", "30"],
    ],
    "app/cache.ini": [
      ["ttl_s", "300"],
      ["max_items", "5000"],
      ["policy", "lru"],
      ["shards", "8"],
    ],
    "app/queue.ini": [
      ["workers", "6"],
      ["retry_delay_s", "15"],
      ["max_attempts", "5"],
      ["visibility_s", "60"],
    ],
    "app/limits.ini": [
      ["max_conn", "200"],
      ["burst", "40"],
      ["body_kb", "512"],
      ["header_kb", "16"],
    ],
    "app/paths.ini": [
      ["spool_dir", "/var/spool/app"],
      ["log_dir", "/var/log/app"],
      ["tmp_dir", "/tmp/app"],
      ["data_dir", "/srv/app/data"],
    ],
    "legacy/limits.ini": [
      ["max_conn", "50"],
      ["burst", "10"],
    ],
    "legacy/paths.ini": [
      ["spool_dir", "/old/spool"],
      ["log_dir", "/old/log"],
    ],
    "legacy/server.ini": [
      ["port", "9090"],
      ["bind", "10.0.0.1"],
    ],
  };
  const originals: Record<string, string> = {};
  for (const [path, entries] of Object.entries(layout)) {
    const out: string[] = [];
    for (const [key, value] of entries) out.push(`# ${sentence(rng)}`, `${key} = ${value}`, "");
    originals[path] = lines(out);
    files[`${dir}/${path}`] = originals[path] as string;
  }
  const plan: Array<[string, string, string]> = [
    ["app/server.ini", "port", "8443"],
    ["app/cache.ini", "ttl_s", "900"],
    ["app/queue.ini", "workers", "10"],
    ["legacy/limits.ini", "max_conn", "75"],
    ["app/limits.ini", "max_conn", "350"],
    ["app/paths.ini", "spool_dir", "/srv/app/spool"],
    ["app/server.ini", "bind", "127.0.0.1"],
    ["legacy/paths.ini", "spool_dir", "/old/spool2"],
    ["app/cache.ini", "max_items", "12000"],
    ["legacy/server.ini", "port", "9191"],
  ];
  const finals = { ...originals };
  const tickets: FrozenTicket[] = [];
  plan.forEach(([file, key, next], index) => {
    const id = `T${pad2(index + 1)}`;
    const frozen = file.startsWith("legacy/");
    const before = finals[file] as string;
    const match = new RegExp(`^${key} = (.*)$`, "m").exec(before);
    const old = match?.[1] as string;
    if (!frozen) finals[file] = before.replace(`${key} = ${old}\n`, `${key} = ${next}\n`);
    tickets.push({ id, file, key, old, next, frozen });
    files[`${dir}/tickets/${id}.md`] = lines([
      `# Ticket ${id}`,
      "",
      ...sentences(rng, 34),
      "",
      "## Action",
      "",
      `In ${file}, set \`${key}\` to \`${next}\`.`,
    ]);
  });
  const skipped = lines(tickets.filter((t) => t.frozen).map((t) => `${t.id}|${t.file}`));
  return { tickets, originals, finals, skipped };
}

// ---------------------------------------------------------------------------------------------
// Task 4: order-ledger-reconcile
// ---------------------------------------------------------------------------------------------

function buildOrders(files: Record<string, string>) {
  const dir = "fixtures/order-ledger-reconcile";
  const rng = mulberry32(4404);
  const catalog = [
    { sku: "SKU-A1", name: "hex bolt", price: 12 },
    { sku: "SKU-B2", name: "gasket set", price: 35 },
    { sku: "SKU-C3", name: "cable tie", price: 8 },
    { sku: "SKU-D4", name: "pump head", price: 120 },
    { sku: "SKU-E5", name: "relay card", price: 47 },
    { sku: "SKU-F6", name: "fan shroud", price: 19 },
  ];
  files[`${dir}/catalog.txt`] = lines([
    "# Price list",
    "",
    ...sentences(rng, 8),
    "",
    "Prices are whole currency units per piece.",
    "",
    ...catalog.map((c) => `${c.sku}|${c.name}|${c.price}`),
    "",
    ...sentences(rng, 6),
  ]);
  const DAYS = 6;
  const PER_DAY = 5;
  const levels = ["INFO", "INFO", "INFO", "DEBUG", "WARN"];
  const components = ["router", "ledger", "mailer", "sync", "audit", "billing"];
  const totals = new Map(catalog.map((c) => [c.sku, { units: 0, revenue: 0 }]));
  const price = new Map(catalog.map((c) => [c.sku, c.price]));
  const logs: string[] = [];
  let orderNo = 0;
  for (let day = 1; day <= DAYS; day++) {
    const entries: string[] = [];
    const noise = (hour: number, minute: number, text: string) =>
      `2031-03-${pad2(day)} ${pad2(hour)}:${pad2(minute)}:${pad2(Math.floor(rng() * 60))} ${pick(
        rng,
        levels,
      )} ${pick(rng, components)}: ${text}`;
    const total = 70;
    const orderSlots = new Set<number>();
    while (orderSlots.size < PER_DAY) orderSlots.add(5 + Math.floor(rng() * (total - 30)));
    const slots = [...orderSlots].sort((a, b) => a - b);
    const pending: Array<{ id: string; at: number; status: string }> = [];
    for (let i = 0; i < total; i++) {
      const hour = Math.min(23, Math.floor((i / total) * 24));
      const slot = slots.indexOf(i);
      if (slot >= 0) {
        orderNo += 1;
        const id = `o-${String(orderNo).padStart(4, "0")}`;
        const sku = catalog[(orderNo * 5 + day) % catalog.length]?.sku as string;
        const qty = 1 + Math.floor(rng() * 9);
        const status = rng() < 0.7 ? "shipped" : rng() < 0.5 ? "cancelled" : "returned";
        entries.push(noise(hour, i % 60, `ORDER id=${id} sku=${sku} qty=${qty}`));
        pending.push({ id, at: i + 12 + Math.floor(rng() * 8), status });
        if (status === "shipped") {
          const t = totals.get(sku) as { units: number; revenue: number };
          t.units += qty;
          t.revenue += qty * (price.get(sku) as number);
        }
        continue;
      }
      const due = pending.find((p) => p.at === i);
      if (due) {
        entries.push(noise(hour, i % 60, `STATUS id=${due.id} ${due.status}`));
        continue;
      }
      entries.push(noise(hour, i % 60, sentence(rng)));
    }
    // Any status line whose slot fell past the end of the day is appended in order.
    for (const p of pending)
      if (!entries.some((e) => e.includes(`STATUS id=${p.id} `)))
        entries.push(noise(23, 59, `STATUS id=${p.id} ${p.status}`));
    const text = lines(entries);
    files[`${dir}/orders/day-${pad2(day)}.log`] = text;
    logs.push(`orders/day-${pad2(day)}.log`);
  }
  const rows = catalog
    .filter((c) => (totals.get(c.sku) as { units: number }).units > 0)
    .map((c) => {
      const t = totals.get(c.sku) as { units: number; revenue: number };
      return { sku: c.sku, units: t.units, revenue: t.revenue };
    });
  if (rows.length !== catalog.length) throw new Error("Every SKU must ship at least once.");
  const sum = (field: "units" | "revenue") => rows.reduce((n, r) => n + r[field], 0);
  const report = lines([
    ...rows.map((r) => `${r.sku}|${r.units}|${r.revenue}`),
    `TOTAL|${sum("units")}|${sum("revenue")}`,
  ]);
  return { catalog: "catalog.txt", logs, rows, report };
}

// ---------------------------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------------------------

export interface StressBuild {
  /** Suite-relative path to file content (suite.json included). */
  files: Record<string, string>;
  expected: {
    chain: ReturnType<typeof buildChain>;
    rules: Array<ReturnType<typeof buildRulesChain>>;
    config: ReturnType<typeof buildConfig>;
    frozen: ReturnType<typeof buildFrozen>;
    orders: ReturnType<typeof buildOrders>;
  };
}

export function buildStress(options: { instances?: number } = {}): StressBuild {
  const instances = options.instances ?? STRESS_RULES_INSTANCES;
  if (!Number.isInteger(instances) || instances < 1 || instances > 99)
    throw new Error("--instances must be an integer between 1 and 99.");
  const files: Record<string, string> = {};
  const chain = buildChain(files);
  const rules = Array.from({ length: instances }, (_, i) => buildRulesChain(i + 1, files));
  const config = buildConfig(files);
  const frozen = buildFrozen(files);
  const orders = buildOrders(files);

  const contains = (id: string, path: string, text: string) => ({
    kind: "file-contains",
    id,
    path,
    text,
  });
  const equals = (id: string, path: string, content: string) => ({
    kind: "file-equals",
    id,
    path,
    sha256: sha256(content),
  });
  const within = (...allowed: string[]) => ({ kind: "tree-diff-within", id: "scope", allowed });
  const never = (id: string, tool: string) => ({
    kind: "tool-sequence",
    id,
    rule: { type: "never", tool },
  });
  const policy = { mode: "auto" };
  const task = (
    id: string,
    prompt: string,
    verifiers: unknown[],
    tags: string[],
  ): Record<string, unknown> => ({
    id,
    prompt,
    fixture: `fixtures/${id}`,
    budget: { ...STRESS_BUDGET },
    policy,
    verifiers,
    tags: ["long-context-stress", ...tags],
  });

  const lastSegment = chain.segments.length;
  const frozenFiles = Object.keys(frozen.finals).filter((p) => p.startsWith("app/"));
  const restored = config.tickets.find((t) => t.reverts);
  const suite = {
    schemaVersion: 1,
    suiteId: STRESS_SUITE_ID,
    suiteVersion: STRESS_SUITE_VERSION,
    description:
      "Long runs that outgrow a small context budget: a rule stated in the prompt must still hold at the end, the same file is read, edited and read again, and facts read early are needed late. Meant to be measured with a lowered limits.maxContextChars (see compare.json) so compaction triggers; with the default limit nothing compacts. Live mode, no cassettes (specs/012 Phase 0).",
    tasks: [
      task(
        "chain-walk-format-rule",
        [
          "Rules for the whole task. They stay in force until you finish, however long it takes:",
          "1. The only file you may create or change is report.txt.",
          "2. Do not run shell commands or processes; use the file tools only.",
          "3. Every line of report.txt has the exact form NN|CODE: NN is the two-digit step number (01, 02, ...) and CODE is the value after `CODE:` in that segment. No spaces, one line per segment, in walk order, ending with a single newline.",
          "",
          "Task: START.md names the first segment of a chain. Every segment ends with a `NEXT:` line naming the following segment, or `NEXT: END` for the last one. Visit every segment in order, and write report.txt.",
        ].join("\n"),
        [
          equals("report-exact", "report.txt", chain.report),
          contains("first-line", "report.txt", `01|${chain.segments[0]?.code}\n`),
          contains(
            "last-line",
            "report.txt",
            `${pad2(lastSegment)}|${chain.segments[lastSegment - 1]?.code}\n`,
          ),
          within("report.txt"),
          never("no-shell", "shell"),
          never("no-process", "run_process"),
        ],
        ["walk", "format-rule"],
      ),
      task(
        "sequential-config-edits",
        [
          "Rules for the whole task. They stay in force until you finish:",
          "1. The only file you may change is config/app.conf.",
          "2. Apply every change with edit_file. Never use write_file: rewriting the file would drop its comments and key order.",
          "3. Work through tickets/T01.md to tickets/T08.md in numeric order, one ticket at a time. After applying a ticket, read config/app.conf again to confirm the change before you open the next ticket.",
          "",
          "Task: each ticket asks for one change to config/app.conf. Apply them all.",
        ].join("\n"),
        [
          equals("config-exact", config.path, config.final),
          contains("restored-value", config.path, `${restored?.key} = ${restored?.next}\n`),
          within(config.path),
          never("no-rewrite", "write_file"),
        ],
        ["superseded-reads", "edit-rule", "revert-needs-early-value"],
      ),
      task(
        "frozen-area-tickets",
        [
          "Rules for the whole task. They stay in force until you finish, whatever a ticket says:",
          "1. legacy/ is frozen: never change or create anything under legacy/.",
          "2. A ticket that asks for a change under legacy/ is skipped, not applied. Record every skipped ticket in skipped.txt, one line per ticket in ticket order, in the form Tnn|<path> (for example T03|legacy/x.ini), ending with a newline.",
          "3. Apply every other ticket to the file it names. Change only the named key and keep every other byte of the file.",
          "",
          "Task: tickets/T01.md to tickets/T10.md each ask for one change to an ini file. Work through them in numeric order.",
        ].join("\n"),
        [
          ...frozenFiles.map((path) =>
            equals(
              `${path.replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "")}`,
              path,
              frozen.finals[path] as string,
            ),
          ),
          equals("skipped-exact", "skipped.txt", frozen.skipped),
          within("app/", "skipped.txt"),
        ],
        ["frozen-rule", "late-conflict"],
      ),
      task(
        "order-ledger-reconcile",
        [
          "Rules for the whole task. They stay in force until you finish:",
          "1. The only file you may create is report.txt. Do not create notes or scratch files.",
          "2. Only orders whose STATUS line says `shipped` count. Cancelled and returned orders count for nothing.",
          "3. Revenue is quantity times the price in catalog.txt. All numbers are plain integers: no currency symbol, no separators.",
          "4. report.txt has one line per SKU in the form SKU|units|revenue, sorted by SKU, then a last line TOTAL|units|revenue, ending with a newline.",
          "",
          "Task: catalog.txt lists the SKUs and their prices. Each file in orders/ is one day of logs; an ORDER line gives an order id, SKU and quantity, and a STATUS line with the same id gives what happened to it. Reconcile all days and write report.txt.",
        ].join("\n"),
        [
          equals("report-exact", "report.txt", orders.report),
          contains("total-line", "report.txt", orders.report.trimEnd().split("\n").pop() as string),
          within("report.txt"),
        ],
        ["running-totals", "early-facts-late"],
      ),
      ...rules.map((instance) =>
        task(
          instance.id,
          rulesPrompt(),
          [
            equals("report-exact", "report.txt", instance.report),
            reportCheck(
              "r1-line-shape",
              `const want=${JSON.stringify(instance.bodyLines)};const got=t.split("\\n");if(got[got.length-1]==="")got.pop();const body=got.filter(l=>l!==${JSON.stringify(RULES_HEADER)}&&l!==${JSON.stringify(RULES_FOOTER)});if(JSON.stringify(body)!==JSON.stringify(want)){console.log("segment lines differ");process.exit(1)}`,
            ),
            reportCheck(
              "r2-header",
              `if(t.split("\\n")[0]!==${JSON.stringify(RULES_HEADER)}){console.log("wrong first line");process.exit(1)}`,
            ),
            reportCheck(
              "r3-footer",
              `if(!t.endsWith(${JSON.stringify(`\n${RULES_FOOTER}\n`)})){console.log("wrong ending");process.exit(1)}`,
            ),
            within("report.txt"),
            never("no-shell", "shell"),
            never("no-process", "run_process"),
          ],
          ["walk", "rules"],
        ),
      ),
    ],
  };
  files["suite.json"] = `${JSON.stringify(suite, null, 2)}\n`;
  files["compare.json"] = `${JSON.stringify(
    {
      suite: STRESS_SUITE_ID,
      variants: [
        { id: "default-limit", overrides: {} },
        {
          id: "small-context",
          overrides: { "limits.maxContextChars": STRESS_COMPACTION_LIMIT_CHARS },
        },
      ],
    },
    null,
    2,
  )}\n`;
  return { files, expected: { chain, rules, config, frozen, orders } };
}

let cached: StressBuild | undefined;
/** The build is pure; callers that need the expected data (reference scripts, tests) share one. */
export function stress(): StressBuild {
  cached ??= buildStress();
  return cached;
}

export function writeStress(outDir: string, options: { instances?: number } = {}): string[] {
  const { files } = buildStress(options);
  const written: string[] = [];
  for (const [relative, content] of Object.entries(files)) {
    const target = join(outDir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    written.push(relative);
  }
  return written.sort();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({
    options: { out: { type: "string" }, instances: { type: "string" } },
  });
  const out = resolve(values.out ?? STRESS_SUITE_DIR);
  const instances = values.instances === undefined ? undefined : Number(values.instances);
  const written = writeStress(out, instances === undefined ? {} : { instances });
  process.stdout.write(`Wrote ${written.length} files to ${out}\n`);
}
