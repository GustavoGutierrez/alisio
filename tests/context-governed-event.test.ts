import type { ContextElisionReason, ContextGovernedData, Message } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import type { ElisionReason } from "../packages/core/src/context/elide.ts";
import { projectContext } from "../packages/core/src/context/elide.ts";
import { governanceSnapshot, governedEventData } from "../packages/core/src/context/governance.ts";
import { buildInventory, countSegments } from "../packages/core/src/context/inventory.ts";
import type { UsageSummary } from "../packages/core/src/context/usage.ts";

const user = (text: string): Message => ({ role: "user", text });
const asst = (text: string, calls: Array<[string, string, object]> = []): Message => ({
  role: "assistant",
  text,
  calls: calls.map(([id, name, args]) => ({ id, name, arguments: JSON.stringify(args) })),
});
const tool = (callId: string, text: string): Message => ({
  role: "tool",
  callId,
  result: { content: [{ type: "text", text }] },
});
const read = (path: string, n: number) =>
  JSON.stringify({ path, sha256: n.toString(16).padStart(64, "0"), content: "x".repeat(400) });

/** `n` reads of different content of the same path, each answered, then closing turns. */
function history(n: number): Message[] {
  const out: Message[] = [user("go")];
  for (let i = 0; i < n; i++)
    out.push(asst("", [[`c${i}`, "read_file", { path: "a.ts" }]]), tool(`c${i}`, read("a.ts", i)));
  out.push(user("next"), asst("done"), user("more"), asst("done again"));
  return out;
}
const options = {
  mode: "shadow" as const,
  minAgeTurns: 2,
  epochMessages: 0,
  policyVersion: 1,
};
const usage: UsageSummary = {
  observed: 3,
  used: 1,
  byKind: { tool_result: { observed: 3, used: 1 } },
  byTool: { read_file: { observed: 3, used: 1 } },
  unattributed: 2,
  pending: 1,
  stubOnly: 0,
  rereads: 0,
  evicted: 0,
};

describe("context_governed payload", () => {
  it("pins the SDK elision reasons to the core ones", () => {
    const same = (a: ElisionReason, b: ContextElisionReason) => [a, b];
    expect(same("superseded_read", "superseded_read")).toHaveLength(2);
    const _core: ElisionReason extends ContextElisionReason ? true : never = true;
    const _sdk: ContextElisionReason extends ElisionReason ? true : never = true;
    expect([_core, _sdk]).toEqual([true, true]);
  });

  it("countSegments applies the inventory rule without hashing", () => {
    for (const messages of [
      history(0),
      history(5),
      [user("a"), asst(""), asst("t", [["c", "read_file", {}]]), tool("c", "x")],
      [{ role: "user", text: "cp", summary: true } as Message, asst("", [["c", "x", {}]])],
    ])
      expect(countSegments(messages)).toBe(buildInventory(messages).segments.length);
  });

  it("builds the payload from the snapshot and the usage summary", () => {
    const messages = history(6);
    const snapshot = governanceSnapshot(projectContext(messages, options), options, 3);
    expect(snapshot.segments).toBe(countSegments(messages));
    expect(snapshot.newlyElided.length).toBe(snapshot.elided);
    const data = governedEventData(snapshot, usage);
    expect(data).toMatchObject({
      policyVersion: 1,
      mode: "shadow",
      request: 3,
      messages: messages.length,
      segments: snapshot.segments,
      elided: snapshot.elided,
      tokensSaved: snapshot.tokensSaved,
      usage: { observed: 3, used: 1, pending: 1, unattributed: 2 },
    });
    expect(data.elidedCallIds).toEqual(snapshot.newlyElided);
    expect(data.usage?.byTool).toEqual({ read_file: { observed: 3, used: 1 } });
  });

  it("reports only the call ids elided since the previous request", () => {
    const first = governanceSnapshot(projectContext(history(6), options), options, 1);
    const second = governanceSnapshot(projectContext(history(9), options), options, 2, first);
    expect(second.elided).toBeGreaterThan(first.elided);
    expect(second.newlyElided).toEqual(
      second.elisions
        .map((e) => e.callId)
        .filter((id) => !first.elisions.some((p) => p.callId === id)),
    );
    expect(second.newlyElided.length).toBe(second.elided - first.elided);
  });

  it("stays under 4 KB with 1000 elisions and caps the id delta at 32", () => {
    const snapshot = governanceSnapshot(projectContext(history(1000), options), options, 1);
    expect(snapshot.elided).toBeGreaterThan(900);
    const data = governedEventData(snapshot, {
      ...usage,
      byTool: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [
          `tool_${String(i).padStart(2, "0")}`,
          { observed: 1, used: 0 },
        ]),
      ),
    });
    expect(data.elidedCallIds).toHaveLength(32);
    expect(data.elidedCallIdsOmitted).toBe(snapshot.elided - 32);
    expect(Object.keys(data.usage?.byTool ?? {}).length).toBeLessThanOrEqual(16);
    expect(data.usage?.byTool?.other?.observed).toBeGreaterThan(0);
    expect(JSON.stringify(data).length).toBeLessThan(4096);
  });

  it("omits optional fields that carry nothing", () => {
    const snapshot = governanceSnapshot(projectContext(history(0), options), options, 1);
    const data: ContextGovernedData = governedEventData(snapshot);
    expect(data.elidedCallIds).toBeUndefined();
    expect(data.elidedCallIdsOmitted).toBeUndefined();
    expect(data.usage).toBeUndefined();
  });
});
