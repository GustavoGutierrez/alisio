import type {
  CommandDescriptor,
  PendingApproval,
  PendingInteraction,
  SessionDetailWire,
} from "@alisio/sdk";
import { UI_BLOCK_KINDS } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { en } from "../packages/web/src/i18n/en.ts";
import { es } from "../packages/web/src/i18n/es.ts";
import { format } from "../packages/web/src/i18n/format.ts";
import { RENDERER_KINDS, rendererFor } from "../packages/web/src/renderers/kinds.ts";
import {
  historyStep,
  matchCommands,
  parseSlash,
  pushHistory,
} from "../packages/web/src/store/composer.ts";
import { applyPending, emptyPending, visiblePending } from "../packages/web/src/store/pending.ts";

const command = (name: string, extra: Partial<CommandDescriptor> = {}): CommandDescriptor => ({
  name,
  description: `${name} description`,
  source: "builtin",
  surfaces: ["tui", "web", "api"],
  execution: "core",
  ...extra,
});

describe("slash palette", () => {
  const catalog = [
    command("compact"),
    command("clear", { aliases: ["new"] }),
    command("stats"),
    command("wayfinder:explore", { source: "plugin", owner: "wayfinder" }),
    command("skill:review", { source: "skill" }),
  ];

  it("matches prefixes first, then aliases, then fuzzy subsequences", () => {
    expect(matchCommands(catalog, "c").map((c) => c.name)).toEqual(["compact", "clear"]);
    expect(matchCommands(catalog, "new").map((c) => c.name)).toEqual(["clear"]);
    expect(matchCommands(catalog, "expl").map((c) => c.name)).toEqual(["wayfinder:explore"]);
    expect(matchCommands(catalog, "sts").map((c) => c.name)).toEqual(["stats"]);
    expect(matchCommands(catalog, "").length).toBe(5);
    expect(matchCommands(catalog, "zzz")).toEqual([]);
  });

  it("parses a slash command only at the start of the text", () => {
    expect(parseSlash("/compact keep the tests")).toEqual({
      name: "compact",
      args: "keep the tests",
    });
    expect(parseSlash("/stats")).toEqual({ name: "stats", args: "" });
    expect(parseSlash("  /stats")).toEqual({ name: "stats", args: "" });
    expect(parseSlash("look at /etc/hosts")).toBeUndefined();
    expect(parseSlash("/")).toBeUndefined();
  });
});

describe("prompt history", () => {
  it("keeps the last entries without consecutive duplicates", () => {
    let history: string[] = [];
    for (const text of ["a", "b", "b", "  ", "c"]) history = pushHistory(history, text, 3);
    expect(history).toEqual(["a", "b", "c"]);
    expect(pushHistory(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]);
  });

  it("steps back and forward, returning the draft past the newest entry", () => {
    const history = ["one", "two"];
    let step = historyStep(history, undefined, -1, "draft");
    expect(step).toEqual({ index: 1, text: "two" });
    step = historyStep(history, step.index, -1, "draft");
    expect(step).toEqual({ index: 0, text: "one" });
    expect(historyStep(history, 0, -1, "draft")).toEqual({ index: 0, text: "one" });
    step = historyStep(history, 0, 1, "draft");
    expect(step).toEqual({ index: 1, text: "two" });
    expect(historyStep(history, 1, 1, "draft")).toEqual({ index: undefined, text: "draft" });
    expect(historyStep([], undefined, -1, "x")).toEqual({ index: undefined, text: "x" });
  });
});

describe("pending approvals and interactions", () => {
  const approval = (id: string, root = "s1"): PendingApproval => ({
    approvalId: id,
    sessionId: root,
    rootSessionId: root,
    kind: "effect",
    name: "write_file",
    effect: "write",
    input: "{}",
  });
  const interaction = (id: string, workspaceId = "w1"): PendingInteraction => ({
    interactionId: id,
    workspaceId,
    request: { kind: "select", select: { title: "Pick", options: [{ value: "a", label: "A" }] } },
  });
  const session = { id: "s1", workspaceId: "w1" } as SessionDetailWire;

  it("replaces a session's pending items from its snapshot and tracks frames", () => {
    let state = applyPending(emptyPending(), { t: "approval", approval: approval("x", "s2") });
    state = applyPending(state, {
      t: "snapshot",
      sessionId: "s1",
      cursor: 0,
      session: session,
      messages: { items: [], hasMore: false },
      pending: { approvals: [approval("a")], interactions: [interaction("i1")] },
    });
    state = applyPending(state, { t: "approval", approval: approval("b") });
    state = applyPending(state, { t: "approval", approval: approval("b") });
    expect(visiblePending(state, session).approvals.map((a) => a.approvalId)).toEqual(["a", "b"]);
    state = applyPending(state, {
      t: "approval_withdrawn",
      approvalId: "a",
      reason: "resolved_elsewhere",
    });
    state = applyPending(state, { t: "interaction", interaction: interaction("i2", "w9") });
    state = applyPending(state, { t: "interaction_withdrawn", interactionId: "i1" });
    const visible = visiblePending(state, session);
    expect(visible.approvals.map((a) => a.approvalId)).toEqual(["b"]);
    expect(visible.interactions).toEqual([]);
    expect(state.approvals.map((a) => a.approvalId)).toContain("x");
  });
});

describe("renderer registry", () => {
  it("has a renderer for every UiBlock kind and falls back for unknown kinds", () => {
    for (const kind of UI_BLOCK_KINDS) expect(RENDERER_KINDS).toContain(kind);
    expect(rendererFor("code")).toBe("code");
    expect(rendererFor("hologram")).toBe("fallback");
    expect(rendererFor("__proto__")).toBe("fallback");
  });
});

describe("i18n", () => {
  it("has the same keys in English and Spanish, with the same placeholders", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(es[key].trim().length, key).toBeGreaterThan(0);
      expect(placeholders(es[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it("formats placeholders and leaves unknown ones visible", () => {
    expect(format("Model changed to {model}", { model: "x" })).toBe("Model changed to x");
    expect(format("{a} and {b}", { a: "1" })).toBe("1 and {b}");
  });
});
