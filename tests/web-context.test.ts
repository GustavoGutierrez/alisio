/**
 * Web side of the Context Governor panel (specs/012 phase 5): the pure model, the presentational
 * view (walked as a VNode tree: the web tests have no DOM), the EN/ES strings, the loader through a
 * fake API, and the lazy loading that keeps the initial bundle inside its budget. The panel and the
 * TUI render the same `ContextReport`, so the parity test compares both renderings of one report.
 */
import { readFileSync } from "node:fs";
import type { ContextReport, ServerFrame } from "@alisio/sdk";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { formatContextReport } from "../packages/core/src/context/format.ts";
import { ck, contextStrings } from "../packages/web/src/components/context/strings.ts";
import { locale } from "../packages/web/src/i18n/index.ts";
import { api, currentId } from "../packages/web/src/store/app.ts";
import { isContextGoverned } from "../packages/web/src/store/context-frame.ts";
import {
  contextRows,
  contextSummary,
  loadContextReport,
  reportHref,
  report as stored,
} from "../packages/web/src/store/context-report.ts";

type ComponentChildren = unknown;
interface VNode<P = Record<string, unknown>> {
  type: unknown;
  props: P;
}

// The view is JSX (the web package compiles it); it is loaded by path so the root typecheck, which
// has no JSX setting, does not resolve it.
const VIEW_PATH = "../packages/web/src/components/context/ContextView.tsx";
let ContextView: (props: Record<string, unknown>) => ComponentChildren;
beforeAll(async () => {
  ContextView = (
    (await import(/* @vite-ignore */ VIEW_PATH)) as { ContextView: typeof ContextView }
  ).ContextView;
});

const REPORT: ContextReport = {
  sessionId: "s1",
  policyVersion: 1,
  mode: "on",
  request: 4,
  messages: 31,
  segments: [
    {
      id: "inv000000001",
      kind: "invariant",
      origin: "invariants",
      tokens: 12,
      criticality: "pinned",
      reason: "invariant that must survive compaction",
    },
    {
      id: "aaaaaaaaaaaa",
      kind: "tool_result",
      origin: "src/app.ts",
      callId: "call_1",
      tokens: 900,
      criticality: "low",
      reason: "superseded read: superseded by a later read of src/app.ts with a different sha256",
      elided: { reason: "superseded_read", replacedBy: "call_3", tokensSaved: 880 },
      used: false,
    },
    {
      id: "bbbbbbbbbbbb",
      kind: "tool_result",
      origin: "src/app.ts",
      callId: "call_3",
      tokens: 910,
      criticality: "high",
      reason: "latest result for src/app.ts",
    },
    {
      id: "cccccccccccc",
      kind: "assistant",
      origin: "assistant",
      tokens: 40,
      criticality: "normal",
      reason: "ordinary assistant text",
    },
  ],
  tokensBefore: 4100,
  tokensAfter: 3220,
  tokensSaved: 880,
  elided: 1,
  byReason: { superseded_read: 1, stale_bg_output: 0, duplicate_search: 0 },
  invariants: { count: 3, omitted: 1, byKind: { instruction: 2, goal: 1 } },
  usedRatioByKind: { tool_result: 0.5 },
};

/** Every text node of a VNode tree (function components are called: the views have no hooks). */
function textOf(node: ComponentChildren): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const vnode = node as VNode<{ children?: ComponentChildren }>;
  if (typeof vnode.type === "function")
    return textOf((vnode.type as (p: unknown) => ComponentChildren)(vnode.props));
  return textOf(vnode.props?.children);
}
/** The `data-segment` ids of every row, in order, and which of them carry an elision reason. */
function rowsOf(
  node: ComponentChildren,
  out: Array<{ id: string; elided?: string }> = [],
): Array<{ id: string; elided?: string }> {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) rowsOf(child, out);
    return out;
  }
  const vnode = node as VNode<Record<string, unknown>>;
  if (typeof vnode.type === "function") {
    rowsOf((vnode.type as (p: unknown) => ComponentChildren)(vnode.props), out);
    return out;
  }
  if (vnode.props?.["data-segment"] !== undefined)
    out.push({
      id: String(vnode.props["data-segment"]),
      ...(vnode.props["data-elided"] ? { elided: String(vnode.props["data-elided"]) } : {}),
    });
  rowsOf(vnode.props?.children as ComponentChildren, out);
  return out;
}
const view = (report: ContextReport, showAll = false) =>
  ContextView({ report, showAll, onShowAll: () => undefined });

describe("the panel model", () => {
  it("lists only the segments with a decision to explain unless asked for all", () => {
    expect(contextRows(REPORT).map((r) => r.id)).toEqual(["inv000000001", "aaaaaaaaaaaa"]);
    expect(contextRows(REPORT, true).map((r) => r.id)).toEqual(REPORT.segments.map((s) => s.id));
    expect(contextRows(REPORT)[1]).toMatchObject({
      callId: "call_1",
      elided: { reason: "superseded_read", replacedBy: "call_3", tokensSaved: 880 },
      used: false,
    });
  });

  it("summarizes the reasons in a fixed order, the used ratio and the hidden rows", () => {
    expect(contextSummary(REPORT)).toEqual({
      active: true,
      elided: 1,
      reasons: [["superseded_read", 1]],
      usedPercent: 50,
      hidden: 2,
    });
    expect(contextSummary({ ...REPORT, mode: "off" }).active).toBe(false);
  });
});

