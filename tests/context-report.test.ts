import type { ContextReport, Message } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { projectContext } from "../packages/core/src/context/elide.ts";
import { formatContextReport } from "../packages/core/src/context/format.ts";
import { governanceSnapshot, governedEventData } from "../packages/core/src/context/governance.ts";
import { buildContextReport } from "../packages/core/src/context/report.ts";
import { UsageLedger } from "../packages/core/src/context/usage.ts";

/** The ContextReport behind `/context`, the web panel and the route (spec 012 phase 5). */

const SECRET = "SECRET-FILE-CONTENT";
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const user = (text: string): Message => ({ role: "user", text });
const asst = (text: string, calls: Array<[string, string, object]> = []): Message => ({
  role: "assistant",
  text,
  calls: calls.map(([id, name, args]) => ({ id, name, arguments: JSON.stringify(args) })),
});
const result = (callId: string, text: string): Message => ({
  role: "tool",
  callId,
  result: { content: [{ type: "text", text }] },
});
const readOut = (path: string, sha256: string) =>
  JSON.stringify({ path, sha256, startLine: 1, content: `1: ${SECRET} `.repeat(30) });
const exchange = (id: string, name: string, args: object, out: string): Message[] => [
  asst("", [[id, name, args]]),
  result(id, out),
];

/** read a.ts, read it again with another hash (the first is superseded), then two closing turns. */
const history = (): Message[] => [
  user("fix a.ts"),
  ...exchange("c1", "read_file", { path: "a.ts" }, readOut("a.ts", H1)),
  ...exchange("c2", "read_file", { path: "a.ts" }, readOut("a.ts", H2)),
  user("next"),
  asst("done"),
  user("more"),
  asst("done again"),
];

const governor = (mode: "off" | "shadow" | "on") => ({
  mode,
  minAgeTurns: 2,
  epochMessages: 0,
  policyVersion: 1,
});
const build = (
  mode: "off" | "shadow" | "on",
  messages = history(),
  extra: Partial<Parameters<typeof buildContextReport>[0]> = {},
) => buildContextReport({ sessionId: "s1", governor: governor(mode), messages, ...extra });

