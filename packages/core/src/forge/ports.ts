/**
 * Ports of the Forja core (hexagonal). Engines, hosts, transports and stores are adapters; the
 * core never depends on QuickJS, Pyodide, Docker or SQLite. Types only: no runtime code.
 *
 * Later phases add the remaining ports (`IsolateHost`, `Transport`, `ExecutionJournal`,
 * `StateStore`, `GuideProvider`) next to these.
 */
import type {
  EngineDescriptor,
  EngineId,
  EngineLanguage,
  IsolationLevel,
  PermissionMode,
} from "@alisio/sdk";
import type { ForgeErrorCode } from "./errors.ts";
import type { ForgeLimits } from "./limits.ts";
import type { GuestMessage, HostMessage } from "./protocol.ts";

export type { EngineDescriptor, EngineId, EngineLanguage, IsolationLevel };

export interface ExecutionRequest {
  language: EngineLanguage;
  source: string;
  title?: string;
  /** Can only lower the effective limits. */
  requestedLimits?: Partial<ForgeLimits>;
  /** Configured or forced by the user; never chosen by the model. */
  engineHint?: EngineId;
  /** Per-engine extensions (inputs, extras, rerunOf...). */
  payload?: Record<string, unknown>;
}

/**
 * Built only by the core from the runner's tool context. No field of the model's input can
 * override it.
 */
export interface TrustedExecutionContext {
  executionId: string;
  toolCallId: string;
  rootSessionId: string;
  workspace: string;
  permissionMode: PermissionMode;
  allowAnalysis: boolean;
  allowProcess: boolean;
  signal: AbortSignal;
  limits: ForgeLimits;
}

/** An execution ready to run; engines extend it with their own handles. */
export interface PreparedExecution {
  readonly executionId: string;
  readonly engine: EngineId;
  readonly limits: ForgeLimits;
  /** The `analysis_executions` row this execution created (Python); the journal links to it. */
  readonly analysisExecutionId?: string;
}

export type TerminationReason = "cancelled" | "timeout" | "protocol_violation" | "limit_exceeded";

export interface TerminationReport {
  /** The host checked that the guest no longer runs. */
  confirmed: boolean;
  method: "interrupt" | "terminate" | "kill" | "container-kill";
  elapsedMs: number;
  /** Resolves once the guest is finally gone; lets an unconfirmed termination keep its slot until then. */
  settled?: Promise<void>;
}

export type EngineOutcome =
  | { kind: "completed"; value?: unknown }
  | { kind: "failed"; code: ForgeErrorCode; message: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A message for the guest without the envelope fields the transport stamps (`protocol`, `seq`). */
export type HostReply = DistributiveOmit<HostMessage, "protocol" | "seq">;

/**
 * The kernel's side of an execution, handed to the engine's `run`. The engine owns the transport
 * and the isolate; the kernel decides what each guest message means.
 */
export interface KernelChannel {
  /**
   * Called by the engine for every guest message that passed validation (schema, sequence,
   * correlation, size, capability gate), CONCURRENTLY: a slow `call` never blocks the next
   * message. The optional reply goes to the guest. Throwing a `ForgeError` ends the execution with
   * that code.
   */
  receive(message: GuestMessage): Promise<HostReply | undefined>;
  /** Called once by the engine with the function that sends a message to the guest (credit grants). */
  bind(send: (reply: HostReply) => void): void;
  /** Aborted when the kernel stops the execution (cancellation or deadline). */
  readonly signal: AbortSignal;
}

/** Isolation hosts (spec §6.3, D-20): where the VM runs, and how it is stopped. */
export interface IsolateExit {
  code: number | null;
  signal: string | null;
  /** Spawn or worker error, when the isolate could not run at all. */
  error?: string;
}

export interface IsolateSession {
  readonly kind: "worker" | "process";
  /** Raw guest messages; validation is the engine's job. */
  onMessage(handler: (raw: unknown) => void): void;
  /** The stream broke (oversized or malformed frame): a protocol violation. */
  onStreamError(handler: (reason: string) => void): void;
  send(message: unknown): void;
  readonly exited: Promise<IsolateExit>;
  /** Stops the guest by the host's own means and reports whether it is confirmed gone. */
  stop(reason: TerminationReason): Promise<TerminationReport>;
}

export interface IsolateHost {
  readonly kind: "worker" | "process";
  /** Starts an isolate. The guest sends `ready` first; nothing runs until the host sends `start`. */
  start(): IsolateSession;
}

export interface ExecutionEngine {
  readonly id: EngineId;
  describe(): Promise<EngineDescriptor>;
  prepare(request: ExecutionRequest, ctx: TrustedExecutionContext): Promise<PreparedExecution>;
  run(prepared: PreparedExecution, channel: KernelChannel): Promise<EngineOutcome>;
  terminate(prepared: PreparedExecution, reason: TerminationReason): Promise<TerminationReport>;
  /**
   * Optional step between `run` and the commit of the shared state, for engines whose results must
   * be published first (Python's artifacts). It runs only when the host did not stop the execution,
   * and may turn a completed outcome into a failed one: a failure discards the state delta.
   */
  collect?(prepared: PreparedExecution, outcome: EngineOutcome): Promise<EngineOutcome>;
  dispose(prepared: PreparedExecution): Promise<void>;
}
