/**
 * Context Governor, claim G1 (specs/012, "Protocolo de la puerta de la Fase 6"): does `on` send
 * fewer input tokens than `off`? Deterministic: no model, no network, no credentials.
 *
 *   pnpm governor:g1 [--out FILE]
 *
 * It replays the scripted reference sessions of the `long-context-stress` suite through the real
 * engine and runner (the same scripts `pnpm eval:record-bundled` records) with `context.governor`
 * `off` and `on`, observes every request the provider receives, and compares the input tokens per
 * request and cumulatively.
 *
 * WHAT THE NUMBERS ARE. The scripted provider reports a constant fake `usage`, so there is no
 * provider-measured token figure here: every token count is an ESTIMATE (`estimateTokens`: about
 * 4 characters per token over the JSON of what is sent) and every session is SYNTHETIC (a fixed
 * script, not a model). Two lengths are measured and kept apart:
 *   - `reference`: the scripts as they are (13 to 28 requests);
 *   - `audit`: the same script plus one audit sweep, the model re-reading every file it read once
 *     more before answering (about twice as long). This is a constructed scenario, not a recording.
 *     Note: the Governor only elides a read that a LATER read of different content supersedes, so
 *     re-reading an unchanged file saves nothing by design; the audit sweep helps only in tasks
 *     whose files were edited in between.
 * Two context limits: `default-limit` (800 000 characters, nothing compacts) and `small-context`
 * (40 000, the primary comparison of G3; compaction runs). The compaction summarizer requests are
 * counted as requests of their own kind, so a cumulative figure includes them.
 *
 * `on` is measured with the shipped settings (`epochMessages` 32, `minAgeTurns` 2) and, as a
 * sensitivity arm that is NOT the shipped default, with eager elision (`epochMessages` 0).
 *
 * Both figures are reported: `messages` (the conversation sent) and `request` (conversation plus
 * the fixed instructions and tool definitions, the part the Governor cannot touch).
 *
 * The owner sets the threshold T from this distribution; this script never picks it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { estimateTokens } from "../packages/core/src/core/compaction.ts";
import { loadVersion } from "../packages/core/src/version.ts";
import { STRESS_COMPACTION_LIMIT_CHARS, STRESS_SUITE_ID } from "./eval-gen-long-context-stress.ts";
import { REFERENCE_SCRIPTS, runScripted, type ScriptTurn } from "./eval-record-bundled.ts";

export const G1_SCHEMA = "governor-g1/v1";
export const DEFAULT_LIMIT_CHARS = 800_000;

export type RequestKind = "main" | "compaction";

export interface RequestTokens {
  kind: RequestKind;
  /** Estimated tokens of the conversation sent. */
  messageTokens: number;
  /** Estimated tokens of the instructions and tool definitions sent with it. */
  fixedTokens: number;
  /**
   * Estimated tokens of the leading messages identical to the previous main-loop request (0 for the
   * first, and for compaction requests): what a perfect provider prompt cache could serve.
   */
  reusedTokens: number;
}

export interface PrefixReuse {
  /** Conversation tokens of the main-loop requests (compaction requests excluded). */
  sentTokens: number;
  reusedTokens: number;
  /** reused / sent; 0 for an empty session. */
  share: number;
}

/**
 * Cache-friendliness PROXY, not a measurement of the provider's `cachedInput`: how much of the
 * conversation each main-loop request repeats verbatim from the one before it. The Lab does not
 * record `cachedInput`, so this is the only cache figure the deterministic replay can give.
 */
export function prefixReuse(requests: RequestTokens[]): PrefixReuse {
  const main = requests.filter((r) => r.kind === "main");
  const sentTokens = sum(main.map((r) => r.messageTokens));
  const reusedTokens = sum(main.map((r) => r.reusedTokens));
  return { sentTokens, reusedTokens, share: ratio(reusedTokens, sentTokens) };
}

