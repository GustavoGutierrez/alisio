/**
 * `PythonBackendSelector` (Python spec §6.1): a chain of pure rules, each `(context) -> decision |
 * next`. It decides once, before anything is prepared (PD5: no fallback after a run started), from
 * facts the caller already gathered; it never probes.
 *
 *  1. an explicit `analysis.runtime` (`managed`, `oci`, `wasm`) runs there or fails with the reason
 *     and the way out; a policy (`analysis.isolation`) that forbids it is an error too;
 *  2. `auto` + `rerunOf`: back to the original backend when it is ready, fits and the policy allows;
 *  3. `auto`: oci -> wasm -> managed, the first eligible one;
 *  4. nothing eligible: `ENGINE_UNAVAILABLE` with every reason and the shortest command.
 */
import type { EngineId } from "@alisio/sdk";
import { EngineSelector, reject, type SelectionRule, select } from "../selector.ts";
import type { BackendReadiness, PythonBackendId, SupportVerdict } from "./backend.ts";

export type PythonRuntimeSetting = "auto" | PythonBackendId;
export type IsolationPolicy = "preferred" | "required" | "strict";

export interface PythonSelectionContext {
  /** `analysis.runtime`. */
  runtime: PythonRuntimeSetting;
  /** `analysis.isolation`; `preferred` when absent. */
  isolation?: IsolationPolicy;
  /** Backend of the execution a `rerunOf` repeats. */
  rerunOfBackend?: PythonBackendId;
  /** What the caller found out; a backend missing here was not checked and is not ready. */
  readiness: Partial<Record<PythonBackendId, BackendReadiness>>;
  /** `backend.supports(requirements)` per backend; a backend missing here fits. */
  support?: Partial<Record<PythonBackendId, SupportVerdict>>;
  /** `networkDeniedByOS` of each backend's descriptor; missing means open. Needed by `strict`. */
  networkDenied?: Partial<Record<PythonBackendId, boolean>>;
}

/** Candidates of `auto`, most isolated first. */
const AUTO_ORDER: readonly PythonBackendId[] = ["oci", "wasm", "managed"];

/** Higher is more isolated. */
const ISOLATION_RANK: Record<PythonBackendId, number> = { managed: 0, wasm: 1, oci: 2 };

/** The command that would make a not-ready backend ready; `fix: ""` says none would. */
const fixOf = (
  state: Extract<BackendReadiness, { ready: false }>,
  backend: PythonBackendId,
): string | undefined => (state.fix !== undefined ? state.fix || undefined : SETUP[backend]);

/** The setup command of a backend that can be made ready. */
const SETUP: Partial<Record<PythonBackendId, string>> = {
  oci: "alisio analysis setup --oci",
  wasm: "alisio analysis setup --wasm",
};

export const engineIdOf = (backend: PythonBackendId): EngineId => `python-${backend}`;

/** The backends worth probing for this call. */
export function neededBackends(context: {
  runtime: PythonRuntimeSetting;
  isolation?: IsolationPolicy;
  rerunOfBackend?: PythonBackendId;
}): PythonBackendId[] {
  const hostAllowed = (context.isolation ?? "preferred") === "preferred";
  const wanted: PythonBackendId[] =
    context.runtime === "auto"
      ? AUTO_ORDER.filter((backend) => backend !== "managed" || hostAllowed)
      : [context.runtime];
  if (context.rerunOfBackend && (context.rerunOfBackend !== "managed" || hostAllowed))
    wanted.push(context.rerunOfBackend);
  return [...new Set(wanted)];
}

const readyOf = (context: PythonSelectionContext, backend: PythonBackendId): BackendReadiness =>
  context.readiness[backend] ?? { ready: false, reason: `${backend} was not checked` };

const isolationOf = (context: PythonSelectionContext): IsolationPolicy =>
  context.isolation ?? "preferred";

/** Why the policy alone rules a backend out, or undefined. */
function policyExclusion(
  context: PythonSelectionContext,
  backend: PythonBackendId,
): string | undefined {
  const policy = isolationOf(context);
  if (backend === "managed" && policy !== "preferred")
    return `excluded by analysis.isolation=${policy} (it runs on the host)`;
  if (policy === "strict" && context.networkDenied?.[backend] !== true)
    return `excluded by analysis.isolation=strict (its network is not denied by the OS)`;
  return undefined;
}

