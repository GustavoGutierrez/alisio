/**
 * The common Forja protocol (spec §5.4, D10): one logical message schema over several transports.
 * This module is the host-side validator of what the guest sends. Shape is checked with Ajv; the
 * stateful rules (sequence, call correlation, terminal closure, capability gate) are plain code.
 * Every rejection is a `PROTOCOL_VIOLATION` and the caller terminates the execution.
 */
import type { EngineId } from "@alisio/sdk";
import Ajv, { type ValidateFunction } from "ajv";
import { FORGE_ERROR_CODES, ForgeError, type ForgeErrorCode } from "./errors.ts";
import type { GuestLimits } from "./limits.ts";

export const MAX_MESSAGE_BYTES = 256 * 1024;
/** The registry's naming rule (`ToolRegistry.register`); the protocol refuses any other name. */
export const TOOL_NAME_PATTERN = "^[a-zA-Z0-9_-]{1,64}$";
export const MAX_JSON_DEPTH = 32;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export type ForgeOutputItem = { type: "text"; text: string } | { type: "json"; value: unknown };

export interface Envelope<T extends string, P> {
  protocol: 1;
  type: T;
  /** Strictly increasing per direction. */
  seq: number;
  payload: P;
}

/** Guest to host. */
export type GuestMessage =
  | Envelope<"ready", { engine: EngineId; preludeHash: string }>
  | Envelope<"progress", { message: string; completed?: number; total?: number }>
  | Envelope<"output", ForgeOutputItem>
  | Envelope<"state.set", { key: string; value: unknown }>
  | Envelope<"state.delete", { key: string }>
  /** Only when the engine's `capabilities.toolCalls` is true. */
  | Envelope<"call", { callId: number; tool: string; input: unknown }>
  | Envelope<
      "catalog",
      { requestId: number; op: "search" | "describe"; query: string; limit?: number }
    >
  | Envelope<"complete", { value?: unknown }>
  | Envelope<"fatal", { code: ForgeErrorCode; message: string }>;

/** Host to guest. */
export type HostMessage =
  | Envelope<
      "start",
      { source: string; state: Record<string, unknown>; limits: GuestLimits; catalogSize: number }
    >
  | Envelope<
      "result",
      | { callId: number; ok: true; value: unknown }
      | { callId: number; ok: false; error: { code: ForgeErrorCode; message: string } }
    >
  | Envelope<"catalog.result", { requestId: number; entries: unknown[] }>
  /** Backpressure credits. */
  | Envelope<"grant", { calls: number; bytes: number }>;

export type GuestMessageType = GuestMessage["type"];

const ENGINE_IDS: EngineId[] = [
  "javascript-quickjs",
  "python-managed",
  "python-oci",
  "python-wasm",
];

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const count = { type: "number", minimum: 0 };
const id = { type: "integer", minimum: 0 };

const PAYLOAD_SCHEMAS: Record<GuestMessageType, unknown> = {
  ready: obj({ engine: { enum: ENGINE_IDS }, preludeHash: { type: "string" } }, [
    "engine",
    "preludeHash",
  ]),
  progress: obj({ message: { type: "string" }, completed: count, total: count }, ["message"]),
  output: {
    oneOf: [
      obj({ type: { const: "text" }, text: { type: "string" } }, ["type", "text"]),
      obj({ type: { const: "json" }, value: {} }, ["type", "value"]),
    ],
  },
  "state.set": obj({ key: { type: "string", minLength: 1 }, value: {} }, ["key", "value"]),
  "state.delete": obj({ key: { type: "string", minLength: 1 } }, ["key"]),
  call: obj(
    {
      callId: id,
      tool: { type: "string", minLength: 1, maxLength: 128, pattern: TOOL_NAME_PATTERN },
      input: {},
    },
    ["callId", "tool", "input"],
  ),
  catalog: obj(
    {
      requestId: id,
      op: { enum: ["search", "describe"] },
      query: { type: "string" },
      limit: { type: "integer", minimum: 1 },
    },
    ["requestId", "op", "query"],
  ),
  complete: obj({ value: {} }, []),
  fatal: obj({ code: { enum: [...FORGE_ERROR_CODES] }, message: { type: "string" } }, [
    "code",
    "message",
  ]),
};

const ENVELOPE_SCHEMA = obj(
  {
    protocol: { const: 1 },
    type: { enum: Object.keys(PAYLOAD_SCHEMAS) },
    seq: { type: "integer", minimum: 0 },
    payload: { type: "object" },
  },
  ["protocol", "type", "seq", "payload"],
);

