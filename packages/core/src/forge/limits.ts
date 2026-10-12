/**
 * Forja limit merging: global ∩ project ∩ request. Pure: no I/O.
 *
 * The global layer (user config) picks values up to the hard maxima; project and request layers can
 * only lower them (spec D16). Projects may lower only a subset (§10); a request may lower any limit.
 */
import { ForgeError } from "./errors.ts";
import { MAX_MESSAGE_BYTES } from "./protocol.ts";

const KiB = 1024;
const MiB = 1024 * KiB;

export interface ForgeLimits {
  maxSourceBytes: number;
  timeoutMs: number;
  /** QuickJS heap. */
  memoryBytes: number;
  /** QuickJS stack. */
  stackBytes: number;
  /** Nested tool calls per execution. */
  maxToolCalls: number;
  /** Simultaneous nested tool calls. */
  maxConcurrency: number;
  maxCallInputBytes: number;
  maxCallResponseBytes: number;
  maxRetainedOutputBytes: number;
  /** Characters of output returned to the model. */
  maxOutputChars: number;
}

export type ForgeLimitKey = keyof ForgeLimits;

/**
 * The most a tool input may weigh: the protocol message that carries it (envelope, ids, tool name)
 * must fit in `MAX_MESSAGE_BYTES`, so the effective limit stays a little below it whatever the
 * configuration says. Over this a call is refused as `TOOL_INPUT_INVALID` before it is sent.
 */
export const MAX_CALL_INPUT_BYTES = MAX_MESSAGE_BYTES - 4 * KiB;

/** Defaults of the spec's §6.5 table. */
export const DEFAULT_FORGE_LIMITS: Readonly<ForgeLimits> = {
  maxSourceBytes: 64 * KiB,
  timeoutMs: 30_000,
  memoryBytes: 32 * MiB,
  stackBytes: 256 * KiB,
  maxToolCalls: 50,
  maxConcurrency: 4,
  maxCallInputBytes: 256 * KiB,
  maxCallResponseBytes: 512 * KiB,
  maxRetainedOutputBytes: 1 * MiB,
  maxOutputChars: 16_000,
};

/** Hard global maxima of the same table. */
export const MAX_FORGE_LIMITS: Readonly<ForgeLimits> = {
  maxSourceBytes: 64 * KiB,
  timeoutMs: 300_000,
  memoryBytes: 128 * MiB,
  stackBytes: 512 * KiB,
  maxToolCalls: 500,
  maxConcurrency: 16,
  maxCallInputBytes: 1 * MiB,
  maxCallResponseBytes: 2 * MiB,
  maxRetainedOutputBytes: 4 * MiB,
  maxOutputChars: 48_000,
};

/** The limits a project config may lower; the rest is global-only. */
export const PROJECT_LOWERABLE_LIMITS: readonly ForgeLimitKey[] = [
  "timeoutMs",
  "maxToolCalls",
  "maxConcurrency",
  "maxOutputChars",
];

export interface LimitLayers {
  global?: Partial<ForgeLimits>;
  project?: Partial<ForgeLimits>;
  request?: Partial<ForgeLimits>;
}

const KEYS = Object.keys(DEFAULT_FORGE_LIMITS) as ForgeLimitKey[];

function checked(layer: string, key: ForgeLimitKey, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ForgeError("INVALID_INPUT", `${layer} limit ${key} must be a positive integer`);
  }
  return value;
}

export function mergeLimits(layers: LimitLayers): ForgeLimits {
  const merged: ForgeLimits = { ...DEFAULT_FORGE_LIMITS };
  for (const key of KEYS) {
    const configured = layers.global?.[key];
    if (configured !== undefined) {
      merged[key] = Math.min(checked("global", key, configured), MAX_FORGE_LIMITS[key]);
    }
    const project = PROJECT_LOWERABLE_LIMITS.includes(key) ? layers.project?.[key] : undefined;
    if (project !== undefined)
      merged[key] = Math.min(merged[key], checked("project", key, project));
    const request = layers.request?.[key];
    if (request !== undefined)
      merged[key] = Math.min(merged[key], checked("request", key, request));
  }
  merged.maxCallInputBytes = Math.min(merged.maxCallInputBytes, MAX_CALL_INPUT_BYTES);
  return merged;
}

/** The limits the guest is told about in `start`; the host enforces them regardless. */
export type GuestLimits = Pick<
  ForgeLimits,
  | "timeoutMs"
  | "memoryBytes"
  | "stackBytes"
  | "maxToolCalls"
  | "maxConcurrency"
  | "maxCallInputBytes"
  | "maxCallResponseBytes"
  | "maxRetainedOutputBytes"
>;
