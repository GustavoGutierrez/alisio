/**
 * Pure logic of the Forja tool cards (Forja spec §11.2, Python spec §9.4): which cards exist, the
 * engine and isolation badge, what the `js_run` result text says, what a `python_run` card knows
 * about its engine and the provenance rows of an artifact. No DOM or signals.
 */
import type { EngineId, IsolationLevel } from "@alisio/sdk";
import type { MessageKey } from "../i18n/en.ts";
import { t } from "../i18n/index.ts";
import type { ToolStatus } from "../store/transcript.ts";
import { callCounts, type ForgeView } from "./forge.ts";

export type CardKind = "javascript" | "python" | "generic";

/** Only the two Forja tools get a card of their own; `execute` (old sessions) stays generic. */
export function cardKind(name: string): CardKind {
  if (name === "js_run") return "javascript";
  if (name === "python_run") return "python";
  return "generic";
}

const ENGINES: readonly EngineId[] = [
  "javascript-quickjs",
  "python-managed",
  "python-oci",
  "python-wasm",
];
const ISOLATIONS: readonly IsolationLevel[] = [
  "os-container",
  "wasm-isolate",
  "wasm-process",
  "none",
];
const isEngine = (value: unknown): value is EngineId => ENGINES.includes(value as EngineId);
const isIsolation = (value: unknown): value is IsolationLevel =>
  ISOLATIONS.includes(value as IsolationLevel);

/** The isolation an engine normally has; the reported one wins when a result carries it. */
export const usualIsolation = (engine: EngineId): IsolationLevel =>
  engine === "javascript-quickjs"
    ? "wasm-isolate"
    : engine === "python-oci"
      ? "os-container"
      : engine === "python-wasm"
        ? "wasm-process"
        : "none";

export interface EngineBadge {
  label: MessageKey;
  /** `warn` for code that runs with the user's own privileges. */
  tone: "ok" | "warn";
  /** A different icon for the unprotected case: colour is never the only cue. */
  icon: "shield" | "alert";
  sandboxed: boolean;
}

export function engineBadge(engine: EngineId, isolation?: IsolationLevel): EngineBadge {
  const level = isolation ?? usualIsolation(engine);
  const sandboxed = level !== "none";
  const label: MessageKey =
    engine === "javascript-quickjs"
      ? "forge.badge.javascript"
      : level === "os-container"
        ? "forge.badge.pythonOci"
        : level === "none"
          ? "forge.badge.pythonHost"
          : "forge.badge.pythonWasm";
  return {
    label,
    tone: sandboxed ? "ok" : "warn",
    icon: sandboxed ? "shield" : "alert",
    sandboxed,
  };
}

export interface EngineInfo {
  engine: EngineId;
  isolation?: IsolationLevel;
  reason?: string;
}

const ENGINE_LINE = /^engine: (\S+) \((\S+)\) · reason: (.*)$/m;

/** `engine: <id> (<isolation>) · reason: …`, the last line of a `python_run` result. */
export function parseEngineLine(text: string): Required<EngineInfo> | undefined {
  const match = ENGINE_LINE.exec(text);
  if (!match) return undefined;
  const [, engine, isolation, reason] = match;
  return isEngine(engine) && isIsolation(isolation)
    ? { engine, isolation, reason: reason ?? "" }
    : undefined;
}

/** What a card knows of its engine: the finished result first, the live progress before it. */
export function engineOfCard(source: {
  resultText?: string;
  forgeEngine?: EngineId;
}): EngineInfo | undefined {
  const line = source.resultText ? parseEngineLine(source.resultText) : undefined;
  if (line) return line;
  return source.forgeEngine ? { engine: source.forgeEngine } : undefined;
}

export interface JsResult {
  status: string;
  value?: unknown;
  /** The text the script emitted. */
  output?: string;
  calls?: { total: number; failed: number; denied: number };
  error?: { code: string; message: string };
  /** Where the model is told to look (`forge_guide topic …`). */
  hint?: string;
  /** The output or the message was cut to the output limit. */
  truncated: boolean;
}

const CALLS_LINE = /^calls: (\d+) total, (\d+) failed, (\d+) denied$/;
const ERROR_LINE = /^([A-Z][A-Z_]+): ([\s\S]*)$/;

