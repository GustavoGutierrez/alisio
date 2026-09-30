/**
 * The multiplexed SSE client (spec §8.5, §10.3): one `EventSource` per tab for the watched
 * sessions, frames delivered in batches of one per animation frame, a fresh snapshot after every
 * reconnection (the server always sends one) and backoff with jitter when the browser gives up.
 * DOM-free and injectable, so its behavior is tested in Node.
 */
import type { ServerFrame } from "@alisio/sdk";

export const PROTOCOL_VERSION = 1;

/** The subset of `EventSource` the client uses. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface EventStreamOptions {
  create: (url: string) => EventSourceLike;
  onFrames: (frames: ServerFrame[]) => void;
  onStatus?: (status: StreamStatus) => void;
  /** The server speaks another protocol version: the page must reload. */
  onProtocolMismatch?: () => void;
  /** Called when the browser closed the stream (e.g. to check whether the cookie expired). */
  onClosed?: () => void;
  requestFrame?: (callback: () => void) => void;
  /** Schedules `run` after `ms`; returns a cancel function. */
  setTimer?: (run: () => void, ms: number) => () => void;
  random?: () => number;
}

const CLOSED = 2;

export const streamUrl = (sessions: string[]): string =>
  sessions.length
    ? `/api/events?${sessions.map((s) => `session=${encodeURIComponent(s)}`).join("&")}`
    : "/api/events";

/** Reconnection delay: 0.5 s doubling up to 10 s, with ±50 % jitter. */
export const backoffDelay = (attempt: number, random: () => number = Math.random): number =>
  Math.round(Math.min(10_000, 500 * 2 ** Math.min(attempt, 10) * (0.5 + random())));

export class EventStream {
  private source?: EventSourceLike;
  private sessions: string[] = [];
  private key?: string;
  private queue: ServerFrame[] = [];
  private scheduled = false;
  private attempt = 0;
  private cancelRetry?: () => void;
  private stopped = false;
  private readonly requestFrame: (callback: () => void) => void;
  private readonly setTimer: (run: () => void, ms: number) => () => void;

  constructor(private options: EventStreamOptions) {
    this.requestFrame =
      options.requestFrame ??
      ((cb) =>
        typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => cb()) : cb());
    this.setTimer =
      options.setTimer ??
      ((run, ms) => {
        const id = setTimeout(run, ms);
        return () => clearTimeout(id);
      });
  }

  /** Watches exactly these sessions (order-insensitive); reopens only when the set changes. */
  subscribe(sessions: string[]): void {
    const unique = [...new Set(sessions)].sort();
    const key = unique.join("\n");
    if (key === this.key && this.source && !this.stopped) return;
    this.key = key;
    this.sessions = unique;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  /** Reconnects right away if the stream is closed (network back, tab visible again). */
  nudge(): void {
    if (this.stopped || this.key === undefined) return;
    if (this.source && this.source.readyState !== CLOSED) return;
    this.connect();
  }

  /** Reopens the stream now (fresh snapshots), e.g. after a compaction rewrote history. */
  refresh(): void {
    if (this.stopped || this.key === undefined) return;
    this.attempt = 0;
    this.connect();
  }

  close(): void {
    this.stopped = true;
    this.cancelRetry?.();
    this.source?.close();
    this.options.onStatus?.("closed");
  }

  private connect(): void {
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    this.source?.close();
    this.options.onStatus?.(this.attempt ? "reconnecting" : "connecting");
    const source = this.options.create(streamUrl(this.sessions));
    this.source = source;
    source.onopen = () => {
      if (this.source !== source) return;
      this.attempt = 0;
      this.options.onStatus?.("open");
    };
    source.onmessage = (event) => {
      if (this.source !== source) return;
      let frame: ServerFrame;
      try {
        frame = JSON.parse(event.data) as ServerFrame;
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object" || typeof frame.t !== "string") return;
      if (frame.t === "hello" && frame.protocolVersion !== PROTOCOL_VERSION) {
        this.stopped = true;
        source.close();
        this.options.onStatus?.("closed");
        this.options.onProtocolMismatch?.();
        return;
      }
      this.enqueue(frame);
      // The server ends the stream after `resync`; reconnect now for a fresh snapshot.
      if (frame.t === "resync") this.connect();
    };
    source.onerror = () => {
      if (this.source !== source || this.stopped) return;
      this.options.onStatus?.("reconnecting");
      if (source.readyState !== CLOSED) return; // the browser retries on its own
      this.options.onClosed?.();
      const delay = backoffDelay(this.attempt++, this.options.random);
      this.cancelRetry = this.setTimer(() => {
        this.cancelRetry = undefined;
        if (!this.stopped) this.connect();
      }, delay);
    };
  }

  private enqueue(frame: ServerFrame): void {
    this.queue.push(frame);
    if (this.scheduled) return;
    this.scheduled = true;
    this.requestFrame(() => {
      this.scheduled = false;
      const batch = this.queue;
      this.queue = [];
      if (batch.length) this.options.onFrames(batch);
    });
  }
}
