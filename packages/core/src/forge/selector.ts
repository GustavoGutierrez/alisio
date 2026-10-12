/**
 * Engine selection as a chain of responsibility (spec §4.2, §7.2): ordered, deterministic rules,
 * each returning a decision with its reason or passing to the next. The model never picks the
 * engine. The chain is generic so the Python backend selector reuses it with its own context.
 */
import type { EngineDescriptor, EngineId, EngineLanguage } from "@alisio/sdk";
import { ForgeError, type ForgeErrorCode } from "./errors.ts";

export interface Selection<I extends string> {
  engine: I;
  reason: string;
}

export interface Rejection {
  rejected: true;
  reason: string;
  code: ForgeErrorCode;
}

/** `null` passes to the next rule. */
export type RuleOutcome<I extends string> = Selection<I> | Rejection | null;
export type SelectionRule<C, I extends string> = (context: C) => RuleOutcome<I>;

export const select = <I extends string>(engine: I, reason: string): Selection<I> => ({
  engine,
  reason,
});

export const reject = (reason: string, code: ForgeErrorCode = "ENGINE_UNAVAILABLE"): Rejection => ({
  rejected: true,
  reason,
  code,
});

export class EngineSelector<C, I extends string> {
  readonly #rules: readonly SelectionRule<C, I>[];

  constructor(rules: readonly SelectionRule<C, I>[]) {
    this.#rules = rules;
  }

  /** The first rule that decides wins; a rejection throws and no rule means unavailable. */
  select(context: C): Selection<I> {
    for (const rule of this.#rules) {
      const outcome = rule(context);
      if (outcome === null) continue;
      if ("rejected" in outcome) throw new ForgeError(outcome.code, outcome.reason);
      return outcome;
    }
    throw new ForgeError("ENGINE_UNAVAILABLE", "No selection rule matched the request");
  }
}

export interface JavaScriptSelectionContext {
  language: EngineLanguage;
  /** `forge.javascript.enabled`. */
  javascriptEnabled: boolean;
  descriptors: Partial<Record<EngineId, EngineDescriptor>>;
}

const JAVASCRIPT_ENGINE: EngineId = "javascript-quickjs";

const javascriptDisabled: SelectionRule<JavaScriptSelectionContext, EngineId> = (c) =>
  c.language === "javascript" && !c.javascriptEnabled ? reject("disabled by config") : null;

const javascriptNotReady: SelectionRule<JavaScriptSelectionContext, EngineId> = (c) => {
  if (c.language !== "javascript") return null;
  const descriptor = c.descriptors[JAVASCRIPT_ENGINE];
  if (!descriptor) return reject(`engine ${JAVASCRIPT_ENGINE} is not registered`);
  if (!descriptor.ready)
    return reject(descriptor.reason ?? `engine ${JAVASCRIPT_ENGINE} is not ready`);
  return null;
};

const javascriptDefault: SelectionRule<JavaScriptSelectionContext, EngineId> = (c) =>
  c.language === "javascript" ? select(JAVASCRIPT_ENGINE, "language=javascript") : null;

const NO_ENGINE_FOR_LANGUAGE: SelectionRule<JavaScriptSelectionContext, EngineId> = (c) =>
  c.language === "javascript" ? null : reject(`no engine rule for language ${c.language}`);

/** The JavaScript chain of §7.2. Python's chain lives with the Python backend. */
export function createJavaScriptSelector(): EngineSelector<JavaScriptSelectionContext, EngineId> {
  return new EngineSelector([
    javascriptDisabled,
    javascriptNotReady,
    javascriptDefault,
    NO_ENGINE_FOR_LANGUAGE,
  ]);
}
