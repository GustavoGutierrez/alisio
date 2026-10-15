/**
 * Web side of Proof (specs/011 phase 5): the pure model of the card, the store actions through a
 * fake API, the presentational view (walked as a VNode tree: the web tests have no DOM), the EN/ES
 * strings, and the lazy loading that keeps the initial bundle inside its budget (D7).
 */
import { readFileSync } from "node:fs";
import type { GoalInfo, ProofCriterion, ProofLedger, ServerFrame } from "@alisio/sdk";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pk, proofStrings } from "../packages/web/src/components/proof/strings.ts";
import { locale } from "../packages/web/src/i18n/index.ts";
import { api, currentId, goalInfo, toast } from "../packages/web/src/store/app.ts";
import {
  addCriterion,
  exportHref,
  ledger,
  loadProof,
  markNotApplicable,
  overrideAvailable,
  proofCounts,
  proofRows,
  saveCriterion,
} from "../packages/web/src/store/proof.ts";

/** A Preact node, as far as these tests walk it (the root tsconfig has no JSX and no preact). */
type ComponentChildren = unknown;
interface VNode<P = Record<string, unknown>> {
  type: unknown;
  props: P;
}

// The view is JSX (the web package compiles it); it is loaded by path so the root typecheck, which
// has no JSX setting, does not resolve it.
const VIEW_PATH = "../packages/web/src/components/proof/ProofView.tsx";
let ProofView: (props: Record<string, unknown>) => ComponentChildren;
beforeAll(async () => {
  ProofView = ((await import(/* @vite-ignore */ VIEW_PATH)) as { ProofView: typeof ProofView })
    .ProofView;
});

const crit = (over: Partial<ProofCriterion> & { criterionId: string }): ProofCriterion => ({
  sessionId: "s1",
  text: "criterion",
  required: false,
  origin: "user",
  status: "not_checked",
  evidenceIds: [],
  ...over,
});
const ledgerOf = (criteria: ProofCriterion[], extra: Partial<ProofLedger> = {}): ProofLedger => ({
  sessionId: "s1",
  criteria,
  evidence: [],
  divergences: [],
  generatedAt: "2026-10-14T10:00:00.000Z",
  ...extra,
});
const SAMPLE = ledgerOf(
  [
    crit({
      criterionId: "a",
      text: "Tests pass",
      required: true,
      status: "verified",
      evidenceIds: ["e1"],
    }),
    crit({
      criterionId: "b",
      text: "Lint clean",
      required: true,
      status: "failed",
      evidenceIds: ["e2"],
    }),
    crit({
      criterionId: "c",
      text: "Docs explain it",
      required: true,
      status: "not_checked",
      stale: true,
    }),
    crit({ criterionId: "d", text: "Reads well", status: "manual_review" }),
    crit({
      criterionId: "e",
      text: "No UI",
      status: "not_applicable",
      notApplicableReason: "no UI",
    }),
  ],
  {
    evidence: [
      {
        evidenceId: "e1",
        criterionId: "a",
        verifierKind: "command",
        runId: "r1",
        callId: "call_1",
        ok: true,
        exitCode: 0,
        durationMs: 10,
        outputHash: "h",
        treeFingerprint: "t",
        filesTouched: [],
        capturedAt: "2026-10-14T09:00:00.000Z",
      },
    ],
    divergences: [{ claim: "the tests pass", actual: "not_checked" }],
  },
);

