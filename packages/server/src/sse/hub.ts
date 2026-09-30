import { randomUUID } from "node:crypto";
import type { Message, RunEvent, ServerFrame, ToolResult } from "@alisio/sdk";
import { isEphemeralRunEventType } from "@alisio/sdk";
import { PROTOCOL_VERSION } from "../routes/health.ts";
import { progressChunk } from "./inflight.ts";

/** The part of `ServerResponse` the hub writes to (a fake one in unit tests). */
export interface SseSink {
  write(chunk: string): boolean;
  end(): void;
  once(event: "drain", listener: () => void): unknown;
}

export interface SseHubOptions {
  /** Snapshot of one session, built synchronously (node:sqlite reads are synchronous). */
  snapshot(sessionId: string): Extract<ServerFrame, { t: "snapshot" }>;
  /** Durable message rows after `seq`, ascending. */
  messagesAfter(
    sessionId: string,
    seq: number,
  ): { items: Array<{ seq: number; message: Message }>; hasMore: boolean };
  /** The persisted result of a completed tool call. */
  toolResult(sessionId: string, callId: string): ToolResult | undefined;
  /** Workspace id of a session (for workspace-wide frames and eviction). */
  workspaceOf(sessionId: string): string | undefined;
  /** Called when a session gains or loses its last subscriber. */
  onSubscribersChanged?: (sessionId: string) => void;
  heartbeatMs?: number;
  coalesceMs?: number;
  maxQueueFrames?: number;
  maxQueueBytes?: number;
}

interface Subscription {
  /** Highest message `seq` this client has (from its snapshot or later frames). */
  lastSeq: number;
}

interface Client {
  id: string;
  sink: SseSink;
  sessions: Map<string, Subscription>;
  workspaces: Set<string>;
  queue: Array<{ chunk: string; droppable: boolean }>;
  queuedBytes: number;
  draining: boolean;
  closed: boolean;
}

interface PendingDelta {
  runId: string;
  text: string;
  reasoning: string;
  progress: Array<{ toolId: string; chunk: string }>;
  timer?: ReturnType<typeof setTimeout>;
}

/** Durable events after which new message rows may exist. */
const MESSAGE_BOUNDARIES = new Set([
  "run_started",
  "turn_completed",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "run_turns_exceeded",
  "compaction_completed",
  "context_reduced",
  "session_context_injected",
]);

const MAX_TOOL_RESULT_BYTES = 256 * 1024;

/**
 * One multiplexed SSE stream per browser tab (§8.5): snapshot-then-deltas per subscribed
 * session, durable frames with `id: <eventId>`, ephemeral deltas coalesced per session, a
 * heartbeat comment, and a bounded per-client queue that ends the stream with `resync` when
 * a slow client overflows it.
 */
export class SseHub {
  private clients = new Map<string, Client>();
  private pending = new Map<string, PendingDelta>();
  private heartbeat: ReturnType<typeof setInterval>;
  private readonly coalesceMs: number;
  private readonly maxFrames: number;
  private readonly maxBytes: number;
  /** Streams ended because their client could not keep up. */
  dropped = 0;

