/**
 * Web side of the plan review (Phase 2): recognising a plan interaction, the answers each decision
 * sends, the plan taken from the `exit_plan` call, replay/withdraw of a pending review, the
 * agent cycle staying blocked while it is pending, EN/ES strings and the lazy loading that keeps
 * the initial bundle inside its budget.
 */
import { readFileSync } from "node:fs";
import { PLAN_OPTIONS, PLAN_REVIEW_TITLE } from "@alisio/core";
import type { AgentInfo, PendingInteraction, ServerFrame, SessionDetail } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { en } from "../packages/web/src/i18n/en.ts";
import { es } from "../packages/web/src/i18n/es.ts";
import {
  agentList,
  api,
  currentId,
  cycleAgent,
  detail,
  pending,
} from "../packages/web/src/store/app.ts";
import { applyPending, emptyPending, visiblePending } from "../packages/web/src/store/pending.ts";
import {
  isPlanChoice,
  OPTION_HINTS,
  OPTION_LABELS,
  planAnswer,
  planFromArguments,
  planReviewOf,
} from "../packages/web/src/store/plan-review.ts";
import { toolLabel } from "../packages/web/src/util/tools.ts";

const interaction = (patch: Partial<PendingInteraction["request"]> = {}): PendingInteraction => ({
  interactionId: "i1",
  sessionId: "s1",
  workspaceId: "w1",
  request: {
    kind: "questions",
    questions: [
      {
        id: "plan",
        header: "Plan review",
        question: PLAN_REVIEW_TITLE,
        options: PLAN_OPTIONS,
      },
    ],
    plan: {
      planId: "p1",
      revision: 2,
      hash: "h",
      title: "Add a flag",
      markdown: "# Plan",
      artifact: {
        id: "art_1",
        sessionId: "s1",
        title: "Add a flag",
        fileName: "plan.md",
        kind: "document",
        mimeType: "text/markdown",
        bytes: 6,
        fileCount: 1,
        previewable: true,
        createdAt: 1,
        status: "ready",
      },
    },
    ...patch,
  } as PendingInteraction["request"],
});

describe("plan interaction", () => {
  it("is recognised by its plan; other questions and selects are not", () => {
    const view = planReviewOf(interaction());
    expect(view?.plan).toMatchObject({ revision: 2, title: "Add a flag" });
    expect(view?.plan.artifact?.fileName).toBe("plan.md");
    expect(planReviewOf(interaction({ plan: undefined }))).toBeUndefined();
    expect(
      planReviewOf({
        interactionId: "i2",
        workspaceId: "w1",
        request: { kind: "select", select: { title: "t", options: [] } },
      }),
    ).toBeUndefined();
  });

  it("sends the exact answers: approve, skip, and context with its text", () => {
    const { question } = planReviewOf(interaction()) as NonNullable<
      ReturnType<typeof planReviewOf>
    >;
    expect(planAnswer(question, "approve", "ignored")).toEqual({ plan: "approve" });
    expect(planAnswer(question, "skip")).toEqual({ plan: "skip" });
    expect(planAnswer(question, "context", "  also cover Windows ")).toEqual({
      plan: "context",
      "plan:text": "also cover Windows",
    });
    // Context without text never goes out as a context answer.
    expect(planAnswer(question, "context", "   ")).toEqual({ plan: "skip" });
  });

  it("takes the plan from the exit_plan arguments once the JSON is complete", () => {
    expect(planFromArguments(JSON.stringify({ title: "T", plan: "# P\n1. x" }))).toEqual({
      title: "T",
      plan: "# P\n1. x",
    });
    expect(planFromArguments('{"plan": "# unfinished')).toBeUndefined();
    expect(planFromArguments(JSON.stringify({ title: "no plan" }))).toBeUndefined();
    expect(planFromArguments("not json")).toBeUndefined();
  });

  it("the tool row is labelled Plan", () => {
    expect(toolLabel("exit_plan")).toBe("Plan");
  });
});

