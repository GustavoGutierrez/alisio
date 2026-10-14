/**
 * Cassettes of the reliability lab (specs/010 5.3, D10, D11): `cassette/v1` JSONL, the provider
 * that records a live run and the provider that serves it back.
 *
 *   line 1   header: {v:1, cassetteVersion, suiteId, taskId, harnessVersion, recordedAt, configHash,
 *            provider, model, models?, texts, toolSets}
 *   line n   one call to `ModelProvider.stream`: {call, lane, fingerprint, parts, messages?, events,
 *            error?}
 *
 * `completed.message` is stored VERBATIM (tool-call ids, `providerData`, `truncated`) together with
 * its usage; `reasoning_delta` is dropped (the SDK says it is never replayed). A provider error
 * (for example the truncation signal) is stored as `error: {message, code}` so recovery replays.
 *
 * Replay serves the recorded events in strict order PER LANE. A lane is a session (the registered
 * main session by its `<SESSION#n>` placeholder); a session the run did not register (a child /
 * subagent) is bound to the lane whose first request has the same fingerprint, so concurrent
 * children may interleave differently. v1 limitation: two children with an identical first request
 * are interchangeable, and a child whose first request changes is reported as a divergence.
 *
 * This module (and everything it imports) must not touch the network: a test checks that
 * statically, and replay needs no credentials. Replay promises no timing.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelInfo, ModelProvider, ProviderEvent, Usage } from "@alisio/sdk";
import {
  absorb,
  type CassetteTexts,
  computeFingerprint,
  diffFingerprints,
  emptyStore,
  type FingerprintDiff,
  type FingerprintMaterial,
  type FingerprintParts,
  type MessageView,
  type StreamRequest,
} from "./fingerprint.ts";
import type { Normalizer } from "./normalize.ts";
import { findSecrets } from "./secrets.ts";

export const MAX_CASSETTE_BYTES = 256 * 1024;
export const MAX_CASSETTE_DIR_BYTES = 2 * 1024 * 1024;
export const CASSETTE_SUFFIX = ".cassette.jsonl";
const NO_SESSION = "<NO_SESSION>";

export type RecordedEvent =
  | { type: "text_delta"; delta: string }
  | {
      type: "completed";
      message: Extract<ProviderEvent, { type: "completed" }>["message"];
      usage?: Usage;
    };

export interface CassetteHeader {
  v: 1;
  cassetteVersion: number;
  suiteId: string;
  taskId: string;
  harnessVersion: string;
  recordedAt: number;
  configHash: string;
  provider: string;
  model: string;
  models?: ModelInfo[];
  texts: CassetteTexts["texts"];
  toolSets: CassetteTexts["toolSets"];
}

export interface CassetteCall {
  call: number;
  lane: string;
  fingerprint: string;
  parts: FingerprintParts;
  /** Views of the messages that first appear in this call (the earlier ones are in earlier lines). */
  messages?: Record<string, MessageView>;
  events: RecordedEvent[];
  error?: { message: string; code?: string };
}

export interface Cassette {
  header: CassetteHeader;
  calls: CassetteCall[];
}

export class CassetteFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CassetteFormatError";
  }
}

export class CassetteWriteError extends Error {
  constructor(
    message: string,
    readonly reason: "secret" | "size" | "total",
  ) {
    super(message);
    this.name = "CassetteWriteError";
  }
}

// ---------------------------------------------------------------------------------------------
// File format
// ---------------------------------------------------------------------------------------------

export function serializeCassette(cassette: Cassette): string {
  return `${[cassette.header, ...cassette.calls].map((line) => JSON.stringify(line)).join("\n")}\n`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseCassette(text: string): Cassette {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new CassetteFormatError("The cassette is empty.");
  const parsed = lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new CassetteFormatError(`Cassette line ${index + 1} is not valid JSON.`);
    }
  });
  const header = parsed[0];
  if (!isRecord(header) || header.v !== 1)
    throw new CassetteFormatError(
      'Unsupported cassette: line 1 must be a cassette/v1 header ({"v":1,...}). Record it again with this version of alisio.',
    );
  for (const key of ["suiteId", "taskId", "harnessVersion", "configHash", "provider", "model"])
    if (typeof header[key] !== "string")
      throw new CassetteFormatError(`Cassette header line 1 lacks the string "${key}".`);
  if (!isRecord(header.texts) || !isRecord(header.toolSets))
    throw new CassetteFormatError("Cassette header line 1 lacks its texts or toolSets.");
  const calls = parsed.slice(1).map((line, index): CassetteCall => {
    const at = index + 2;
    if (
      !isRecord(line) ||
      typeof line.call !== "number" ||
      typeof line.lane !== "string" ||
      typeof line.fingerprint !== "string" ||
      !isRecord(line.parts) ||
      !Array.isArray(line.events)
    )
      throw new CassetteFormatError(`Cassette line ${at} is not a call record.`);
    if (line.call !== index)
      throw new CassetteFormatError(
        `Cassette line ${at}: call ${line.call}, expected ${index} (calls must be numbered in order).`,
      );
    for (const event of line.events)
      if (!isRecord(event) || (event.type !== "text_delta" && event.type !== "completed"))
        throw new CassetteFormatError(`Cassette line ${at} holds an unknown event.`);
    return line as unknown as CassetteCall;
  });
  return { header: header as unknown as CassetteHeader, calls };
}

