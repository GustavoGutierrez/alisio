/**
 * The TUI line of Forja executions (spec §11.3, Python spec §9.5): `js_run` shows how many nested
 * calls finished, `python_run` adds the engine that runs it (`oci` / `wasm` / `host!`), the row folds
 * like any other tool and history written before Forja still renders.
 */
import type { ForgeProgress, RunEvent } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { ToolBlock } from "../packages/cli/src/tui/components.ts";
import {
  initialViewState,
  itemsFromHistory,
  reduceEvent,
  type TranscriptItem,
  type ViewState,
} from "../packages/cli/src/tui/state.ts";

let seq = 0;
const ev = (type: string, data: unknown): RunEvent => ({
  schemaVersion: 1,
  runId: "r1",
  sessionId: "s1",
  seq: ++seq,
  type,
  timestamp: "2026-01-01T00:00:00.000Z",
  data,
});

const strip = (line: string) => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;
const toolOf = (s: ViewState): ToolItem => {
  const item = s.items.findLast((i) => i.kind === "tool");
  if (item?.kind !== "tool") throw new Error("no tool row");
  return item;
};
const headOf = (s: ViewState, width = 100) =>
  strip(new ToolBlock(toolOf(s)).render(width)[0] ?? "");

const progress = (
  engine: ForgeProgress["engine"],
  extra: Partial<ForgeProgress>,
): ForgeProgress => ({
  kind: "forge",
  executionId: "e1",
  engine,
  phase: "call",
  ...extra,
});
const call = (n: number, status: "started" | "succeeded" | "failed" | "denied") =>
  progress("javascript-quickjs", { call: { callId: n, tool: "read_file", status } });

function started(name: "js_run" | "python_run", summary = "") {
  return reduceEvent(
    initialViewState("m"),
    ev("tool_started", {
      id: "t1",
      name,
      arguments: summary ? JSON.stringify({ title: summary }) : "{}",
    }),
  );
}
const feed = (s: ViewState, data: unknown) =>
  reduceEvent(s, ev("tool_progress", { id: "t1", data }));

describe("js_run progress line", () => {
  it("counts finished against started nested calls while it runs", () => {
    let s = started("js_run");
    for (const p of [
      call(1, "started"),
      call(1, "succeeded"),
      call(2, "started"),
      call(3, "started"),
    ])
      s = feed(s, p);
    s = feed(s, call(3, "failed"));
    expect(toolOf(s).forge).toMatchObject({
      engine: "javascript-quickjs",
      started: 3,
      finished: 2,
    });
    expect(headOf(s)).toContain("· 2/3 calls");
    // The structured payload never leaks into the plain progress line.
    expect(toolOf(s).progress).toBeUndefined();
  });

  it("keeps the count after completion and shows the duration on the right", () => {
    let s = started("js_run");
    for (const n of [1, 2]) s = feed(feed(s, call(n, "started")), call(n, "succeeded"));
    s = reduceEvent(
      s,
      ev("tool_completed", { id: "t1", name: "js_run", isError: false, durationMs: 1200 }),
    );
    const head = headOf(s);
    expect(head).toContain("✓");
    expect(head).toContain("· 2/2 calls");
    expect(head).toMatch(/1\.2s$/);
  });

  it("shows the script's own progress message and fraction", () => {
    let s = started("js_run");
    s = feed(
      s,
      progress("javascript-quickjs", {
        phase: "running",
        message: "page 2",
        completed: 2,
        total: 9,
      }),
    );
    expect(headOf(s)).toContain("page 2 (2/9)");
  });

  it("folds a long result like any other tool row", () => {
    let s = started("js_run");
    s = feed(feed(s, call(1, "started")), call(1, "succeeded"));
    s = reduceEvent(
      s,
      ev("tool_completed", {
        id: "t1",
        name: "js_run",
        isError: false,
        preview: "1\n2\n3\n4\n5\n6\n7\n8",
      }),
    );
    const block = new ToolBlock(toolOf(s));
    block.fold = { expanded: false, kind: "output" };
    const lines = block.render(100).map(strip);
    expect(lines[0]).toContain("+");
    expect(lines[0]).toContain("1/1 calls");
    expect(lines.some((l) => l.includes("more lines"))).toBe(true);
  });
});

describe("python_run engine tag", () => {
  const tagged = (engine: ForgeProgress["engine"]) =>
    headOf(feed(started("python_run"), progress(engine, { phase: "running" })));

  it("names the isolation: oci, wasm, and host! when nothing isolates the script", () => {
    expect(tagged("python-oci")).toContain("· oci");
    expect(tagged("python-wasm")).toContain("· wasm");
    expect(tagged("python-managed")).toContain("· host!");
  });

  it("shows only the tag for Python (it makes no nested calls); js_run carries none", () => {
    const python = headOf(
      feed(started("python_run"), progress("python-wasm", { phase: "running" })),
    );
    expect(python).toContain("· wasm");
    expect(python).not.toContain("calls");
    const js = headOf(feed(started("js_run"), call(1, "started")));
    expect(js).toContain("0/1 calls");
    expect(js).not.toMatch(/· (oci|wasm|host!)/);
  });

  it("takes the engine from the result when no progress arrived", () => {
    const s = reduceEvent(
      started("python_run"),
      ev("tool_completed", {
        id: "t1",
        name: "python_run",
        isError: false,
        preview: "ok\nengine: python-managed (none) · reason: no isolated backend is ready",
      }),
    );
    expect(headOf(s)).toContain("· host!");
  });
});

describe("history", () => {
  const history = (name: string, text: string) =>
    itemsFromHistory([
      { role: "user", text: "go" },
      { role: "assistant", text: "", calls: [{ id: "h1", name, arguments: "{}" }] },
      { role: "tool", callId: "h1", result: { content: [{ type: "text", text }] } },
    ]);

  it("tags a replayed python_run from its engine line", () => {
    const item = history("python_run", "done\nengine: python-oci (os-container) · reason: ok").find(
      (i): i is ToolItem => i.kind === "tool",
    );
    expect(strip(new ToolBlock(item as ToolItem).render(100)[0] ?? "")).toContain("· oci");
  });

  it("still renders a persisted legacy execute call", () => {
    const item = history("execute", '{"result":2}').find((i): i is ToolItem => i.kind === "tool");
    const line = strip(new ToolBlock(item as ToolItem).render(100)[0] ?? "");
    expect(line).toContain("Execute");
    expect(line).not.toMatch(/calls|· (oci|wasm|host!)/);
  });
});