  constructor(private options: SseHubOptions) {
    this.coalesceMs = Math.min(50, Math.max(16, options.coalesceMs ?? 33));
    this.maxFrames = options.maxQueueFrames ?? 256;
    this.maxBytes = options.maxQueueBytes ?? 1024 * 1024;
    this.heartbeat = setInterval(() => {
      for (const client of this.clients.values()) this.write(client, ": ping\n\n", true);
    }, options.heartbeatMs ?? 15_000);
    this.heartbeat.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  /**
   * Registers a stream: `hello`, then one snapshot per session. Each snapshot is built and the
   * subscription registered in the same tick, so no durable event can fall between them.
   */
  attach(sink: SseSink, sessionIds: string[]): () => void {
    const client: Client = {
      id: randomUUID(),
      sink,
      sessions: new Map(),
      workspaces: new Set(),
      queue: [],
      queuedBytes: 0,
      draining: false,
      closed: false,
    };
    this.clients.set(client.id, client);
    this.write(client, "retry: 2000\n\n", false);
    this.frame(client, {
      t: "hello",
      protocolVersion: PROTOCOL_VERSION,
      streamId: client.id,
      serverTime: Date.now(),
    });
    for (const sessionId of new Set(sessionIds)) {
      // Deltas buffered before this client joined are already part of the snapshot's inflight.
      this.flush(sessionId);
      const snapshot = this.options.snapshot(sessionId);
      client.sessions.set(sessionId, { lastSeq: snapshot.messages.items.at(-1)?.seq ?? 0 });
      const workspace = this.options.workspaceOf(sessionId);
      if (workspace) client.workspaces.add(workspace);
      this.frame(client, snapshot);
      this.options.onSubscribersChanged?.(sessionId);
    }
    return () => this.detach(client);
  }

  private detach(client: Client) {
    if (!this.clients.delete(client.id)) return;
    client.closed = true;
    client.queue = [];
    for (const sessionId of client.sessions.keys()) this.options.onSubscribersChanged?.(sessionId);
  }

  subscribers(sessionId: string): number {
    let count = 0;
    for (const client of this.clients.values()) if (client.sessions.has(sessionId)) count++;
    return count;
  }

  /** Whether any stream watches a session of the workspace (blocks idle eviction). */
  watchesWorkspace(workspaceId: string): boolean {
    for (const client of this.clients.values()) if (client.workspaces.has(workspaceId)) return true;
    return false;
  }

  workspaceSubscribers(workspaceId: string): number {
    let count = 0;
    for (const client of this.clients.values()) if (client.workspaces.has(workspaceId)) count++;
    return count;
  }

  /** Feeds a runner event (the app's `onEvent`). */
  publish(event: RunEvent): void {
    const sessionId = event.sessionId;
    if (isEphemeralRunEventType(event.type)) {
      if (!this.subscribers(sessionId)) return;
      this.coalesce(event);
      return;
    }
    this.flush(sessionId);
    this.toSession(sessionId, { t: "event", sessionId, event }, event.eventId);
    const data = (event.data ?? {}) as { id?: string };
    if (event.type === "tool_completed" && data.id) this.toolResult(event, data.id);
    if (MESSAGE_BOUNDARIES.has(event.type)) this.messages(sessionId);
  }

  private coalesce(event: RunEvent) {
    const sessionId = event.sessionId;
    let pending = this.pending.get(sessionId);
    if (pending && pending.runId !== event.runId) {
      this.flush(sessionId);
      pending = undefined;
    }
    if (!pending) {
      pending = { runId: event.runId, text: "", reasoning: "", progress: [] };
      this.pending.set(sessionId, pending);
    }
    const data = (event.data ?? {}) as { delta?: string; id?: string; data?: unknown };
    if (event.type === "text_delta") pending.text += String(data.delta ?? "");
    else if (event.type === "reasoning_delta") pending.reasoning += String(data.delta ?? "");
    else pending.progress.push({ toolId: String(data.id), chunk: progressChunk(data.data) });
    pending.timer ??= setTimeout(() => this.flush(sessionId), this.coalesceMs);
  }

  /** Sends the session's buffered deltas as one `delta` frame now. */
  flush(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    if (!pending) return;
    this.pending.delete(sessionId);
    if (pending.timer) clearTimeout(pending.timer);
    const frame: ServerFrame = {
      t: "delta",
      sessionId,
      runId: pending.runId,
      ...(pending.text ? { text: pending.text } : {}),
      ...(pending.reasoning ? { reasoning: pending.reasoning } : {}),
      ...(pending.progress.length ? { progress: pending.progress } : {}),
    };
    for (const client of this.clients.values())
      if (client.sessions.has(sessionId)) this.frame(client, frame, undefined, true);
  }

  private toolResult(event: RunEvent, callId: string) {
    const result = this.options.toolResult(event.sessionId, callId);
    if (!result) return;
    const size = Buffer.byteLength(JSON.stringify(result));
    const truncated = size > MAX_TOOL_RESULT_BYTES;
    this.toSession(event.sessionId, {
      t: "tool_result",
      sessionId: event.sessionId,
      runId: event.runId,
      callId,
      result: truncated
        ? {
            ...result,
            content: result.content.filter((part) => part.type === "text").slice(0, 1),
          }
        : result,
      ...(truncated ? { truncated: true } : {}),
    });
  }

  /** Emits durable message rows each subscriber does not have yet. */
  private messages(sessionId: string) {
    const subs = [...this.clients.values()].filter((c) => c.sessions.has(sessionId));
    if (!subs.length) return;
    let after = Math.min(...subs.map((c) => c.sessions.get(sessionId)?.lastSeq ?? 0));
    for (let page = 0; page < 20; page++) {
      const { items, hasMore } = this.options.messagesAfter(sessionId, after);
      for (const row of items)
        for (const client of subs) {
          const sub = client.sessions.get(sessionId);
          if (!sub || row.seq <= sub.lastSeq) continue;
          sub.lastSeq = row.seq;
          this.frame(client, { t: "message", sessionId, seq: row.seq, message: row.message });
        }
      after = items.at(-1)?.seq ?? after;
      if (!hasMore) break;
    }
  }

  /** A frame for every stream subscribed to `sessionId`. */
  toSession(sessionId: string, frame: ServerFrame, id?: string): void {
    for (const client of this.clients.values())
      if (client.sessions.has(sessionId)) this.frame(client, frame, id);
  }

  /** A frame for every stream watching a session of the workspace. */
  toWorkspace(workspaceId: string, frame: ServerFrame): void {
    for (const client of this.clients.values())
      if (client.workspaces.has(workspaceId)) this.frame(client, frame);
  }

  /** A frame for every stream (e.g. `session_status` for sidebars). */
  broadcast(frame: ServerFrame): void {
    for (const client of this.clients.values()) this.frame(client, frame);
  }

  private frame(client: Client, frame: ServerFrame, id?: string, droppable = false) {
    this.write(client, `${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(frame)}\n\n`, droppable);
  }

  /** Writes with backpressure: queue while the socket drains; overflow ends with `resync`. */
  private write(client: Client, chunk: string, droppable: boolean) {
    if (client.closed) return;
    if (!client.draining) {
      if (!client.sink.write(chunk)) {
        client.draining = true;
        client.sink.once("drain", () => this.drain(client));
      }
      return;
    }
    client.queue.push({ chunk, droppable });
    client.queuedBytes += chunk.length;
    if (client.queue.length <= this.maxFrames && client.queuedBytes <= this.maxBytes) return;
    client.queue = client.queue.filter((item) => !item.droppable);
    client.queuedBytes = client.queue.reduce((sum, item) => sum + item.chunk.length, 0);
    if (client.queue.length <= this.maxFrames && client.queuedBytes <= this.maxBytes) return;
    // Still over: the client must rebuild from a snapshot. End the stream; EventSource reopens.
    this.dropped++;
    client.queue = [];
    client.closed = true;
    client.sink.write(`data: ${JSON.stringify({ t: "resync", reason: "overflow" })}\n\n`);
    client.sink.end();
    this.detach(client);
  }

  private drain(client: Client) {
    client.draining = false;
    while (client.queue.length && !client.closed) {
      const item = client.queue.shift() as { chunk: string };
      client.queuedBytes -= item.chunk.length;
      if (!client.sink.write(item.chunk)) {
        client.draining = true;
        client.sink.once("drain", () => this.drain(client));
        return;
      }
    }
  }

  /** Ends every stream (shutdown). */
  closeAll(): void {
    clearInterval(this.heartbeat);
    for (const pending of this.pending.values()) if (pending.timer) clearTimeout(pending.timer);
    this.pending.clear();
    for (const client of [...this.clients.values()]) {
      this.detach(client);
      try {
        client.sink.end();
      } catch {
        /* already closed */
      }
    }
  }
}