describe("the card model", () => {
  it("lists the criteria in ledger order with their status, stale mark and evidence", () => {
    const rows = proofRows(SAMPLE);
    expect(rows.map((r) => [r.text, r.status])).toEqual([
      ["Tests pass", "verified"],
      ["Lint clean", "failed"],
      ["Docs explain it", "not_checked"],
      ["Reads well", "manual_review"],
      ["No UI", "not_applicable"],
    ]);
    expect(rows[0]?.evidence).toMatchObject({ callId: "call_1", exitCode: 0 });
    expect(rows[2]?.stale).toBe(true);
  });

  it("counts the statuses and the required criteria that are not verified", () => {
    expect(proofCounts(SAMPLE)).toEqual({
      total: 5,
      verified: 1,
      failed: 1,
      notChecked: 1,
      manualReview: 1,
      notApplicable: 1,
      requiredUnmet: 2,
    });
  });

  it("offers the goal override only for a goal that can still be worked on, with something unmet", () => {
    const goal = (status: GoalInfo["status"]) => ({ status }) as GoalInfo;
    expect(overrideAvailable(goal("active"), SAMPLE)).toBe(true);
    expect(overrideAvailable(goal("paused"), SAMPLE)).toBe(true);
    expect(overrideAvailable(goal("blocked"), SAMPLE)).toBe(true);
    expect(overrideAvailable(goal("complete"), SAMPLE)).toBe(false);
    expect(overrideAvailable(goal("budget_limited"), SAMPLE)).toBe(false);
    expect(overrideAvailable(null, SAMPLE)).toBe(false);
    expect(overrideAvailable(goal("active"), ledgerOf([crit({ criterionId: "x" })]))).toBe(false);
  });

  it("builds the export link of the session", () => {
    expect(exportHref("s 1", "md")).toBe("/api/sessions/s%201/proof/export?format=md");
    expect(exportHref("s1", "json")).toBe("/api/sessions/s1/proof/export?format=json");
  });
});

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
/** The `data-status` of every criterion row, in order. */
function statusesOf(node: ComponentChildren, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) statusesOf(child, out);
    return out;
  }
  const vnode = node as VNode<Record<string, unknown>>;
  if (typeof vnode.type === "function") {
    statusesOf((vnode.type as (p: unknown) => ComponentChildren)(vnode.props), out);
    return out;
  }
  if (vnode.props?.["data-criterion"] !== undefined) out.push(String(vnode.props["data-status"]));
  statusesOf(vnode.props?.children as ComponentChildren, out);
  return out;
}
const noop = () => undefined;
const handlers = {
  onAdd: noop,
  onSave: noop,
  onNotApplicable: noop,
  onOverride: noop,
};

describe("the card view", () => {
  afterEach(() => {
    locale.value = "en";
  });

  it("shows every criterion with the status of the ledger, in order", () => {
    const view = ProofView({
      ledger: SAMPLE,
      mode: "panel",
      goal: null,
      sessionId: "s1",
      ...handlers,
    });
    expect(statusesOf(view)).toEqual([
      "verified",
      "failed",
      "not_checked",
      "manual_review",
      "not_applicable",
    ]);
    const text = textOf(view);
    for (const row of SAMPLE.criteria) expect(text).toContain(row.text);
  });

  it("shows the divergence warning and the stale mark", () => {
    const text = textOf(
      ProofView({ ledger: SAMPLE, mode: "panel", goal: null, sessionId: "s1", ...handlers }),
    );
    expect(text).toContain("the tests pass");
    expect(text).toContain(pk("stale"));
  });

  it("the thread card is read-only: no add form, no per-row actions", () => {
    const card = textOf(
      ProofView({ ledger: SAMPLE, mode: "card", goal: null, sessionId: "s1", ...handlers }),
    );
    const panel = textOf(
      ProofView({ ledger: SAMPLE, mode: "panel", goal: null, sessionId: "s1", ...handlers }),
    );
    expect(panel).toContain(pk("add"));
    expect(card).not.toContain(pk("add"));
    expect(panel).toContain(pk("edit"));
    expect(card).not.toContain(pk("edit"));
  });

  it("offers the override only in the panel and only with an active goal over unmet criteria", () => {
    const goal = { status: "active" } as GoalInfo;
    const withGoal = textOf(
      ProofView({ ledger: SAMPLE, mode: "panel", goal, sessionId: "s1", ...handlers }),
    );
    expect(withGoal).toContain(pk("override"));
    const without = textOf(
      ProofView({ ledger: SAMPLE, mode: "panel", goal: null, sessionId: "s1", ...handlers }),
    );
    expect(without).not.toContain(pk("override"));
    const card = textOf(
      ProofView({ ledger: SAMPLE, mode: "card", goal, sessionId: "s1", ...handlers }),
    );
    expect(card).not.toContain(pk("override"));
  });

  it("renders in Spanish with the same rows", () => {
    locale.value = "es";
    const view = ProofView({
      ledger: SAMPLE,
      mode: "panel",
      goal: null,
      sessionId: "s1",
      ...handlers,
    });
    expect(textOf(view)).toContain(pk("status.verified"));
    expect(pk("status.verified")).not.toBe(proofStrings.en["status.verified"]);
    expect(statusesOf(view)).toHaveLength(5);
  });

  it("an empty ledger invites the first criterion in the panel", () => {
    const empty = textOf(
      ProofView({ ledger: ledgerOf([]), mode: "panel", goal: null, sessionId: "s1", ...handlers }),
    );
    expect(empty).toContain(pk("empty"));
  });
});

