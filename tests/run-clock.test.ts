import { describe, expect, it } from "vitest";
import { HumanWaits } from "../packages/core/src/core/human-wait.ts";
import { type ClockSource, RunClock } from "../packages/core/src/core/run-clock.ts";
import { isTimeoutReason } from "../packages/core/src/core/timeout.ts";

/** A manual clock: time only moves when the test says so, and timers fire in order. */
class FakeSource implements ClockSource {
  time = 0;
  private next = 1;
  readonly timers = new Map<number, { at: number; fn: () => void }>();
  now() {
    return this.time;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown) {
    this.timers.delete(handle as number);
  }
  advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].fn();
    }
    this.time = target;
  }
}

describe("RunClock", () => {
  it("fires a TimeoutError at the limit of active time", () => {
    const source = new FakeSource();
    const clock = new RunClock(1000, source);
    source.advance(999);
    expect(clock.signal.aborted).toBe(false);
    source.advance(1);
    expect(clock.signal.aborted).toBe(true);
    expect(isTimeoutReason(clock.signal.reason)).toBe(true);
    expect(source.timers.size).toBe(0);
  });

  it("never fires while paused, however long the wait is", () => {
    const source = new FakeSource();
    const clock = new RunClock(1000, source);
    source.advance(400);
    const resume = clock.pause();
    expect(source.timers.size).toBe(0);
    source.advance(10_000_000);
    expect(clock.signal.aborted).toBe(false);
    expect(clock.activeMs()).toBe(400);
    resume();
  });

  it("re-arms with the remaining time on resume and keeps counting before and after", () => {
    const source = new FakeSource();
    const clock = new RunClock(1000, source);
    source.advance(400);
    const resume = clock.pause();
    source.advance(5000);
    resume();
    expect(clock.remainingMs()).toBe(600);
    source.advance(599);
    expect(clock.signal.aborted).toBe(false);
    source.advance(1);
    expect(clock.signal.aborted).toBe(true);
    expect(clock.activeMs()).toBe(1000);
  });

  it("nested and concurrent waits keep it paused until the last one ends", () => {
    const source = new FakeSource();
    const clock = new RunClock(1000, source);
    const a = clock.pause();
    source.advance(100);
    const b = clock.pause();
    source.advance(100);
    a();
    source.advance(100_000);
    expect(clock.paused).toBe(true);
    expect(clock.signal.aborted).toBe(false);
    b();
    expect(clock.paused).toBe(false);
    source.advance(1000);
    expect(clock.signal.aborted).toBe(true);
  });

  it("releasing the same pause twice does not resume early", () => {
    const source = new FakeSource();
    const clock = new RunClock(1000, source);
    const a = clock.pause();
    const b = clock.pause();
    a();
    a();
    expect(clock.paused).toBe(true);
    b();
    expect(clock.paused).toBe(false);
  });

  it("dispose frees the timer and later pauses or resumes are harmless", () => {
    const source = new FakeSource();
    const clock = new RunClock(1000, source);
    const resume = clock.pause();
    clock.dispose();
    resume();
    clock.pause()();
    source.advance(10_000);
    expect(source.timers.size).toBe(0);
    expect(clock.signal.aborted).toBe(false);

    const running = new RunClock(1000, source);
    expect(source.timers.size).toBe(1);
    running.dispose();
    expect(source.timers.size).toBe(0);
  });

  it("a stop while paused leaves nothing armed", () => {
    const source = new FakeSource();
    const clock = new RunClock(1000, source);
    clock.pause();
    clock.dispose();
    expect(source.timers.size).toBe(0);
  });
});

describe("HumanWaits", () => {
  it("pauses the clock of the asking session until the answer arrives", async () => {
    const source = new FakeSource();
    const waits = new HumanWaits();
    const clock = new RunClock(1000, source);
    waits.register("s1", clock);
    let answer: (value: string) => void = () => {};
    const pending = waits.track("s1", () => new Promise<string>((r) => (answer = r)));
    expect(clock.paused).toBe(true);
    source.advance(50_000);
    answer("yes");
    expect(await pending).toBe("yes");
    expect(clock.paused).toBe(false);
  });

  it("resumes when the wait rejects too", async () => {
    const waits = new HumanWaits();
    const clock = new RunClock(1000, new FakeSource());
    waits.register("s1", clock);
    await expect(waits.track("s1", () => Promise.reject(new Error("closed")))).rejects.toThrow();
    expect(clock.paused).toBe(false);
  });

  it("a child waiting for a person pauses its ancestors; a parent waiting for a child does not", () => {
    const parents = new Map([["child", "root"]]);
    const waits = new HumanWaits((s) => parents.get(s));
    const source = new FakeSource();
    const root = new RunClock(1000, source);
    const child = new RunClock(1000, source);
    waits.register("root", root);
    waits.register("child", child);
    const end = waits.begin("child");
    expect(child.paused && root.paused).toBe(true);
    end();
    expect(child.paused || root.paused).toBe(false);
    // The parent only waits for its child's work: nothing is paused.
    expect(root.paused).toBe(false);
  });

  it("a wait nobody can place pauses every active run", () => {
    const waits = new HumanWaits();
    const a = new RunClock(1000, new FakeSource());
    const b = new RunClock(1000, new FakeSource());
    waits.register("a", a);
    waits.register("b", b);
    const end = waits.begin();
    expect(a.paused && b.paused).toBe(true);
    end();
    expect(a.paused || b.paused).toBe(false);
  });

  it("an unregistered run is no longer paused", () => {
    const waits = new HumanWaits();
    const clock = new RunClock(1000, new FakeSource());
    const unregister = waits.register("s1", clock);
    unregister();
    waits.begin("s1");
    expect(clock.paused).toBe(false);
  });
});