describe("pending plan review", () => {
  const session = { id: "s1", workspaceId: "w1" } as SessionDetail;

  it("shows up from an interaction frame and from a snapshot replay after a reload", () => {
    const frame: ServerFrame = { t: "interaction", interaction: interaction() };
    let state = applyPending(emptyPending(), frame);
    expect(visiblePending(state, session).interactions).toHaveLength(1);
    // A reload: the new stream's snapshot carries the pending interaction again.
    state = applyPending(emptyPending(), {
      t: "snapshot",
      sessionId: "s1",
      cursor: 3,
      session: { id: "s1", workspaceId: "w1" } as never,
      messages: { items: [], hasMore: false },
      pending: { approvals: [], interactions: [interaction()] },
    });
    const [replayed] = visiblePending(state, session).interactions;
    expect(replayed && planReviewOf(replayed)?.plan.revision).toBe(2);
  });

  it("is withdrawn with the server's frame (cancelled run, answered elsewhere)", () => {
    let state = applyPending(emptyPending(), { t: "interaction", interaction: interaction() });
    state = applyPending(state, { t: "interaction_withdrawn", interactionId: "i1" });
    expect(visiblePending(state, session).interactions).toEqual([]);
  });
});

describe("the agent cycle while a review is pending", () => {
  const agent = (id: string): AgentInfo =>
    ({ id, name: id, description: id, source: "builtin", default: id === "build" }) as AgentInfo;
  const original = api.command;
  let calls: string[];
  beforeEach(() => {
    calls = [];
    currentId.value = "s1";
    detail.value = {
      id: "s1",
      workspaceId: "w1",
      agent: "plan",
      presets: [],
      children: [],
    } as unknown as SessionDetail;
    agentList.value = [agent("build"), agent("plan")];
    api.command = (async (_id: string, body: { name: string }) => {
      calls.push(body.name);
      return { output: "", effects: [] };
    }) as typeof api.command;
    api.session = (async () => detail.value) as typeof api.session;
  });
  afterEach(() => {
    api.command = original;
    pending.value = emptyPending();
    currentId.value = undefined;
    detail.value = undefined;
    agentList.value = [];
  });

  it("does not cycle while the plan decision is pending, and cycles again once it is gone", async () => {
    pending.value = applyPending(emptyPending(), { t: "interaction", interaction: interaction() });
    await cycleAgent(1);
    expect(calls).toEqual([]);
    pending.value = emptyPending();
    await cycleAgent(1);
    expect(calls).toEqual(["agent:build"]);
  });
});

describe("strings and loading", () => {
  const keys = [
    "plan.review.eyebrow",
    "plan.review.revision",
    "plan.review.title",
    "plan.review.contextLabel",
    "plan.review.contextPlaceholder",
    "plan.review.send",
    "plan.review.back",
    ...Object.values(OPTION_LABELS),
    ...Object.values(OPTION_HINTS),
  ] as const;

  it("has every plan string in English and Spanish, translated", () => {
    for (const key of keys) {
      expect(en[key as keyof typeof en], `en ${key}`).toBeTruthy();
      expect(es[key as keyof typeof es], `es ${key}`).toBeTruthy();
      expect(es[key as keyof typeof es], `es differs ${key}`).not.toBe(en[key as keyof typeof en]);
    }
  });

  it("shows the exact decision strings: English from the server's options, Spanish from the owner", () => {
    expect(en["plan.review.title"]).toBe("Plan complete. What would you like to do?");
    expect(es["plan.review.title"]).toBe("Plan completo. ¿Qué quieres hacer?");
    for (const option of PLAN_OPTIONS) {
      expect(isPlanChoice(option.value)).toBe(true);
      expect(en[OPTION_LABELS[option.value as keyof typeof OPTION_LABELS]]).toBe(option.label);
    }
  });

  it("loads the review screen lazily (it must never join the initial bundle)", () => {
    const app = readFileSync("packages/web/src/app.tsx", "utf8");
    expect(app).not.toMatch(/^import .*PlanReviewPanel/m);
    expect(app).toMatch(/import\("\.\/components\/approval\/PlanReviewPanel\.tsx"\)/);
  });
});