export interface Reduction {
  /** Fraction of the conversation tokens saved, cumulative over the session. */
  messages: number;
  /** Fraction of the whole request tokens saved (fixed part included), cumulative. */
  request: number;
  requests: number;
  /** Per-request fraction of conversation tokens saved, in request order. */
  perRequest: number[];
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const ratio = (saved: number, base: number) => (base === 0 ? 0 : saved / base);

/** Compares two sessions that made the same requests; `off` is the baseline. */
export function reductionBetween(off: RequestTokens[], on: RequestTokens[]): Reduction {
  if (off.length !== on.length)
    throw new Error(
      `Sessions are not comparable: they need the same number of requests (off ${off.length}, on ${on.length}).`,
    );
  off.forEach((request, i) => {
    if (request.kind !== (on[i] as RequestTokens).kind)
      throw new Error(`Sessions are not comparable: request ${i} differs in kind.`);
  });
  const offMessages = sum(off.map((r) => r.messageTokens));
  const onMessages = sum(on.map((r) => r.messageTokens));
  const offRequest = offMessages + sum(off.map((r) => r.fixedTokens));
  const onRequest = onMessages + sum(on.map((r) => r.fixedTokens));
  return {
    messages: ratio(offMessages - onMessages, offMessages),
    request: ratio(offRequest - onRequest, offRequest),
    requests: off.length,
    perRequest: off.map((r, i) =>
      ratio(r.messageTokens - (on[i] as RequestTokens).messageTokens, r.messageTokens),
    ),
  };
}

export interface ReductionSummary {
  tasks: number;
  min: number;
  median: number;
  max: number;
  /** (sum off - sum on) / sum off over all tasks: weights each task by its size. */
  pooled: number;
}

/** Distribution of per-task reductions from the cumulative token totals of each task. */
export function summarizeReductions(totals: Array<{ off: number; on: number }>): ReductionSummary {
  if (totals.length === 0) return { tasks: 0, min: 0, median: 0, max: 0, pooled: 0 };
  const per = totals.map((t) => ratio(t.off - t.on, t.off)).sort((a, b) => a - b);
  const mid = Math.floor(per.length / 2);
  const median =
    per.length % 2 ? (per[mid] as number) : ((per[mid - 1] as number) + (per[mid] as number)) / 2;
  return {
    tasks: totals.length,
    min: per[0] as number,
    median,
    max: per[per.length - 1] as number,
    pooled: ratio(
      sum(totals.map((t) => t.off)) - sum(totals.map((t) => t.on)),
      sum(totals.map((t) => t.off)),
    ),
  };
}

const isRead = (turn: ScriptTurn) =>
  typeof turn !== "function" && turn.calls?.length === 1 && turn.calls[0]?.name === "read_file";

/**
 * The synthetic long session: the reference script with every `read_file` turn repeated once just
 * before the final answer (a model double-checking what it read). Nothing else changes.
 */
export function auditSweep(turns: ScriptTurn[]): ScriptTurn[] {
  if (turns.length === 0) return turns;
  return [...turns.slice(0, -1), ...turns.filter(isRead), turns[turns.length - 1] as ScriptTurn];
}

export interface SessionMeasurement {
  suiteId: string;
  taskId: string;
  governor: "off" | "shadow" | "on";
  maxContextChars: number;
  audit: boolean;
  epochMessages?: number;
  /** Always "estimated": the scripted provider's `usage` is a constant, not a measurement. */
  basis: "estimated";
  /** Always true: a fixed script, not a model session. */
  synthetic: true;
  status: string;
  compactions: number;
  requests: RequestTokens[];
}

export interface MeasureSessionOptions {
  suiteId?: string;
  taskId: string;
  governor: "off" | "shadow" | "on";
  maxContextChars: number;
  audit?: boolean;
  /** `context.elide.epochMessages` (default: the shipped 32). 0 elides eagerly. */
  epochMessages?: number;
  tmpRoot?: string;
}

export async function measureSession(options: MeasureSessionOptions): Promise<SessionMeasurement> {
  const suiteId = options.suiteId ?? STRESS_SUITE_ID;
  const base = REFERENCE_SCRIPTS[`${suiteId}/${options.taskId}`];
  if (!base) throw new Error(`No reference script for ${suiteId}/${options.taskId}.`);
  const turns = options.audit ? auditSweep(base) : base;
  const requests: RequestTokens[] = [];
  let previous: string[] = [];
  const record = await runScripted({
    suiteId,
    taskId: options.taskId,
    turns,
    ...(options.tmpRoot ? { tmpRoot: options.tmpRoot } : {}),
    configOverrides: {
      "limits.maxContextChars": options.maxContextChars,
      "context.governor": options.governor,
      ...(options.epochMessages === undefined
        ? {}
        : { "context.elide.epochMessages": options.epochMessages }),
    },
    answerCompactions: true,
    observe: (request) => {
      const first = request.messages[0];
      const summarizing =
        first?.role === "user" && first.text.startsWith("Checkpoint this session transcript.");
      const serialized = request.messages.map((m) => JSON.stringify(m));
      let common = 0;
      if (!summarizing) {
        while (common < previous.length && serialized[common] === previous[common]) common++;
        previous = serialized;
      }
      requests.push({
        kind: summarizing ? "compaction" : "main",
        reusedTokens: common === 0 ? 0 : estimateTokens(request.messages.slice(0, common)),
        messageTokens: estimateTokens(request.messages),
        fixedTokens: estimateTokens(`${request.instructions}${JSON.stringify(request.tools)}`),
      });
    },
  });
  return {
    suiteId,
    taskId: options.taskId,
    governor: options.governor,
    maxContextChars: options.maxContextChars,
    audit: options.audit === true,
    ...(options.epochMessages === undefined ? {} : { epochMessages: options.epochMessages }),
    basis: "estimated",
    synthetic: true,
    status: record.status,
    compactions: requests.filter((r) => r.kind === "compaction").length,
    requests,
  };
}

// ---------------------------------------------------------------------------------------------
// The full measurement
// ---------------------------------------------------------------------------------------------

export type LimitName = "default-limit" | "small-context";
export type LengthName = "reference" | "audit";

const LIMITS: Array<[LimitName, number]> = [
  ["default-limit", DEFAULT_LIMIT_CHARS],
  ["small-context", STRESS_COMPACTION_LIMIT_CHARS],
];
const LENGTHS: LengthName[] = ["reference", "audit"];

export interface RunTotals {
  status: string;
  requests: number;
  compactions: number;
  /** Cumulative estimated conversation tokens over every request. */
  messageTokens: number;
  /** Cumulative estimated tokens of the whole request. */
  requestTokens: number;
}

export interface G1Cell {
  taskId: string;
  length: LengthName;
  limit: LimitName;
  off: RunTotals;
  /** Governor on with the shipped settings (epochMessages 32). */
  on: RunTotals;
  /** Sensitivity: governor on with eager elision (epochMessages 0). Not the shipped default. */
  onEager: RunTotals;
  reduction: Reduction;
  reductionEager: Reduction;
  /** Cache-friendliness proxy (see `prefixReuse`) of each arm; estimated, not `cachedInput`. */
  prefixReuse: { off: PrefixReuse; on: PrefixReuse; onEager: PrefixReuse };
  /**
   * Raw per-request estimated conversation tokens, `kinds` as one letter per request (m, c).
   * `onEager` has its own request count (eager elision can change when compaction triggers).
   */
  series: { off: number[]; on: number[]; onEager: number[]; kinds: string; kindsEager: string };
}

export interface G1Summary {
  length: LengthName;
  limit: LimitName;
  /** Reduction of the conversation sent. */
  messages: ReductionSummary;
  /** Reduction of the whole request. */
  request: ReductionSummary;
  /** The same two with eager elision (sensitivity, not the shipped default). */
  eager: { messages: ReductionSummary; request: ReductionSummary };
  /** Pooled prefix reuse share of the group (reused / sent over all tasks), per arm. */
  prefixReuse: { off: number; on: number; onEager: number };
}

export interface G1Result {
  schema: typeof G1_SCHEMA;
  harnessVersion: string;
  basis: "estimated";
  synthetic: true;
  estimator: string;
  suite: string;
  governorSettings: { minAgeTurns: number; epochMessages: number };
  cells: G1Cell[];
  summary: G1Summary[];
}

const pooledShare = (list: PrefixReuse[]) =>
  ratio(sum(list.map((p) => p.reusedTokens)), sum(list.map((p) => p.sentTokens)));

const kindsOf = (m: SessionMeasurement) =>
  m.requests.map((r) => (r.kind === "main" ? "m" : "c")).join("");

const totalsOf = (m: SessionMeasurement): RunTotals => {
  const messageTokens = sum(m.requests.map((r) => r.messageTokens));
  return {
    status: m.status,
    requests: m.requests.length,
    compactions: m.compactions,
    messageTokens,
    requestTokens: messageTokens + sum(m.requests.map((r) => r.fixedTokens)),
  };
};

export interface MeasureSuiteOptions {
  tmpRoot?: string;
  /** Task ids to measure (default: every reference script of the stress suite). */
  tasks?: string[];
}

export async function measureSuite(options: MeasureSuiteOptions = {}): Promise<G1Result> {
  const prefix = `${STRESS_SUITE_ID}/`;
  const tasks =
    options.tasks ??
    Object.keys(REFERENCE_SCRIPTS)
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  const cells: G1Cell[] = [];
  for (const taskId of tasks)
    for (const [limit, maxContextChars] of LIMITS)
      for (const length of LENGTHS) {
        const common = {
          taskId,
          maxContextChars,
          audit: length === "audit",
          ...(options.tmpRoot ? { tmpRoot: options.tmpRoot } : {}),
        };
        const off = await measureSession({ ...common, governor: "off" });
        const on = await measureSession({ ...common, governor: "on" });
        const eager = await measureSession({ ...common, governor: "on", epochMessages: 0 });
        cells.push({
          taskId,
          length,
          limit,
          off: totalsOf(off),
          on: totalsOf(on),
          onEager: totalsOf(eager),
          reduction: reductionBetween(off.requests, on.requests),
          reductionEager: reductionBetween(off.requests, eager.requests),
          prefixReuse: {
            off: prefixReuse(off.requests),
            on: prefixReuse(on.requests),
            onEager: prefixReuse(eager.requests),
          },
          series: {
            off: off.requests.map((r) => r.messageTokens),
            on: on.requests.map((r) => r.messageTokens),
            onEager: eager.requests.map((r) => r.messageTokens),
            kinds: kindsOf(off),
            kindsEager: kindsOf(eager),
          },
        });
      }
  const summary: G1Summary[] = [];
  for (const [limit] of LIMITS)
    for (const length of LENGTHS) {
      const group = cells.filter((c) => c.limit === limit && c.length === length);
      summary.push({
        length,
        limit,
        messages: summarizeReductions(
          group.map((c) => ({ off: c.off.messageTokens, on: c.on.messageTokens })),
        ),
        request: summarizeReductions(
          group.map((c) => ({ off: c.off.requestTokens, on: c.on.requestTokens })),
        ),
        prefixReuse: {
          off: pooledShare(group.map((c) => c.prefixReuse.off)),
          on: pooledShare(group.map((c) => c.prefixReuse.on)),
          onEager: pooledShare(group.map((c) => c.prefixReuse.onEager)),
        },
        eager: {
          messages: summarizeReductions(
            group.map((c) => ({ off: c.off.messageTokens, on: c.onEager.messageTokens })),
          ),
          request: summarizeReductions(
            group.map((c) => ({ off: c.off.requestTokens, on: c.onEager.requestTokens })),
          ),
        },
      });
    }
  return {
    schema: G1_SCHEMA,
    harnessVersion: loadVersion(import.meta.url),
    basis: "estimated",
    synthetic: true,
    estimator: "estimateTokens: ceil(JSON characters / 4)",
    suite: STRESS_SUITE_ID,
    governorSettings: { minAgeTurns: 2, epochMessages: 32 },
    cells,
    summary,
  };
}

/** A readable table of the summary (all figures estimated, synthetic sessions). */
export function renderSummary(result: G1Result): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const lines = [
    `G1 token reduction, governor on vs off (ESTIMATED tokens, SYNTHETIC scripted sessions; suite ${result.suite}, harness ${result.harnessVersion})`,
    "",
    "| length | limit | tasks | shipped (epoch 32): conversation pooled | min | median | max | whole request pooled | eager (epoch 0, sensitivity): conversation pooled | whole request pooled | prefix reuse off / on / eager |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const s of result.summary)
    lines.push(
      `| ${s.length} | ${s.limit} | ${s.messages.tasks} | ${pct(s.messages.pooled)} | ${pct(s.messages.min)} | ${pct(s.messages.median)} | ${pct(s.messages.max)} | ${pct(s.request.pooled)} | ${pct(s.eager.messages.pooled)} | ${pct(s.eager.request.pooled)} | ${pct(s.prefixReuse.off)} / ${pct(s.prefixReuse.on)} / ${pct(s.prefixReuse.onEager)} |`,
    );
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const tmpRoot = mkdtempSync(join(tmpdir(), "governor-g1-"));
  try {
    const result = await measureSuite({ tmpRoot });
    if (values.out) writeFileSync(resolve(values.out), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(renderSummary(result));
    const bad = result.cells.filter(
      (c) => c.off.status !== "pass" || c.on.status !== "pass" || c.onEager.status !== "pass",
    );
    for (const c of bad)
      process.stderr.write(
        `governor-g1: ${c.taskId} ${c.length}/${c.limit}: off ${c.off.status}, on ${c.on.status}\n`,
      );
    return bad.length === 0 ? 0 : 1;
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(
        `governor-g1 failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
