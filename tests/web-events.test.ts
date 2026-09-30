import type { ServerFrame } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  type EventSourceLike,
  EventStream,
  streamUrl,
} from "../packages/web/src/net/events.ts";

class FakeSource implements EventSourceLike {
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(frame: unknown) {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
  fail(closed: boolean) {
    this.readyState = closed ? 2 : 0;
    this.onerror?.();
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

function harness() {
  const sources: FakeSource[] = [];
  const batches: ServerFrame[][] = [];
  const frames: Array<() => void> = [];
  const timers: Array<{ ms: number; run: () => void; cleared: boolean }> = [];
  const statuses: string[] = [];
  let mismatch = 0;
  const stream = new EventStream({
    create: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
    onFrames: (batch) => batches.push(batch),
    onStatus: (status) => statuses.push(status),
    onProtocolMismatch: () => mismatch++,
    requestFrame: (cb) => frames.push(cb),
    setTimer: (run, ms) => {
      const timer = { ms, run, cleared: false };
      timers.push(timer);
      return () => {
        timer.cleared = true;
      };
    },
    random: () => 0.5,
  });
  return {
    stream,
    sources,
    batches,
    timers,
    statuses,
    get mismatch() {
      return mismatch;
    },
    /** Runs pending animation frames. */
    frame() {
      for (const cb of frames.splice(0)) cb();
    },
    last: () => sources.at(-1) as FakeSource,
  };
}

const hello: ServerFrame = { t: "hello", protocolVersion: 1, streamId: "x", serverTime: 0 };
const delta = (text: string): ServerFrame => ({ t: "delta", sessionId: "s", runId: "r", text });

describe("event stream client", () => {
  it("builds one multiplexed URL per session set", () => {
    expect(streamUrl(["a", "b c"])).toBe("/api/events?session=a&session=b%20c");
    expect(streamUrl([])).toBe("/api/events");
  });

  it("delivers frames in order, at most one batch per animation frame", () => {
    const h = harness();
    h.stream.subscribe(["s"]);
    h.last().open();
    for (let i = 0; i < 500; i++) h.last().send(delta(String(i % 10)));
    expect(h.batches).toHaveLength(0);
    h.frame();
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]).toHaveLength(500);
    h.last().send(delta("x"));
    h.frame();
    h.frame();
    expect(h.batches).toHaveLength(2);
  });

  it("ignores malformed data lines", () => {
    const h = harness();
    h.stream.subscribe(["s"]);
    h.last().send("not json");
    h.last().send(delta("ok"));
    h.frame();
    expect(h.batches).toEqual([[delta("ok")]]);
  });

  it("reopens only when the session set changes", () => {
    const h = harness();
    h.stream.subscribe(["a", "b"]);
    h.stream.subscribe(["b", "a"]);
    expect(h.sources).toHaveLength(1);
    h.stream.subscribe(["a"]);
    expect(h.sources).toHaveLength(2);
    expect(h.sources[0]?.closed).toBe(true);
  });

  it("reconnects immediately with a fresh snapshot after resync", () => {
    const h = harness();
    h.stream.subscribe(["s"]);
    h.last().open();
    h.last().send(delta("a"));
    h.last().send({ t: "resync", sessionId: "s", reason: "overflow" });
    expect(h.sources).toHaveLength(2);
    expect(h.sources[0]?.closed).toBe(true);
    h.frame();
    expect(h.batches[0]?.map((f) => f.t)).toEqual(["delta", "resync"]);
  });

  it("backs off with jitter from 0.5 s up to 10 s when the stream closes, and resets on open", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, () => 0.5))).toEqual([
      500, 1000, 2000, 4000, 8000, 10000, 10000,
    ]);
    expect(backoffDelay(0, () => 0)).toBe(250);
    expect(backoffDelay(0, () => 1)).toBeLessThanOrEqual(750);
    const h = harness();
    h.stream.subscribe(["s"]);
    h.last().fail(true);
    expect(h.timers.map((t) => t.ms)).toEqual([500]);
    h.timers[0]?.run();
    expect(h.sources).toHaveLength(2);
    h.last().fail(true);
    expect(h.timers.map((t) => t.ms)).toEqual([500, 1000]);
    h.timers[1]?.run();
    h.last().open();
    h.last().fail(true);
    expect(h.timers.at(-1)?.ms).toBe(500);
    expect(h.statuses).toContain("reconnecting");
  });

  it("leaves transient errors to the browser's own retry", () => {
    const h = harness();
    h.stream.subscribe(["s"]);
    h.last().fail(false);
    expect(h.timers).toHaveLength(0);
    expect(h.sources).toHaveLength(1);
    expect(h.statuses.at(-1)).toBe("reconnecting");
  });

  it("reconnects at once when nudged (online, visible) while closed", () => {
    const h = harness();
    h.stream.subscribe(["s"]);
    h.last().fail(true);
    h.stream.nudge();
    expect(h.sources).toHaveLength(2);
    expect(h.timers[0]?.cleared).toBe(true);
    h.stream.nudge();
    expect(h.sources).toHaveLength(2);
  });

  it("reopens on refresh() for fresh snapshots", () => {
    const h = harness();
    h.stream.refresh();
    expect(h.sources).toHaveLength(0);
    h.stream.subscribe(["s"]);
    h.last().open();
    h.stream.refresh();
    expect(h.sources).toHaveLength(2);
    expect(h.sources[0]?.closed).toBe(true);
  });

  it("stops on a protocol mismatch", () => {
    const h = harness();
    h.stream.subscribe(["s"]);
    h.last().send({ ...hello, protocolVersion: 2 });
    expect(h.mismatch).toBe(1);
    expect(h.last().closed).toBe(true);
    h.last().fail(true);
    expect(h.timers).toHaveLength(0);
  });

  it("closes for good on close()", () => {
    const h = harness();
    h.stream.subscribe(["s"]);
    h.stream.close();
    expect(h.last().closed).toBe(true);
    h.stream.nudge();
    expect(h.sources).toHaveLength(1);
  });
});