/** The text of `js_run` (`status:`, `value:`, `output:`, `calls:`, `error:`, `hint:`) as data. */
export function parseJsResult(text: string): JsResult | undefined {
  const lines = text.split("\n");
  const first = lines[0] ?? "";
  if (!first.startsWith("status: ")) {
    // A call refused before it started: `INVALID_INPUT: …`, no report.
    const refused = ERROR_LINE.exec(text);
    return refused
      ? {
          status: "failed",
          error: { code: refused[1] ?? "", message: refused[2] ?? "" },
          truncated: false,
        }
      : undefined;
  }
  let callsAt = -1;
  for (let i = lines.length - 1; i > 0; i--)
    if (CALLS_LINE.test(lines[i] ?? "")) {
      callsAt = i;
      break;
    }
  const body = lines.slice(1, callsAt < 0 ? undefined : callsAt);
  const tail = callsAt < 0 ? [] : lines.slice(callsAt + 1);
  let truncated = false;
  const isNote = (line: string) =>
    /^\[(output truncated at|error message truncated at) /.test(line);
  const clean = (rows: string[]) =>
    rows.filter((line) => {
      if (!isNote(line)) return true;
      truncated = true;
      return false;
    });
  const bodyRows = clean(body);
  const out: JsResult = { status: first.slice("status: ".length).trim(), truncated: false };
  let rest = bodyRows;
  if (rest[0]?.startsWith("value: ")) {
    const raw = rest[0].slice("value: ".length);
    try {
      out.value = JSON.parse(raw);
    } catch {
      out.value = raw;
    }
    rest = rest.slice(1);
  }
  if (rest[0] === "output:") out.output = rest.slice(1).join("\n");
  else if (rest.length) out.output = rest.join("\n");
  const counters = callsAt < 0 ? undefined : CALLS_LINE.exec(lines[callsAt] ?? "");
  if (counters)
    out.calls = {
      total: Number(counters[1]),
      failed: Number(counters[2]),
      denied: Number(counters[3]),
    };
  const tailRows = clean(tail);
  const hintAt = tailRows.findIndex((line) => line.startsWith("hint: "));
  const errorRows = hintAt < 0 ? tailRows : tailRows.slice(0, hintAt);
  if (hintAt >= 0) out.hint = tailRows.slice(hintAt).join("\n").slice("hint: ".length);
  if (errorRows[0]?.startsWith("error: ")) {
    const error = ERROR_LINE.exec(
      [errorRows[0].slice("error: ".length), ...errorRows.slice(1)].join("\n"),
    );
    if (error) out.error = { code: error[1] ?? "", message: error[2] ?? "" };
  }
  out.truncated = truncated;
  return out;
}

/** The script of a `js_run` call: inline code, or the scratchpad file it runs. */
export function codeOf(args: string): { code?: string; codePath?: string; title?: string } {
  try {
    const record = JSON.parse(args) as Record<string, unknown>;
    return {
      ...(typeof record.code === "string" ? { code: record.code } : {}),
      ...(typeof record.codePath === "string" ? { codePath: record.codePath } : {}),
      ...(typeof record.title === "string" && record.title.trim()
        ? { title: record.title.trim() }
        : {}),
    };
  } catch {
    return {};
  }
}

export interface ProvenanceEngine extends Partial<Pick<EngineInfo, "engine">> {
  isolation?: string;
  reason?: string;
  startupMs?: number;
  peakRssMb?: number;
}

/** Engine, isolation and selection reason of an artifact (and the wasm numbers), if recorded. */
export function provenanceEngine(p: Record<string, unknown>): ProvenanceEngine | undefined {
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const runtime = (p.runtime ?? {}) as Record<string, unknown>;
  const num = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const out = {
    ...(text(p.engine) ? { engine: text(p.engine) as EngineId } : {}),
    ...(text(p.isolation) ? { isolation: text(p.isolation) } : {}),
    ...(text(p.selectionReason) ? { reason: text(p.selectionReason) } : {}),
    ...(num(runtime.startupMs) !== undefined ? { startupMs: num(runtime.startupMs) } : {}),
    ...(num(runtime.peakRssMb) !== undefined ? { peakRssMb: num(runtime.peakRssMb) } : {}),
  } as ProvenanceEngine;
  return out.engine || out.isolation || out.reason ? out : undefined;
}
/**
 * What a polite live region says about a card: its state, and for a running one how many nested
 * calls have finished. The text depends on that state only, so a re-render with fresh timings or a
 * new progress message announces nothing.
 */
export function liveAnnouncement(status: ToolStatus, view: ForgeView | undefined): string {
  if (status === "completed") return t("forge.live.done");
  if (status === "failed") return t("forge.live.failed");
  if (status !== "running") return "";
  if (!view?.calls.length) return t("forge.live.running");
  const counts = callCounts(view);
  return t("forge.live.runningCalls", {
    done: counts.total - counts.running,
    total: counts.total,
  });
}
