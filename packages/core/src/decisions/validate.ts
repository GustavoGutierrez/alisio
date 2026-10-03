import {
  type DecisionAnswer,
  type DecisionDefinition,
  type DecisionProvider,
  DecisionProviderError,
  type DecisionRejection,
  type DecisionRequest,
  DecisionRequestError,
} from "@alisio/sdk";

export const DECISION_LIMITS = {
  maxDecisions: 16,
  maxOptions: 20,
  minOptions: 2,
  maxLevels: 12,
  minLevels: 2,
  stateBytes: 16 * 1024,
  requestBytes: 32 * 1024,
} as const;

const DECISION_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const REQUEST_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const encoder = new TextEncoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const hasOwn = (object: object, key: string): boolean => Object.hasOwn(object, key);
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const unit = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

function bytes(value: unknown, what: string): number {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new DecisionRequestError(`${what} is not JSON-serializable`);
  }
  if (json === undefined) throw new DecisionRequestError(`${what} is not JSON-serializable`);
  return encoder.encode(json).length;
}

function validateDefinition(key: string, definition: unknown): void {
  const at = `decision "${key}"`;
  if (!isRecord(definition)) throw new DecisionRequestError(`${at} must be an object`);
  if (!nonEmpty(definition.instruction))
    throw new DecisionRequestError(`${at} needs a non-empty instruction`);
  switch (definition.type) {
    case "select": {
      const options = definition.options;
      if (!isRecord(options)) throw new DecisionRequestError(`${at} needs an options object`);
      const keys = Object.keys(options);
      if (keys.length < DECISION_LIMITS.minOptions || keys.length > DECISION_LIMITS.maxOptions)
        throw new DecisionRequestError(
          `${at} needs ${DECISION_LIMITS.minOptions}..${DECISION_LIMITS.maxOptions} options`,
        );
      for (const optionKey of keys) {
        if (!optionKey.trim() || optionKey === "__proto__")
          throw new DecisionRequestError(`${at} has an empty or reserved option key`);
        if (!nonEmpty(options[optionKey]))
          throw new DecisionRequestError(`${at} option "${optionKey}" needs a description`);
      }
      return;
    }
    case "boolean":
      for (const meaning of ["trueMeaning", "falseMeaning"] as const)
        if (definition[meaning] !== undefined && !nonEmpty(definition[meaning]))
          throw new DecisionRequestError(`${at} ${meaning} must be a non-empty string`);
      return;
    case "ordinal": {
      const levels = definition.levels;
      if (
        !Array.isArray(levels) ||
        levels.length < DECISION_LIMITS.minLevels ||
        levels.length > DECISION_LIMITS.maxLevels
      )
        throw new DecisionRequestError(
          `${at} needs ${DECISION_LIMITS.minLevels}..${DECISION_LIMITS.maxLevels} levels`,
        );
      if (!levels.every(nonEmpty)) throw new DecisionRequestError(`${at} has an empty level`);
      if (new Set(levels).size !== levels.length)
        throw new DecisionRequestError(`${at} has duplicate levels`);
      return;
    }
    default:
      throw new DecisionRequestError(`${at} has an unknown type`);
  }
}

/** Pure. Throws `DecisionRequestError` (a `TypeError`) before any provider is called. */
export function validateRequest(req: unknown): asserts req is DecisionRequest {
  if (!isRecord(req)) throw new DecisionRequestError("Decision request must be an object");
  if (req.version !== 1)
    throw new DecisionRequestError(`Unsupported decision request version: ${String(req.version)}`);
  if (typeof req.id !== "string" || !REQUEST_ID.test(req.id))
    throw new DecisionRequestError("Decision request id must match ^[a-z0-9][a-z0-9._-]{0,127}$");
  if (
    req.language !== undefined &&
    (typeof req.language !== "string" || !LANGUAGE.test(req.language))
  )
    throw new DecisionRequestError("Decision request language must be a BCP 47 tag");
  if (req.pack !== undefined) {
    const pack = req.pack;
    if (
      !isRecord(pack) ||
      typeof pack.id !== "string" ||
      !REQUEST_ID.test(pack.id) ||
      !Number.isInteger(pack.version) ||
      (pack.version as number) < 0
    )
      throw new DecisionRequestError("Decision request pack must be { id, version }");
  }
  if (!("state" in req) || req.state === undefined)
    throw new DecisionRequestError("Decision request needs a state");
  if (bytes(req.state, "state") > DECISION_LIMITS.stateBytes)
    throw new DecisionRequestError(`state exceeds ${DECISION_LIMITS.stateBytes} bytes`);
  const decisions = req.decisions;
  if (!isRecord(decisions)) throw new DecisionRequestError("Decision request needs decisions");
  const keys = Object.keys(decisions);
  if (keys.length < 1 || keys.length > DECISION_LIMITS.maxDecisions)
    throw new DecisionRequestError(
      `Decision request needs 1..${DECISION_LIMITS.maxDecisions} decisions`,
    );
  for (const key of keys) {
    if (!DECISION_KEY.test(key))
      throw new DecisionRequestError(`Invalid decision key: ${key.slice(0, 80)}`);
    validateDefinition(key, decisions[key]);
  }
  if (bytes(req, "request") > DECISION_LIMITS.requestBytes)
    throw new DecisionRequestError(
      `Decision request exceeds ${DECISION_LIMITS.requestBytes} bytes`,
    );
}

