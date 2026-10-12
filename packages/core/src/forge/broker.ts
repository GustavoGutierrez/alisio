/**
 * The capability broker (spec §4.2, §6.4): the kernel's side of the guest's messages. A script sees
 * proxy functions; every real decision happens here, with the numbers the HOST keeps:
 *
 *  - nested calls go through the run's nested-call dispatcher (the same gate as a direct call, no
 *    new approvals, D7/D-24), paced by the `BudgetLedger` (total, concurrent, credits);
 *  - sizes, output and state are bounded again no matter what the prelude checked;
 *  - every nested call is journaled and reported as `ForgeProgress`.
 *
 * Errors that mean "the guest broke a limit" are thrown as `ForgeError`: the engine ends the
 * execution with that code. Errors of one tool call are answered to the guest as `ok: false`.
 */
import { createHash } from "node:crypto";
import type { ForgeProgress, ToolDefinition } from "@alisio/sdk";
import type { BudgetLedger } from "./budget.ts";
import { describeTool, searchCatalog } from "./catalog-view.ts";
import { ForgeError, type ForgeErrorCode } from "./errors.ts";
import type { CallEffect, SqliteExecutionJournal } from "./journal.ts";
import type { ForgeLimits } from "./limits.ts";
import type { NestedCallDispatcher } from "./nested.ts";
import type { HostReply } from "./ports.ts";
import type { ForgeOutputItem, GuestMessage } from "./protocol.ts";
import { clipText } from "./result.ts";
import type { StateDelta } from "./state-delta.ts";

/** Maximum catalog lookups per execution; they are cheap but not free. */
export const MAX_CATALOG_REQUESTS = 200;
/** Progress messages one execution may report; the rest is dropped (counted, not stored). */
export const MAX_PROGRESS_MESSAGES = 10_000;
/** Characters of one progress message the host keeps. */
export const MAX_PROGRESS_CHARS = 500;
/** Bytes of state operations one execution may queue (the commit enforces the stored total). */
export const MAX_STATE_DELTA_BYTES = 1024 * 1024;

const DENIED: ReadonlySet<ForgeErrorCode> = new Set(["PERMISSION_DENIED", "APPROVAL_REQUIRED"]);

export interface BrokerDeps {
  dispatcher: NestedCallDispatcher;
  ledger: BudgetLedger;
  limits: ForgeLimits;
  journal: Pick<SqliteExecutionJournal, "startCall" | "endCall">;
  executionId: string;
  /** Aborts every nested call when the execution is stopped. */
  signal: AbortSignal;
  /** `undefined` when the stored state is switched off. */
  state: StateDelta | undefined;
  /** Coalesced, droppable progress (script progress, a call starting). */
  update(progress: ForgeProgress): void;
  /** Never dropped (a call ended). */
  terminal(progress: ForgeProgress): void;
  engine: ForgeProgress["engine"];
  log(line: string): void;
  now?: () => number;
}

export interface CallStats {
  total: number;
  failed: number;
  denied: number;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const positionOf = (nestedCallId: string): number =>
  Number(nestedCallId.slice(nestedCallId.lastIndexOf(":") + 1));

export class CapabilityBroker {
  readonly #deps: BrokerDeps;
  readonly #now: () => number;
  readonly output: ForgeOutputItem[] = [];
  readonly stats: CallStats = { total: 0, failed: 0, denied: 0 };
  readonly #inflight = new Set<Promise<unknown>>();
  #send: (reply: HostReply) => void = () => {};
  /** Progress messages dropped past `MAX_PROGRESS_MESSAGES` (reported in the journal metrics). */
  progressDropped = 0;
  #progressSeen = 0;
  #catalogRequests = 0;
  #stateBytes = 0;

  constructor(deps: BrokerDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  bind(send: (reply: HostReply) => void): void {
    this.#send = send;
  }

  /** Resolves when every call the guest started has finished (or the timeout passed). */
  async drain(timeoutMs: number): Promise<void> {
    if (this.#inflight.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.#inflight]),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
    ]);
  }

