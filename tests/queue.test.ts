import { describe, expect, it, vi } from "vitest";
import { InteractiveQueue } from "../packages/cli/src/tui/queue.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("InteractiveQueue ordering", () => {
  it("runs one job at a time, in FIFO arrival order regardless of session", () => {
    const q = new InteractiveQueue();
    const order: string[] = [];
    const job = (id: string, ms: number) =>
      q.submit({
        sessionId: id,
        run: async () => {
          order.push(`start:${id}`);
          await wait(ms);
          order.push(`end:${id}`);
          return id;
        },
        onWithdrawn: () => "withdrawn",
      });
    const a = job("root", 30);
    const b = job("sub-1", 5);
    const c = job("sub-2", 5);
    return Promise.all([a, b, c]).then((results) => {
      expect(order).toEqual([
        "start:root",
        "end:root",
        "start:sub-1",
        "end:sub-1",
        "start:sub-2",
        "end:sub-2",
      ]);
      expect(results).toEqual(["root", "sub-1", "sub-2"]);
    });
  });

  it("lets a later job start immediately once the current one settles, even on rejection", async () => {
    const q = new InteractiveQueue();
    const order: string[] = [];
    const failing = q
      .submit({
        run: async () => {
          order.push("a");
          throw new Error("boom");
        },
        onWithdrawn: () => undefined,
      })
      .catch(() => "caught");
    const next = q.submit({
      run: async () => {
        order.push("b");
        return "b";
      },
      onWithdrawn: () => undefined,
    });
    await expect(failing).resolves.toBe("caught");
    await expect(next).resolves.toBe("b");
    expect(order).toEqual(["a", "b"]);
  });
});

describe("withdrawal while queued", () => {
  it("never runs a job whose signal is already aborted before its turn", async () => {
    const q = new InteractiveQueue();
    const ran: string[] = [];
    const controller = new AbortController();
    controller.abort(new Error("cancelled early"));
    const blocker = q.submit({
      run: async () => {
        ran.push("blocker");
        await wait(20);
        return "blocker-done";
      },
      onWithdrawn: () => "n/a",
    });
    const withdrawn = q.submit({
      sessionId: "sub-1",
      signal: controller.signal,
      run: async () => {
        ran.push("should-not-run");
        return "ran";
      },
      onWithdrawn: () => "withdrawn-answer",
    });
    await expect(withdrawn).resolves.toBe("withdrawn-answer");
    expect(ran).not.toContain("should-not-run");
    await blocker;
    expect(ran).toEqual(["blocker"]);
  });

  it("withdraws a job that is cancelled while still waiting behind another", async () => {
    const q = new InteractiveQueue();
    const controller = new AbortController();
    const blocker = q.submit({
      run: async () => {
        await wait(30);
        return "blocker";
      },
      onWithdrawn: () => "n/a",
    });
    const waiting = q.submit({
      sessionId: "sub-2",
      signal: controller.signal,
      run: async () => "should-not-run",
      onWithdrawn: () => "withdrawn",
    });
    await wait(5);
    expect(q.isQueued("sub-2")).toBe(true);
    controller.abort(new Error("subagent cancelled"));
    await expect(waiting).resolves.toBe("withdrawn");
    expect(q.isQueued("sub-2")).toBe(false);
    await blocker;
  });

  it("keeps the queue moving after a withdrawn item leaves a gap", async () => {
    const q = new InteractiveQueue();
    const controller = new AbortController();
    const order: string[] = [];
    const blocker = q.submit({
      run: async () => {
        await wait(20);
        order.push("blocker");
      },
      onWithdrawn: () => undefined,
    });
    const withdrawn = q.submit({
      signal: controller.signal,
      run: async () => order.push("withdrawn-ran"),
      onWithdrawn: () => order.push("withdrawn"),
    });
    const after = q.submit({
      run: async () => order.push("after"),
      onWithdrawn: () => undefined,
    });
    await wait(5);
    controller.abort();
    await Promise.all([blocker, withdrawn, after]);
    expect(order).toEqual(["withdrawn", "blocker", "after"]);
  });
});

describe("current and queued visibility (for the agent tree panel)", () => {
  it("reports the active job's session/label while it runs, and clears afterward", async () => {
    const q = new InteractiveQueue();
    let seenWhileActive: ReturnType<InteractiveQueue["current"]>;
    const done = q.submit({
      sessionId: "sub-1",
      label: "general › explore",
      run: async () => {
        seenWhileActive = q.current();
        await wait(5);
        return "ok";
      },
      onWithdrawn: () => undefined,
    });
    expect(q.current()).toEqual({ sessionId: "sub-1", label: "general › explore" });
    await done;
    expect(seenWhileActive).toEqual({ sessionId: "sub-1", label: "general › explore" });
    expect(q.current()).toBeUndefined();
  });

  it("marks a session as queued while it waits, distinct from active", async () => {
    const q = new InteractiveQueue();
    const blocker = q.submit({
      sessionId: "root",
      run: async () => wait(20),
      onWithdrawn: () => undefined,
    });
    const second = q.submit({
      sessionId: "sub-1",
      run: async () => "done",
      onWithdrawn: () => undefined,
    });
    await wait(5);
    expect(q.current()?.sessionId).toBe("root");
    expect(q.isQueued("sub-1")).toBe(true);
    expect(q.isWaiting("sub-1")).toBe(true); // queued OR active both count as "waiting on the user"
    expect(q.isWaiting("root")).toBe(true);
    expect(q.isWaiting("nobody")).toBe(false);
    await Promise.all([blocker, second]);
    expect(q.isWaiting("sub-1")).toBe(false);
  });
});

describe("routing", () => {
  it("resolves each concurrent submitter with its own distinct result, never swapped", async () => {
    const q = new InteractiveQueue();
    const make = (id: string) =>
      q.submit({
        sessionId: id,
        run: async () => {
          await wait(id === "a" ? 20 : 5);
          return `answer-for-${id}`;
        },
        onWithdrawn: () => "withdrawn",
      });
    const [a, b, c] = await Promise.all([make("a"), make("b"), make("c")]);
    expect(a).toBe("answer-for-a");
    expect(b).toBe("answer-for-b");
    expect(c).toBe("answer-for-c");
  });
});