export function readCassette(path: string): Cassette {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new CassetteFormatError(
      `Cannot read the cassette ${path}. Record it first with \`alisio eval record\`.`,
    );
  }
  try {
    return parseCassette(text);
  } catch (error) {
    throw new CassetteFormatError(
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Every string leaf with its path (`calls[0].events[1].message.text`). */
function* leaves(value: unknown, path: string): Generator<[string, string]> {
  if (typeof value === "string") yield [path, value];
  else if (Array.isArray(value))
    for (let i = 0; i < value.length; i++) yield* leaves(value[i], `${path}[${i}]`);
  else if (value && typeof value === "object")
    for (const [key, member] of Object.entries(value as Record<string, unknown>))
      yield* leaves(member, `${path}.${key}`);
}

export interface WriteOptions {
  /** Exact credential values of the run (provider profile, matching env vars). */
  secrets?: readonly string[];
  maxBytes?: number;
  maxDirBytes?: number;
}

/**
 * Writes `cassette` to `path` unless it holds a secret (REFUSES: it never strips, which would make
 * the cassette lie about what the model saw) or exceeds the size limits (256 KB each, 2 MB for the
 * directory). Nothing is written on refusal.
 */
export function writeCassette(path: string, cassette: Cassette, options: WriteOptions = {}): void {
  for (const [where, value] of [
    ...leaves(cassette.header, "header"),
    ...leaves(cassette.calls, "calls"),
  ]) {
    const hits = findSecrets(value, options.secrets ?? []);
    if (hits.length > 0)
      throw new CassetteWriteError(
        `Refusing to write the cassette: ${where} looks like a secret (${hits.join("; ")}). Remove it from the fixture, prompt or tool output and record again.`,
        "secret",
      );
  }
  const text = serializeCassette(cassette);
  const bytes = Buffer.byteLength(text);
  const maxBytes = options.maxBytes ?? MAX_CASSETTE_BYTES;
  if (bytes > maxBytes)
    throw new CassetteWriteError(
      `Refusing to write the cassette: ${bytes} bytes exceeds the ${Math.round(maxBytes / 1024)} KB limit per cassette. Record a shorter task.`,
      "size",
    );
  const dir = dirname(path);
  let others = 0;
  if (existsSync(dir))
    for (const name of readdirSync(dir))
      if (name.endsWith(CASSETTE_SUFFIX) && join(dir, name) !== path)
        others += statSync(join(dir, name)).size;
  const maxDir = options.maxDirBytes ?? MAX_CASSETTE_DIR_BYTES;
  if (others + bytes > maxDir)
    throw new CassetteWriteError(
      `Refusing to write the cassette: the cassettes in ${dir} would total ${others + bytes} bytes, over the ${Math.round(maxDir / (1024 * 1024))} MB limit.`,
      "total",
    );
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, text);
}

// ---------------------------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------------------------

/** Lane of a session the run did not register: named after its first request. */
const childLaneBase = (fingerprint: string): string => `L:${fingerprint.slice(7, 19)}`;
const childLaneName = (base: string, n: number): string => (n === 1 ? base : `${base}#${n}`);

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------

export interface CassetteMeta {
  suiteId: string;
  taskId: string;
  harnessVersion: string;
  configHash: string;
  recordedAt: number;
  provider: string;
  model: string;
  cassetteVersion?: number;
}

/** Collects the calls a `RecordingProvider` sees; `toCassette` turns them into the file content. */
export class CassetteRecorder {
  readonly calls: CassetteCall[] = [];
  /** Why the recording cannot be trusted (set, never cleared); `toCassette` refuses then. */
  unstable: string | undefined;
  models: ModelInfo[] | undefined;
  private normalizer: Normalizer | undefined;
  private readonly store = emptyStore();
  private readonly childLanes = new Map<string, string>();
  private readonly laneCounts = new Map<string, number>();

  bind(normalizer: Normalizer): void {
    this.normalizer = normalizer;
  }

  /** Opens the record of the next call. */
  begin(request: StreamRequest): CassetteCall {
    if (!this.normalizer) throw new Error("CassetteRecorder.bind(normalizer) was not called.");
    const material = computeFingerprint(request, this.normalizer);
    const messages = absorb(this.store, material);
    const entry: CassetteCall = {
      call: this.calls.length,
      lane: this.laneFor(request, material),
      fingerprint: material.fingerprint,
      parts: material.parts,
      ...(Object.keys(messages).length > 0 ? { messages } : {}),
      events: [],
    };
    this.calls.push(entry);
    return entry;
  }

  private laneFor(request: StreamRequest, material: FingerprintMaterial): string {
    const label = this.normalizer?.sessionLabel(request.sessionId);
    if (label) return label;
    if (request.sessionId === undefined) return NO_SESSION;
    let lane = this.childLanes.get(request.sessionId);
    if (!lane) {
      const base = childLaneBase(material.fingerprint);
      const n = (this.laneCounts.get(base) ?? 0) + 1;
      this.laneCounts.set(base, n);
      lane = childLaneName(base, n);
      this.childLanes.set(request.sessionId, lane);
    }
    return lane;
  }

  markUnstable(reason: string): void {
    this.unstable ??= `${reason} The recording is unstable: re-record.`;
  }

  toCassette(meta: CassetteMeta): Cassette {
    if (this.unstable) throw new Error(`Cannot build the cassette. ${this.unstable}`);
    return {
      header: {
        v: 1,
        cassetteVersion: meta.cassetteVersion ?? 1,
        suiteId: meta.suiteId,
        taskId: meta.taskId,
        harnessVersion: meta.harnessVersion,
        recordedAt: meta.recordedAt,
        configHash: meta.configHash,
        provider: meta.provider,
        model: meta.model,
        ...(this.models ? { models: this.models } : {}),
        texts: this.store.texts,
        toolSets: this.store.toolSets,
      },
      calls: this.calls,
    };
  }
}

/**
 * Wraps a real provider and tees what it emits into `sink`. The caller still receives every event
 * (reasoning included). A call aborted before any event (a first-token retry, a timeout) or one the
 * consumer abandons makes the recording unstable: replaying it would not reproduce the run.
 */
export class RecordingProvider implements ModelProvider {
  readonly id: string;
  readonly model: string;
  readonly listModels?: ModelProvider["listModels"];
  readonly dispose?: ModelProvider["dispose"];

  constructor(
    private readonly inner: ModelProvider,
    private readonly sink: CassetteRecorder,
  ) {
    this.id = inner.id;
    this.model = inner.model;
    const list = inner.listModels?.bind(inner);
    if (list)
      this.listModels = async (signal) => {
        const models = await list(signal);
        sink.models = models;
        return models;
      };
    const dispose = inner.dispose?.bind(inner);
    if (dispose) this.dispose = () => dispose();
  }

  async *stream(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const entry = this.sink.begin(request);
    let finished = false;
    try {
      for await (const event of this.inner.stream(request)) {
        if (event.type === "text_delta")
          entry.events.push({ type: "text_delta", delta: event.delta });
        else if (event.type === "completed")
          entry.events.push({
            type: "completed",
            message: event.message,
            ...(event.usage ? { usage: event.usage } : {}),
          });
        yield event;
      }
      finished = true;
    } catch (error) {
      if (request.signal.aborted) {
        this.sink.markUnstable(
          `Call ${entry.call} was aborted ${entry.events.length === 0 ? "before any event" : "mid-stream"} (a first-token retry, a timeout or a budget).`,
        );
      } else {
        const { message } = error instanceof Error ? error : new Error(String(error));
        const code = (error as { code?: unknown } | null)?.code;
        entry.error = { message, ...(typeof code === "string" ? { code } : {}) };
      }
      finished = true;
      throw error;
    } finally {
      if (!finished)
        this.sink.markUnstable(
          `Call ${entry.call} was abandoned by the consumer${request.signal.aborted ? " after an abort" : ""}.`,
        );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------------

const describeDiff = (diff: FingerprintDiff) =>
  diff.length === 0 ? "the request changed" : diff.map((entry) => entry.field).join(", ");

/** The request of a call differs from the recorded one. Carries the structured diff. */
export class ReplayDivergenceError extends Error {
  constructor(
    readonly call: number,
    readonly lane: string,
    readonly diff: FingerprintDiff,
  ) {
    super(`Replay diverged at call ${call} (lane ${lane}): ${describeDiff(diff)}`);
    this.name = "ReplayDivergenceError";
  }
}

/** The run asked for a call the cassette has no (more) recording for. */
export class ReplayExhausted extends Error {
  constructor(
    readonly call: number,
    readonly lane: string,
    detail: string,
  ) {
    super(`Replay exhausted at request ${call} (lane ${lane}): ${detail}`);
    this.name = "ReplayExhausted";
  }
}

/** Recorded calls the run never asked for (`ReplayProvider.assertConsumed`). */
export class ReplayUnconsumedError extends Error {
  constructor(readonly leftover: Array<{ call: number; lane: string }>) {
    super(
      `${leftover.length} recorded call(s) were never requested (first: call ${leftover[0]?.call} in lane ${leftover[0]?.lane}).`,
    );
    this.name = "ReplayUnconsumedError";
  }
}

export class ReplayProvider implements ModelProvider {
  readonly id: string;
  readonly model: string;
  readonly listModels?: ModelProvider["listModels"];
  private readonly store: CassetteTexts;
  private readonly lanes = new Map<string, CassetteCall[]>();
  private readonly position = new Map<string, number>();
  private readonly bindings = new Map<string, string>();
  private readonly claimed = new Set<string>();
  private requests = 0;
  private readonly normalizer: Normalizer;

  constructor(cassette: Cassette, options: { normalizer: Normalizer }) {
    this.normalizer = options.normalizer;
    this.id = cassette.header.provider;
    this.model = cassette.header.model;
    const models = cassette.header.models;
    if (models) this.listModels = async () => models;
    this.store = {
      texts: cassette.header.texts,
      toolSets: cassette.header.toolSets,
      messages: Object.assign({}, ...cassette.calls.map((c) => c.messages ?? {})),
    };
    for (const call of cassette.calls) {
      const queue = this.lanes.get(call.lane) ?? [];
      queue.push(call);
      this.lanes.set(call.lane, queue);
    }
  }

  /** The first divergence or exhaustion, kept even if the runner wraps the error it received. */
  failure: ReplayDivergenceError | ReplayExhausted | undefined;

  async *stream(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    request.signal.throwIfAborted();
    let expected: CassetteCall;
    try {
      expected = this.match(request);
    } catch (error) {
      if (error instanceof ReplayDivergenceError || error instanceof ReplayExhausted)
        this.failure ??= error;
      throw error;
    }
    for (const event of expected.events) {
      request.signal.throwIfAborted();
      yield event as ProviderEvent;
    }
    if (expected.error)
      throw Object.assign(
        new Error(expected.error.message),
        expected.error.code ? { code: expected.error.code } : {},
      );
  }

  /** The recorded call this request must be, consumed; throws when it is not. */
  private match(request: StreamRequest): CassetteCall {
    const number = this.requests++;
    const material = computeFingerprint(request, this.normalizer);
    const lane = this.laneFor(request, material, number);
    const expected = this.lanes.get(lane)?.[this.position.get(lane) ?? 0];
    if (!expected)
      throw new ReplayExhausted(
        number,
        lane,
        `the cassette has no further recorded call for this lane (${this.lanes.get(lane)?.length ?? 0} recorded).`,
      );
    if (expected.fingerprint !== material.fingerprint)
      throw new ReplayDivergenceError(
        expected.call,
        lane,
        diffFingerprints(expected.call, expected.parts, this.store, material),
      );
    this.position.set(lane, (this.position.get(lane) ?? 0) + 1);
    return expected;
  }

  private laneFor(request: StreamRequest, material: FingerprintMaterial, number: number): string {
    const label = this.normalizer.sessionLabel(request.sessionId);
    if (label) return label;
    if (request.sessionId === undefined) return NO_SESSION;
    const bound = this.bindings.get(request.sessionId);
    if (bound) return bound;
    const base = childLaneBase(material.fingerprint);
    for (let n = 1; this.lanes.has(childLaneName(base, n)); n++) {
      const candidate = childLaneName(base, n);
      if (!this.claimed.has(candidate)) {
        this.claimed.add(candidate);
        this.bindings.set(request.sessionId, candidate);
        return candidate;
      }
    }
    // No recorded child starts with this request: explain it against the next unclaimed child.
    const next = [...this.lanes.entries()]
      .filter(([lane]) => lane.startsWith("L:") && !this.claimed.has(lane))
      .sort(([, a], [, b]) => (a[0]?.call ?? 0) - (b[0]?.call ?? 0))[0];
    const first = next?.[1][0];
    if (next && first) {
      throw new ReplayDivergenceError(
        first.call,
        next[0],
        diffFingerprints(first.call, first.parts, this.store, material),
      );
    }
    throw new ReplayExhausted(number, base, "no recorded child session starts with this request.");
  }

  /** Throws `ReplayUnconsumedError` when recorded calls were never requested (extra calls). */
  assertConsumed(): void {
    const leftover: Array<{ call: number; lane: string }> = [];
    for (const [lane, queue] of this.lanes)
      for (const call of queue.slice(this.position.get(lane) ?? 0))
        leftover.push({ call: call.call, lane });
    leftover.sort((a, b) => a.call - b.call);
    if (leftover.length > 0) throw new ReplayUnconsumedError(leftover);
  }
}