  async receive(message: GuestMessage): Promise<HostReply | undefined> {
    switch (message.type) {
      case "ready":
        return { type: "grant", payload: this.#deps.ledger.grant() };
      case "progress": {
        if (++this.#progressSeen > MAX_PROGRESS_MESSAGES) {
          if (this.progressDropped++ === 0)
            this.#deps.log(
              `progress: more than ${MAX_PROGRESS_MESSAGES} messages; the rest is dropped`,
            );
          return undefined;
        }
        const text = clipText(message.payload.message, MAX_PROGRESS_CHARS).text;
        this.#deps.log(`progress: ${text}`);
        this.#deps.update({
          kind: "forge",
          executionId: this.#deps.executionId,
          engine: this.#deps.engine,
          phase: "running",
          message: text,
          ...(message.payload.completed !== undefined
            ? { completed: message.payload.completed }
            : {}),
          ...(message.payload.total !== undefined ? { total: message.payload.total } : {}),
        });
        return undefined;
      }
      case "output":
        this.#recordOutput(message.payload);
        return undefined;
      case "state.set":
        this.#state().set(message.payload.key, message.payload.value);
        this.#countState(message.payload.key, message.payload.value);
        return undefined;
      case "state.delete":
        this.#state().delete(message.payload.key);
        this.#countState(message.payload.key, null);
        return undefined;
      case "catalog":
        return this.#catalog(message.payload);
      case "call": {
        // Not awaited by the engine's dispatch: calls of one script run concurrently.
        const job = this.#call(message.payload);
        this.#inflight.add(job);
        const settled = () => this.#inflight.delete(job);
        job.then(settled, settled);
        await job;
        return undefined;
      }
      default:
        return undefined;
    }
  }

  #state(): StateDelta {
    const state = this.#deps.state;
    if (!state)
      throw new ForgeError("INVALID_INPUT", "stored state is switched off (forge.state.enabled)");
    return state;
  }

  #countState(key: string, value: unknown): void {
    this.#stateBytes += key.length + JSON.stringify(value).length;
    if (this.#stateBytes > MAX_STATE_DELTA_BYTES)
      throw new ForgeError("BUDGET_EXCEEDED", "this execution changed too much stored state");
  }

  #recordOutput(item: ForgeOutputItem): void {
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    this.#deps.ledger.recordOutput(bytes);
    this.output.push(item);
    if (item.type === "text") this.#deps.log(item.text.replace(/\n$/, ""));
  }

  #catalog(payload: {
    requestId: number;
    op: "search" | "describe";
    query: string;
    limit?: number;
  }): HostReply {
    if (++this.#catalogRequests > MAX_CATALOG_REQUESTS)
      throw new ForgeError(
        "BUDGET_EXCEEDED",
        `catalog lookups are limited to ${MAX_CATALOG_REQUESTS} per execution`,
      );
    const tools: ToolDefinition[] = this.#deps.dispatcher.catalog();
    const entries: unknown[] =
      payload.op === "search"
        ? searchCatalog(tools, payload.query, payload.limit)
        : [describeTool(tools, payload.query)].filter((entry) => entry !== undefined);
    return { type: "catalog.result", payload: { requestId: payload.requestId, entries } };
  }

  async #call(payload: { callId: number; tool: string; input: unknown }): Promise<void> {
    const { ledger, journal, executionId, limits } = this.#deps;
    // Only names the registry has are ever recorded or broadcast; anything else is a placeholder.
    const tool = this.#deps.dispatcher.knows(payload.tool)
      ? payload.tool
      : `unknown:${sha256(payload.tool).slice(0, 12)}`;
    // The host's own count: a call without a credit, or past the total, ends the execution.
    ledger.startCall();
    this.stats.total++;
    const startedAt = this.#now();
    const progress = (status: "started" | "succeeded" | "failed" | "denied", extra: object = {}) =>
      ({
        kind: "forge",
        executionId,
        engine: this.#deps.engine,
        phase: "call",
        call: { callId: payload.callId, tool, status, ...extra },
      }) satisfies ForgeProgress;
    let journalId: string | undefined;
    let ended = false;
    const end = (status: "succeeded" | "failed", errorCode?: ForgeErrorCode): void => {
      if (journalId && !ended) {
        ended = true;
        journal.endCall(executionId, journalId, {
          status,
          durationMs: this.#now() - startedAt,
          ...(errorCode ? { errorCode } : {}),
        });
      }
    };
    let reply: HostReply;
    try {
      const inputJson = JSON.stringify(payload.input ?? {});
      if (Buffer.byteLength(inputJson, "utf8") > limits.maxCallInputBytes) {
        reply = this.#error(
          payload.callId,
          "TOOL_INPUT_INVALID",
          `tool input is larger than ${limits.maxCallInputBytes} bytes`,
        );
        this.stats.failed++;
        this.#deps.terminal(progress("failed"));
      } else {
        this.#deps.log(`call ${tool}`);
        this.#deps.update(progress("started"));
        const outcome = await this.#deps.dispatcher.call({
          name: payload.tool,
          input: payload.input,
          signal: this.#deps.signal,
          onStart: (start) => {
            journalId = journal.startCall({
              executionId,
              n: positionOf(start.nestedCallId),
              toolName: start.name,
              effect: start.effect as CallEffect,
              inputSha256: sha256(inputJson),
              paths: start.paths,
            });
          },
        });
        if (outcome.ok) {
          const valueJson = JSON.stringify(outcome.value) ?? "null";
          if (Buffer.byteLength(valueJson, "utf8") > limits.maxCallResponseBytes) {
            reply = this.#error(
              payload.callId,
              "OUTPUT_LIMIT",
              `${payload.tool} returned ${Buffer.byteLength(valueJson, "utf8")} bytes, over the ${limits.maxCallResponseBytes} byte limit; ask for less (a smaller range, a filter, a page)`,
            );
            this.stats.failed++;
            end("failed", "OUTPUT_LIMIT");
            this.#deps.terminal(progress("failed", { durationMs: this.#now() - startedAt }));
          } else {
            reply = {
              type: "result",
              payload: { callId: payload.callId, ok: true, value: outcome.value ?? null },
            };
            end("succeeded");
            this.#deps.terminal(progress("succeeded", { durationMs: this.#now() - startedAt }));
          }
        } else {
          if (!journalId) {
            // Refused before it started (denied, unknown, invalid): still on the record.
            journalId = journal.startCall({
              executionId,
              n: positionOf(outcome.nestedCallId),
              toolName: tool,
              effect: (outcome.effect ?? "external") as CallEffect,
              inputSha256: sha256(inputJson),
            });
          }
          const denied = DENIED.has(outcome.code);
          if (denied) this.stats.denied++;
          else this.stats.failed++;
          end("failed", outcome.code);
          this.#deps.log(`call ${tool} failed: ${outcome.code}`);
          this.#deps.terminal(
            progress(denied ? "denied" : "failed", { durationMs: this.#now() - startedAt }),
          );
          reply = this.#error(payload.callId, outcome.code, outcome.message);
        }
      }
    } catch (error) {
      end("failed", "TOOL_FAILED");
      this.stats.failed++;
      this.#deps.terminal(progress("failed", { durationMs: this.#now() - startedAt }));
      reply = this.#error(
        payload.callId,
        "TOOL_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      ledger.finishCall();
    }
    this.#send(reply);
    this.#send({ type: "grant", payload: ledger.grant() });
  }

  #error(callId: number, code: ForgeErrorCode, message: string): HostReply {
    return { type: "result", payload: { callId, ok: false, error: { code, message } } };
  }
}