type Eligibility = { ok: true } | { ok: false; reason: string; fix?: string };

/** Policy, then readiness, then fit. */
function eligibility(context: PythonSelectionContext, backend: PythonBackendId): Eligibility {
  const excluded = policyExclusion(context, backend);
  if (excluded) return { ok: false, reason: excluded };
  const state = readyOf(context, backend);
  if (!state.ready) {
    const fix = fixOf(state, backend);
    return { ok: false, reason: `not ready (${state.reason})`, ...(fix ? { fix } : {}) };
  }
  const verdict = context.support?.[backend];
  if (verdict && !verdict.ok)
    return { ok: false, reason: verdict.reason, ...(verdict.fix ? { fix: verdict.fix } : {}) };
  return { ok: true };
}

type Rule = SelectionRule<PythonSelectionContext, PythonBackendId>;

/** Why a rerun did not use its original backend, for the reason line. */
function rerunNote(context: PythonSelectionContext, chosen: PythonBackendId): string {
  const original = context.rerunOfBackend;
  if (!original || original === chosen) return "";
  const state = eligibility(context, original);
  return state.ok ? "" : `; rerun: original backend ${original} not used (${state.reason})`;
}

/** Rule 1: the explicit runtime, as is. Not ready or not fitting is an error with the way out. */
const explicitRuntime: Rule = (context) => {
  const { runtime } = context;
  if (runtime === "auto") return null;
  const policy = policyExclusion(context, runtime);
  if (policy)
    return reject(
      `${runtime} ${policy.replace(/^excluded/, "is excluded")}; set analysis.runtime=auto (or another backend) or relax analysis.isolation`,
    );
  const state = readyOf(context, runtime);
  const setup = state.ready ? undefined : fixOf(state, runtime);
  const way = (fix: string | undefined) =>
    `; set analysis.runtime=auto${fix ? ` or run "${fix}"` : ""}`;
  if (!state.ready)
    return reject(
      `${runtime} is not ready: ${state.reason}${runtime === "managed" ? "" : way(setup)}`,
    );
  const verdict = context.support?.[runtime];
  if (verdict && !verdict.ok)
    return reject(`${runtime} cannot run this script: ${verdict.reason}${way(verdict.fix)}`);
  // A rerun of an execution that ran right here is a repeat, and the reason says so.
  return select(
    runtime,
    context.rerunOfBackend === runtime
      ? `rerun: original backend ${runtime}`
      : `analysis.runtime=${runtime}`,
  );
};

/** Rule 2: under `auto`, a rerun goes back to the backend that ran the original when it can. */
const rerunOriginalBackend: Rule = (context) => {
  const original = context.rerunOfBackend;
  if (!original || context.runtime !== "auto") return null;
  return eligibility(context, original).ok
    ? select(original, `rerun: original backend ${original}`)
    : null;
};

/** Rules 3 and 4: the first eligible candidate of `auto`, or the reasons nothing was. */
const autoChain: Rule = (context) => {
  if (context.runtime !== "auto") return null;
  const skipped: string[] = [];
  const fixes: Array<{ backend: PythonBackendId; fix: string }> = [];
  for (const backend of AUTO_ORDER) {
    const state = eligibility(context, backend);
    if (state.ok) {
      const why = skipped.length ? `; ${skipped.join("; ")}` : "";
      return select(
        backend,
        `analysis.runtime=auto, analysis.isolation=${isolationOf(context)}: ${backend} is ready${why}${rerunNote(context, backend)}`,
      );
    }
    skipped.push(`${backend}: ${state.reason}`);
    if (state.fix) fixes.push({ backend, fix: state.fix });
  }
  // The least effort first: wasm needs no container engine, so its command comes before oci's.
  const fix = [...fixes].sort((a, b) => ISOLATION_RANK[a.backend] - ISOLATION_RANK[b.backend])[0];
  return reject(
    `no Python backend can run this script (analysis.isolation=${isolationOf(context)}): ${skipped.join("; ")}${fix ? `. Shortest fix: run "${fix.fix}"` : ""}`,
  );
};

const RULES: readonly Rule[] = [explicitRuntime, rerunOriginalBackend, autoChain];

export function createPythonBackendSelector(): EngineSelector<
  PythonSelectionContext,
  PythonBackendId
> {
  return new EngineSelector(RULES);
}