/** Which decisions the provider can take and which it cannot (those are never sent). */
export function splitSupported(
  req: DecisionRequest,
  provider: Pick<DecisionProvider, "capabilities">,
): { supported: string[]; unsupported: string[] } {
  const supported: string[] = [];
  const unsupported: string[] = [];
  for (const [key, definition] of Object.entries(req.decisions))
    (provider.capabilities[definition.type] === true ? supported : unsupported).push(key);
  return { supported, unsupported };
}

function rebuild(definition: DecisionDefinition, raw: unknown): DecisionAnswer | undefined {
  if (!isRecord(raw) || raw.type !== definition.type || !unit(raw.confidence)) return undefined;
  const confidence = raw.confidence;
  switch (definition.type) {
    case "select": {
      if (typeof raw.value !== "string" || !hasOwn(definition.options, raw.value)) return undefined;
      const answer: DecisionAnswer = { type: "select", value: raw.value, confidence };
      const p = raw.probabilities;
      if (
        isRecord(p) &&
        Object.entries(p).every(([k, v]) => hasOwn(definition.options, k) && unit(v))
      )
        answer.probabilities = Object.fromEntries(Object.entries(p) as Array<[string, number]>);
      return answer;
    }
    case "boolean":
      if (typeof raw.value !== "boolean" || !unit(raw.probability)) return undefined;
      return { type: "boolean", value: raw.value, confidence, probability: raw.probability };
    case "ordinal": {
      if (typeof raw.level !== "string") return undefined;
      const index = definition.levels.indexOf(raw.level);
      if (index < 0 || raw.index !== index) return undefined;
      const answer: DecisionAnswer = { type: "ordinal", level: raw.level, index, confidence };
      const d = raw.distribution;
      if (Array.isArray(d) && d.length === definition.levels.length && d.every(unit))
        answer.distribution = [...(d as number[])];
      return answer;
    }
  }
}

/**
 * Pure. Validates a provider result decision by decision against the request. Answers are rebuilt
 * from known fields only. A result that is not `{ decisions: {…} }` is a provider failure and
 * throws `DecisionProviderError("invalid_response")`.
 */
export function validateAnswers(
  req: DecisionRequest,
  provider: Pick<DecisionProvider, "capabilities">,
  raw: unknown,
  minConfidence: number,
): { accepted: Record<string, DecisionAnswer>; rejected: Record<string, DecisionRejection> } {
  if (!isRecord(raw) || !isRecord(raw.decisions))
    throw new DecisionProviderError("invalid_response", "Provider result has no decisions object");
  const answers = raw.decisions;
  const accepted: Record<string, DecisionAnswer> = {};
  const rejected: Record<string, DecisionRejection> = {};
  for (const [key, definition] of Object.entries(req.decisions)) {
    if (provider.capabilities[definition.type] !== true) {
      rejected[key] = "unsupported";
      continue;
    }
    if (!hasOwn(answers, key)) {
      rejected[key] = "missing";
      continue;
    }
    const answer = rebuild(definition, answers[key]);
    if (!answer) rejected[key] = "invalid";
    else if (answer.confidence < minConfidence) rejected[key] = "low_confidence";
    else accepted[key] = answer;
  }
  return { accepted, rejected };
}