const ajv = new Ajv({ allErrors: true, strict: true });
const validateEnvelope = ajv.compile(ENVELOPE_SCHEMA);
const validatePayload = new Map<string, ValidateFunction>(
  Object.entries(PAYLOAD_SCHEMAS).map(([type, schema]) => [type, ajv.compile(schema as object)]),
);

/** Returns why `value` is not plain JSON within the depth bound, or undefined when it is. */
function jsonViolation(value: unknown, depth: number): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : "non-finite number";
  if (typeof value !== "object") return `non-JSON value (${typeof value})`;
  if (depth > MAX_JSON_DEPTH) return `JSON deeper than ${MAX_JSON_DEPTH} levels`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const reason = jsonViolation(value[i], depth + 1);
      if (reason) return reason;
    }
    return undefined;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return "non-plain object";
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return `forbidden key ${key}`;
    const reason = jsonViolation((value as Record<string, unknown>)[key], depth + 1);
    if (reason) return reason;
  }
  return undefined;
}

export type GuestValidation =
  | { ok: true; message: GuestMessage }
  | { ok: false; error: ForgeError };
export type Correlation = { ok: true } | { ok: false; error: ForgeError };

const violation = (reason: string): { ok: false; error: ForgeError } => ({
  ok: false,
  error: new ForgeError("PROTOCOL_VIOLATION", reason),
});

export class GuestMessageValidator {
  readonly #toolCalls: boolean;
  #lastSeq = -1;
  #closed = false;
  readonly #pendingCalls = new Set<number>();
  readonly #usedCalls = new Set<number>();
  readonly #pendingCatalog = new Set<number>();
  readonly #usedCatalog = new Set<number>();

  constructor(options: { toolCalls: boolean }) {
    this.#toolCalls = options.toolCalls;
  }

  /** Validates one guest message. Any violation closes the validator for good. */
  accept(raw: unknown): GuestValidation {
    const result = this.#check(raw);
    if (!result.ok) this.#closed = true;
    return result;
  }

  /** Marks a call as answered by the host; unknown or already answered ids are violations. */
  resolveCall(callId: number): Correlation {
    if (!this.#pendingCalls.delete(callId)) {
      return violation(`callId ${callId} is unknown or already resolved`);
    }
    return { ok: true };
  }

  resolveCatalog(requestId: number): Correlation {
    if (!this.#pendingCatalog.delete(requestId)) {
      return violation(`catalog requestId ${requestId} is unknown or already resolved`);
    }
    return { ok: true };
  }

  /** The execution reached a terminal state: nothing more is accepted. */
  close(): void {
    this.#closed = true;
  }

  #check(raw: unknown): GuestValidation {
    if (this.#closed) return violation("message after the channel was closed");
    const unsafe = jsonViolation(raw, 1);
    if (unsafe) return violation(unsafe);
    if (Buffer.byteLength(JSON.stringify(raw), "utf8") > MAX_MESSAGE_BYTES) {
      return violation(`message larger than ${MAX_MESSAGE_BYTES} bytes`);
    }
    if (!validateEnvelope(raw)) return violation("malformed envelope or unknown message type");
    const message = raw as unknown as GuestMessage;
    if (!validatePayload.get(message.type)?.(message.payload)) {
      return violation(`invalid payload for ${message.type}`);
    }
    if (message.seq <= this.#lastSeq) return violation(`seq ${message.seq} is not increasing`);
    if ((message.type === "call" || message.type === "catalog") && !this.#toolCalls) {
      return violation(`${message.type} is not allowed: this engine cannot call tools`);
    }
    if (message.type === "call") {
      const callId = message.payload.callId;
      if (this.#usedCalls.has(callId)) return violation(`callId ${callId} was already used`);
      this.#usedCalls.add(callId);
      this.#pendingCalls.add(callId);
    } else if (message.type === "catalog") {
      const requestId = message.payload.requestId;
      if (this.#usedCatalog.has(requestId)) {
        return violation(`catalog requestId ${requestId} was already used`);
      }
      this.#usedCatalog.add(requestId);
      this.#pendingCatalog.add(requestId);
    }
    this.#lastSeq = message.seq;
    if (message.type === "complete" || message.type === "fatal") this.#closed = true;
    return { ok: true, message };
  }
}