describe("the panel view", () => {
  afterEach(() => {
    locale.value = "en";
  });

  it("shows the segments and reasons of the report, in order", () => {
    const rows = rowsOf(view(REPORT));
    expect(rows).toEqual([
      { id: "inv000000001" },
      { id: "aaaaaaaaaaaa", elided: "superseded_read" },
    ]);
    const text = textOf(view(REPORT));
    expect(text).toContain(ck("reason.superseded_read"));
    expect(text).toContain("call_3");
    // Counts by kind, from the report; there is no invariant text to show.
    expect(text).toContain(ck("invariants", { n: 3 }));
    expect(text).toContain(`${ck("invariantKind.instruction")} 2`);
    expect(text).toContain(`${ck("invariantKind.goal")} 1`);
    expect(text).toContain(ck("invariantsOmitted", { n: 1 }));
  });

  it("lists every segment when asked and says when the governor is off", () => {
    expect(rowsOf(view(REPORT, true))).toHaveLength(4);
    const off = textOf(view({ ...REPORT, mode: "off", segments: [], elided: 0 }));
    expect(off).toContain(ck("off"));
    expect(rowsOf(view({ ...REPORT, mode: "off", segments: [] }))).toEqual([]);
  });

  it("says 'would be elided' in shadow mode and renders in Spanish", () => {
    expect(textOf(view({ ...REPORT, mode: "shadow" }))).toContain("would be elided");
    locale.value = "es";
    const text = textOf(view(REPORT));
    expect(text).toContain(ck("reason.superseded_read"));
    expect(ck("reason.superseded_read")).not.toBe(contextStrings.en["reason.superseded_read"]);
    expect(rowsOf(view(REPORT))).toHaveLength(2);
  });

  it("accepts an enum value this build does not know", () => {
    const odd = {
      ...REPORT,
      segments: [
        {
          id: "dddddddddddd",
          kind: "future_kind",
          tokens: 1,
          criticality: "low",
          elided: { reason: "future_reason", tokensSaved: 1 },
        },
      ],
    } as unknown as ContextReport;
    expect(textOf(view(odd))).toContain("future_reason");
  });
});

describe("the same ContextReport in the web panel and in /context (TUI)", () => {
  it("lists the same segments with the same elision reasons", () => {
    const text = formatContextReport(REPORT);
    const tuiIds = [...text.matchAll(/^\| `([0-9a-z]+)` \|/gm)].map((m) => m[1]);
    const webIds = rowsOf(view(REPORT)).map((r) => r.id);
    expect(webIds).toEqual(tuiIds);
    for (const row of contextRows(REPORT))
      if (row.elided) expect(text).toContain(row.elided.reason);
    expect(text).toContain("call_3");
    // The same invariant counts by kind in both renderings.
    expect(text).toContain("Invariants: 3 (1 omitted) · instruction 2 · goal 1");
    expect(textOf(view(REPORT))).toContain(`${ck("invariantKind.instruction")} 2`);
  });
});

describe("the strings", () => {
  it("keep the same keys in both languages and translate every one", () => {
    const keys = Object.keys(contextStrings.en);
    expect(Object.keys(contextStrings.es).sort()).toEqual([...keys].sort());
    const same = new Set<string>(["tokens", "criticality.normal", "invariantKind.plan"]);
    for (const key of keys) {
      const en = (contextStrings.en as Record<string, string>)[key];
      const es = (contextStrings.es as Record<string, string>)[key];
      expect(en, `en ${key}`).toBeTruthy();
      expect(es, `es ${key}`).toBeTruthy();
      const placeholders = (s?: string) => [...(s?.matchAll(/\{(\w+)\}/g) ?? [])].map((m) => m[1]);
      expect(placeholders(es).sort(), `placeholders ${key}`).toEqual(placeholders(en).sort());
      if (!same.has(key)) expect(es, `es differs ${key}`).not.toBe(en);
    }
  });
});

describe("the loader through a fake API", () => {
  beforeEach(() => {
    currentId.value = "s1";
    stored.value = undefined;
    vi.spyOn(api, "request").mockResolvedValue(REPORT as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    currentId.value = undefined;
    stored.value = undefined;
  });

  it("reads the report of the open session from its own route", async () => {
    await loadContextReport("s1");
    expect(api.request).toHaveBeenCalledWith("GET", "/api/sessions/s1/context/report");
    expect(reportHref("s 1")).toBe("/api/sessions/s%201/context/report");
    expect(stored.value?.elided).toBe(1);
  });

  it("ignores an answer for a session that is no longer open", async () => {
    currentId.value = "other";
    await loadContextReport("s1");
    expect(stored.value).toBeUndefined();
  });
});

describe("the stream and the lazy loading", () => {
  it("recognizes context_governed events of the open session only", () => {
    const event = (sessionId: string, type: string) =>
      ({ t: "event", sessionId, event: { type, data: {} } }) as unknown as ServerFrame;
    expect(isContextGoverned(event("s1", "context_governed"), "s1")).toBe(true);
    expect(isContextGoverned(event("s2", "context_governed"), "s1")).toBe(false);
    expect(isContextGoverned(event("s1", "context_reduced"), "s1")).toBe(false);
  });

  it("keeps the panel, its store and its strings out of the initial bundle", () => {
    const dock = readFileSync("packages/web/src/components/dock/Dock.tsx", "utf8");
    expect(dock).not.toMatch(/^import .*components\/context/m);
    expect(dock).toMatch(/import\("\.\.\/context\/ContextTab\.tsx"\)/);
    for (const file of [
      "packages/web/src/store/app.ts",
      "packages/web/src/app.tsx",
      "packages/web/src/store/composer.ts",
      "packages/web/src/components/dock/Dock.tsx",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/^import .*from "\.\/context-report\.ts"/m);
      expect(source, file).not.toMatch(/components\/context\/strings/);
    }
  });
});