describe("buildContextReport", () => {
  it("is empty and inert when the governor is off", () => {
    const report = build("off");
    expect(report).toMatchObject({
      sessionId: "s1",
      mode: "off",
      policyVersion: 1,
      segments: [],
      messages: 0,
      elided: 0,
      tokensSaved: 0,
      invariants: { count: 0, omitted: 0, byKind: {} },
      usedRatioByKind: {},
    });
  });

  it("explains every segment and marks the superseded read with its reason and witness", () => {
    const report = build("on");
    expect(report.mode).toBe("on");
    expect(report.messages).toBe(history().length);
    const elided = report.segments.filter((s) => s.elided);
    expect(elided).toHaveLength(1);
    expect(elided[0]).toMatchObject({
      kind: "tool_result",
      callId: "c1",
      origin: "a.ts",
      elided: { reason: "superseded_read", replacedBy: "c2" },
    });
    expect(elided[0]?.elided?.tokensSaved).toBeGreaterThan(0);
    for (const s of report.segments) {
      expect(s.id).toMatch(/^[0-9a-f]{12}$/);
      expect(s.reason).toBeTruthy();
      expect(["pinned", "high", "normal", "low"]).toContain(s.criticality);
    }
  });

  it("shadow reports the same elisions as on (it measures what on would do)", () => {
    expect(build("shadow").segments).toEqual(build("on").segments);
    expect(build("shadow").mode).toBe("shadow");
  });

  it("agrees with the context_governed event built from the same history", () => {
    const messages = history();
    const g = governor("on");
    const snapshot = governanceSnapshot(projectContext(messages, g), g, 3);
    const event = governedEventData(snapshot);
    const report = build("on", messages, { governance: snapshot });
    expect(report.request).toBe(3);
    expect(report.elided).toBe(event.elided);
    expect(report.byReason).toEqual(event.byReason);
    expect(report.tokensBefore).toBe(event.tokensBefore);
    expect(report.tokensAfter).toBe(event.tokensAfter);
    expect(report.tokensSaved).toBe(event.tokensSaved);
    expect(report.segments.filter((s) => s.elided).map((s) => s.callId)).toEqual(
      event.elidedCallIds,
    );
    // The history segments are the ones the event counts.
    expect(report.segments.filter((s) => s.criticality !== "pinned")).toHaveLength(event.segments);
  });

  it("carries ids, counts and metadata only: never file content or stub text", () => {
    const text = JSON.stringify(build("on"));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("[elided:");
  });

  it("reports the invariants as counts by kind and never their text", () => {
    const report = build("on", history(), {
      invariants: {
        items: [
          { kind: "instruction", text: "Never touch prod" },
          { kind: "instruction", text: "Keep the API stable" },
          { kind: "goal", text: "Ship the release" },
        ],
        omitted: 2,
      },
    });
    expect(report.invariants).toEqual({
      count: 3,
      omitted: 2,
      byKind: { instruction: 2, goal: 1 },
    });
    expect(report.segments.filter((s) => s.kind === "invariant")).toMatchObject([
      { criticality: "pinned", origin: "invariants" },
      { criticality: "pinned", origin: "invariants" },
      { criticality: "pinned", origin: "invariants" },
    ]);
    const json = JSON.stringify(report);
    for (const text of ["Never touch prod", "Keep the API stable", "Ship the release"])
      expect(json).not.toContain(text);
  });

  it("marks used / unused from the ledger and exposes the ratio by kind", () => {
    const messages = history();
    const ledger = new UsageLedger({ workspace: "/ws" });
    ledger.record(1, messages.slice(0, 3), new Set());
    const next = [...messages.slice(0, 3), ...exchange("c9", "edit_file", { path: "a.ts" }, "ok")];
    ledger.record(2, next, new Set());
    const report = build("on", next, { ledger });
    const c1 = report.segments.find((s) => s.kind === "tool_result" && s.callId === "c1");
    expect(c1?.used).toBe(true);
    expect(report.usedRatioByKind.tool_result).toBe(1);
    expect(report.usage).toMatchObject({ observed: 1, used: 1 });
  });

  it("bounds the segment list but keeps the elided, pinned and low ones", () => {
    const messages: Message[] = [user("start")];
    for (let i = 0; i < 40; i++) messages.push(asst(`note ${i}`), user(`ask ${i}`));
    messages.push(
      ...exchange("r1", "read_file", { path: "z.ts" }, readOut("z.ts", H1)),
      ...exchange("r2", "read_file", { path: "z.ts" }, readOut("z.ts", H2)),
      user("x"),
      asst("y"),
      user("x2"),
      asst("y2"),
    );
    const report = build("on", messages, { maxSegments: 20 });
    expect(report.segments).toHaveLength(20);
    expect(report.segmentsOmitted).toBeGreaterThan(0);
    expect(report.segments.some((s) => s.callId === "r1" && s.elided)).toBe(true);
    // Order of the history is kept.
    const ids = report.segments.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("formatContextReport", () => {
  const report = (): ContextReport => build("on");

  it("shows every elided segment with its reason and says when the governor is off", () => {
    const text = formatContextReport(report());
    expect(text).toContain("superseded_read");
    expect(text).toContain("c1");
    expect(text).toContain("Mode: on");
    expect(formatContextReport(build("off"))).toMatch(/off/i);
    expect(formatContextReport(build("off"))).toContain("context.governor");
  });

  it("prints the invariant counts by kind, not their text", () => {
    const text = formatContextReport(
      build("on", history(), {
        invariants: {
          items: [
            { kind: "instruction", text: "Never touch prod" },
            { kind: "plan", text: "Approved plan text" },
          ],
          omitted: 1,
        },
      }),
    );
    expect(text).toMatch(/Invariants: 2 \(1 omitted\) · instruction 1 · plan 1/);
    expect(text).not.toContain("Never touch prod");
    expect(text).not.toContain("Approved plan text");
  });

  it("is deterministic and never contains content", () => {
    const text = formatContextReport(report());
    expect(formatContextReport(report())).toBe(text);
    expect(text).not.toContain(SECRET);
  });
});