describe("the strings", () => {
  it("keep the same keys in both languages and translate every one", () => {
    const keys = Object.keys(proofStrings.en);
    expect(Object.keys(proofStrings.es).sort()).toEqual([...keys].sort());
    const same = new Set<string>(["panel"]);
    for (const key of keys) {
      expect((proofStrings.en as Record<string, string>)[key], `en ${key}`).toBeTruthy();
      expect((proofStrings.es as Record<string, string>)[key], `es ${key}`).toBeTruthy();
      if (!same.has(key))
        expect((proofStrings.es as Record<string, string>)[key], `es differs ${key}`).not.toBe(
          (proofStrings.en as Record<string, string>)[key],
        );
    }
  });
});

describe("the store through a fake API", () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  beforeEach(() => {
    calls.length = 0;
    currentId.value = "s1";
    ledger.value = undefined;
    toast.value = undefined;
    vi.spyOn(api, "request").mockImplementation(async (method, path, body) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      return SAMPLE as never;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    currentId.value = undefined;
    ledger.value = undefined;
  });

  it("loads the ledger of the open session", async () => {
    await loadProof("s1");
    expect(calls).toEqual([{ method: "GET", path: "/api/sessions/s1/proof" }]);
    expect(ledger.value?.criteria).toHaveLength(5);
  });

  it("ignores an answer for a session that is no longer open", async () => {
    currentId.value = "other";
    await loadProof("s1");
    expect(ledger.value).toBeUndefined();
  });

  it("adds, edits and marks criteria through the user routes", async () => {
    await addCriterion("s1", { text: "Tests pass", verify: "pnpm test", required: true });
    await saveCriterion("s1", "a", { text: "Tests pass!", required: false });
    await markNotApplicable("s1", "b", "no UI");
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/sessions/s1/proof/criteria",
        body: { text: "Tests pass", verify: "pnpm test", required: true },
      },
      {
        method: "POST",
        path: "/api/sessions/s1/proof/criteria",
        body: { criterionId: "a", text: "Tests pass!", required: false },
      },
      {
        method: "POST",
        path: "/api/sessions/s1/proof/criteria/b/not-applicable",
        body: { reason: "no UI" },
      },
    ]);
  });

  it("shows a failure as a toast and keeps the ledger", async () => {
    vi.mocked(api.request).mockRejectedValueOnce(new Error("boom"));
    expect(await addCriterion("s1", { text: "x" })).toBe(false);
    expect(toast.value).toBeTruthy();
  });

  it("completes the goal as the user, with what this window saw", async () => {
    const { overrideGoal } = await import("../packages/web/src/store/goal.ts");
    goalInfo.value = { sessionId: "s1", goalId: "g", epoch: 4, status: "active" } as GoalInfo;
    await overrideGoal(goalInfo.value, "checked by hand");
    expect(calls.at(-1)).toEqual({
      method: "POST",
      path: "/api/sessions/s1/goal/override",
      body: { reason: "checked by hand", expect: { goalId: "g", epoch: 4 } },
    });
    goalInfo.value = null;
  });
});

describe("the stream and the lazy loading (D7)", () => {
  it("keeps the card, its store and its strings out of the initial bundle", () => {
    const app = readFileSync("packages/web/src/app.tsx", "utf8");
    expect(app).not.toMatch(/^import .*components\/proof/m);
    expect(app).toMatch(/import\("\.\/components\/proof\/ProofCard\.tsx"\)/);
    const store = readFileSync("packages/web/src/store/app.ts", "utf8");
    expect(store).not.toMatch(/^import .*from "\.\/proof\.ts"/m);
    for (const file of [
      "packages/web/src/store/app.ts",
      "packages/web/src/app.tsx",
      "packages/web/src/store/composer.ts",
    ])
      expect(readFileSync(file, "utf8"), file).not.toMatch(/components\/proof\/strings/);
  });

  it("counts criteria from the snapshot and from proof_updated, and resets on another session", async () => {
    const { receiveProofFrame } = await import("../packages/web/src/store/proof-frame.ts");
    const snapshot = { t: "snapshot", sessionId: "s1", proof: { criteria: 3 } } as ServerFrame;
    expect(receiveProofFrame(snapshot, "s1")).toEqual({ count: 3, changed: false });
    expect(receiveProofFrame(snapshot, "other")).toBeUndefined();
    const updated = {
      t: "event",
      sessionId: "s1",
      event: {
        type: "proof_updated",
        data: { criterionId: "c", status: "verified", stale: false },
      },
    } as ServerFrame;
    expect(receiveProofFrame(updated, "s1")).toEqual({ count: undefined, changed: true });
    const plain = { t: "message", sessionId: "s1" } as unknown as ServerFrame;
    expect(receiveProofFrame(plain, "s1")).toBeUndefined();
  });
});
