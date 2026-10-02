/**
 * Web side of `/goal` (Phase 4): the pure helpers, the goal frames, the goal store driven through
 * a fake API (pause, resume, clear and edit carry what this window saw, a conflict reloads, a new
 * objective over a goal asks first, `/goal edit` opens the form), the palette rows, EN/ES strings
 * for every reason and wait, and the lazy loading that keeps the initial bundle inside its budget.
 */
import { readFileSync } from "node:fs";
import type { CommandOutcome, GoalInfo, GoalReason, GoalWaiting, ServerFrame } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  gk,
  goalStrings,
  reasonText,
  statusText,
  waitingText,
} from "../packages/web/src/components/goal/strings.ts";
import { locale } from "../packages/web/src/i18n/index.ts";
import { ApiRequestError } from "../packages/web/src/net/api.ts";
import { api, currentId, goalInfo, toast, transcript } from "../packages/web/src/store/app.ts";
import { paletteRows } from "../packages/web/src/store/composer.ts";
import {
  barActions,
  budgetLevel,
  budgetPercent,
  clearGoal,
  compactTokens,
  editing,
  formatElapsed,
  hasReport,
  pauseGoal,
  reloadGoal,
  resumeGoal,
  runGoalCommand,
  saveGoal,
  working,
} from "../packages/web/src/store/goal.ts";
import { goalFromFrame } from "../packages/web/src/store/goal-frame.ts";

const goal = (over: Partial<GoalInfo> = {}): GoalInfo => ({
  sessionId: "s1",
  goalId: "g1",
  objective: "Ship the thing",
  status: "active",
  reason: "created",
  epoch: 4,
  tokensUsed: 12_300,
  turnsUsed: 3,
  maxTurns: 50,
  activeMs: 252_000,
  maxWallMs: 7_200_000,
  actions: ["pause", "edit", "budget", "clear"],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe("pure helpers", () => {
  it("computes the budget share and its level", () => {
    expect(budgetPercent(goal())).toBeUndefined();
    expect(budgetPercent(goal({ tokenBudget: 50_000 }))).toBe(25);
    expect(budgetPercent(goal({ tokenBudget: 10_000 }))).toBe(100);
    expect([undefined, 10, 79, 80, 99, 100].map(budgetLevel)).toEqual([
      "ok",
      "ok",
      "ok",
      "warn",
      "warn",
      "danger",
    ]);
  });
  it("formats tokens and time like the terminal does", () => {
    expect(compactTokens(812)).toBe("812");
    expect(compactTokens(12_300)).toBe("12.3k");
    expect(compactTokens(1_500_000)).toBe("1.5M");
    expect(formatElapsed(45_000)).toBe("45s");
    expect(formatElapsed(252_000)).toBe("4m 12s");
    expect(formatElapsed(3_900_000)).toBe("1h 05m");
  });
  it("shows the buttons the state allows, never a budget button", () => {
    expect(barActions(goal())).toEqual(["pause", "edit", "clear"]);
    expect(barActions(goal({ actions: ["resume", "edit", "budget", "clear"] }))).toEqual([
      "resume",
      "edit",
      "clear",
    ]);
    expect(barActions(goal({ actions: ["edit", "budget", "clear"] }))).toEqual(["edit", "clear"]);
  });
  it("shows the agent's report for a complete or blocked goal", () => {
    expect(hasReport(goal({ status: "complete", summary: "done" }))).toBe(true);
    expect(hasReport(goal({ status: "blocked", summary: "stuck" }))).toBe(true);
    expect(hasReport(goal({ status: "active", summary: "first report" }))).toBe(false);
    expect(hasReport(goal({ status: "complete" }))).toBe(false);
  });
});

describe("goal frames", () => {
  const snapshot = (sessionId: string, g?: GoalInfo) =>
    ({
      t: "snapshot",
      sessionId,
      cursor: 0,
      pending: { approvals: [], interactions: [] },
      ...(g ? { goal: g } : {}),
    }) as unknown as ServerFrame;
  it("takes the goal from a snapshot (after a reload) and from goal_changed, of the open session only", () => {
    const g = goal();
    expect(goalFromFrame(snapshot("s1", g), "s1")).toBe(g);
    expect(goalFromFrame(snapshot("s1"), "s1")).toBeNull();
    expect(goalFromFrame({ t: "goal_changed", sessionId: "s1", goal: g }, "s1")).toBe(g);
    expect(goalFromFrame({ t: "goal_changed", sessionId: "s1", goal: null }, "s1")).toBeNull();
    expect(goalFromFrame({ t: "goal_changed", sessionId: "other", goal: g }, "s1")).toBeUndefined();
    expect(
      goalFromFrame({ t: "hello", protocolVersion: 1, streamId: "x", serverTime: 1 }, "s1"),
    ).toBeUndefined();
  });
});

describe("the goal store", () => {
  const original = api.request.bind(api);
  let calls: Array<{ method: string; path: string; body?: Record<string, unknown> }>;
  let answer: (call: (typeof calls)[number]) => unknown;
  let confirmed: boolean;

  beforeEach(() => {
    calls = [];
    answer = () => ({ goal: goal() });
    confirmed = true;
    currentId.value = "s1";
    goalInfo.value = goal();
    toast.value = undefined;
    editing.value = false;
    working.value = false;
    transcript.value = {
      ...transcript.value,
      sessionId: "s1",
      items: [],
      echoes: [],
      notes: [],
    } as never;
    vi.stubGlobal("window", { confirm: () => confirmed });
    api.request = (async (method: string, path: string, body?: Record<string, unknown>) => {
      const call = { method, path, ...(body ? { body } : {}) };
      calls.push(call);
      const result = answer(call);
      if (result instanceof Error) throw result;
      return result;
    }) as typeof api.request;
  });
  afterEach(() => {
    api.request = original;
    vi.unstubAllGlobals();
    currentId.value = undefined;
    goalInfo.value = null;
    locale.value = "en";
  });

  it("pause and resume send what this window saw", async () => {
    await pauseGoal(goal());
    await resumeGoal(goal({ status: "paused" }));
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/sessions/s1/goal/pause",
        body: { expect: { goalId: "g1", epoch: 4 } },
      },
      {
        method: "POST",
        path: "/api/sessions/s1/goal/resume",
        body: { expect: { goalId: "g1", epoch: 4 } },
      },
    ]);
    expect(working.value).toBe(false);
  });

  it("a conflict reloads the goal and says it changed, instead of acting on stale data", async () => {
    const newer = goal({ status: "paused", epoch: 7 });
    answer = (call) =>
      call.method === "GET"
        ? { goal: newer }
        : new ApiRequestError(409, "goal_conflict", "The goal changed since you last saw it");
    await pauseGoal(goal());
    expect(goalInfo.value).toEqual(newer);
    expect(toast.value).toContain("changed in another window");
  });

  it("any other failure is a toast", async () => {
    answer = () => new ApiRequestError(500, "internal", "boom");
    await pauseGoal(goal());
    expect(toast.value).toContain("boom");
  });

  it("clear asks first and sends the goal it saw", async () => {
    confirmed = false;
    await clearGoal(goal());
    expect(calls).toEqual([]);
    confirmed = true;
    await clearGoal(goal());
    expect(calls).toEqual([{ method: "DELETE", path: "/api/sessions/s1/goal?goalId=g1&epoch=4" }]);
  });

  it("saves an edited objective with PATCH and a budget through the /goal command", async () => {
    editing.value = true;
    answer = (call) =>
      call.method === "PATCH"
        ? { goal: goal({ objective: "New", epoch: 5 }) }
        : ({ output: "ok" } as CommandOutcome);
    const ok = await saveGoal(goal(), { objective: "New", budget: "50k" });
    expect(ok).toBe(true);
    expect(editing.value).toBe(false);
    expect(calls[0]).toEqual({
      method: "PATCH",
      path: "/api/sessions/s1/goal",
      body: { objective: "New", expect: { goalId: "g1", epoch: 4 } },
    });
    expect(calls[1]?.path).toBe("/api/sessions/s1/commands");
    expect(calls[1]?.body).toMatchObject({ name: "goal", args: "budget=50k" });
  });

  it("an empty budget field clears it, an unchanged form sends nothing", async () => {
    answer = () => ({ output: "ok" });
    await saveGoal(goal({ tokenBudget: 50_000 }), { objective: "Ship the thing", budget: "" });
    expect(calls.map((c) => c.body?.args)).toEqual(["budget=clear"]);
    calls.length = 0;
    await saveGoal(goal(), { objective: "Ship the thing", budget: "" });
    expect(calls).toEqual([]);
  });

  it("keeps the form open when saving fails", async () => {
    editing.value = true;
    answer = () => new ApiRequestError(400, "validation_failed", "bad budget");
    expect(await saveGoal(goal(), { objective: "Ship the thing", budget: "banana" })).toBe(false);
    expect(editing.value).toBe(true);
  });

  it("a typed /goal asks before replacing a goal, then resends with the confirmation", async () => {
    let first = true;
    answer = (call) => {
      if (call.method === "GET") return { goal: goal() };
      if (first) {
        first = false;
        return new ApiRequestError(409, "goal_conflict", "exists", { reason: "exists" });
      }
      return { output: "Goal started.", effects: ["goal"] } satisfies CommandOutcome;
    };
    await runGoalCommand("s1", "A new objective");
    const sent = calls.filter((c) => c.path.endsWith("/commands"));
    expect(sent).toHaveLength(2);
    expect(sent[0]?.body).not.toHaveProperty("confirm");
    expect(sent[1]?.body).toMatchObject({ confirm: true, args: "A new objective" });
    // Declining does not replace anything.
    calls.length = 0;
    first = true;
    confirmed = false;
    await runGoalCommand("s1", "Another one");
    expect(calls.filter((c) => c.path.endsWith("/commands"))).toHaveLength(1);
  });

  it("/goal edit without text opens the form; other answers become a note", async () => {
    answer = () => ({ output: "Ship the thing", effects: ["goal_edit"] }) satisfies CommandOutcome;
    await runGoalCommand("s1", "edit");
    expect(editing.value).toBe(true);
    editing.value = false;
    answer = () => ({ output: "**Goal** · Active" }) satisfies CommandOutcome;
    await runGoalCommand("s1", "");
    expect(JSON.stringify(transcript.value)).toContain("**Goal** · Active");
  });

  it("shows a failed command as a note, with the server's message", async () => {
    answer = () => new ApiRequestError(400, "validation_failed", "Give only one budget=");
    await runGoalCommand("s1", "x budget=1k budget=2k");
    expect(JSON.stringify(transcript.value)).toContain("Give only one budget=");
  });

  it("reloads the goal when asked", async () => {
    goalInfo.value = null;
    answer = () => ({ goal: goal({ epoch: 9 }) });
    await reloadGoal("s1");
    expect((goalInfo.value as GoalInfo | null)?.epoch).toBe(9);
  });
});

describe("the /goal palette", () => {
  const commands = [
    {
      name: "goal",
      description: "Start or manage the current Session Goal",
      source: "builtin",
      surfaces: ["web"],
      execution: "surface",
    },
    {
      name: "tasks",
      description: "tasks",
      source: "builtin",
      surfaces: ["web"],
      execution: "surface",
    },
  ] as never[];
  it("lists the actions of the current goal under /goal", () => {
    const rows = paletteRows(commands, "goal", goal());
    expect(rows.map((r) => r.name)).toEqual(["goal", "goal pause", "goal edit", "goal clear"]);
    const paused = paletteRows(
      commands,
      "goal",
      goal({ actions: ["resume", "edit", "budget", "clear"] }),
    );
    expect(paused.map((r) => r.name)).toEqual(["goal", "goal resume", "goal edit", "goal clear"]);
  });
  it("adds nothing without a goal or for other queries", () => {
    expect(paletteRows(commands, "goal", null).map((r) => r.name)).toEqual(["goal"]);
    expect(paletteRows(commands, "ta", goal()).map((r) => r.name)).toEqual(["tasks"]);
    expect(paletteRows(commands, "g", goal()).map((r) => r.name)).toEqual(["goal"]);
  });
});

describe("EN/ES strings", () => {
  const reasons: GoalReason[] = [
    "created",
    "resumed",
    "edited",
    "user_paused",
    "user_interrupt",
    "model_complete",
    "model_blocked",
    "policy_denied",
    "run_error",
    "token_budget",
    "max_turns",
    "max_wall",
    "no_progress",
    "restart",
  ];
  const waits: GoalWaiting[] = [
    "approval",
    "question",
    "user_input",
    "plan_mode",
    "background_tasks",
  ];
  afterEach(() => {
    locale.value = "en";
  });
  it("keeps the same keys in both languages and translates every one", () => {
    const keys = Object.keys(goalStrings.en) as Array<keyof typeof goalStrings.en>;
    expect(Object.keys(goalStrings.es).sort()).toEqual([...keys].sort());
    const same = new Set(["detail.repeated_reply"].filter(() => false));
    for (const key of keys) {
      expect(goalStrings.en[key], `en ${key}`).toBeTruthy();
      expect(goalStrings.es[key], `es ${key}`).toBeTruthy();
      if (!same.has(key))
        expect(goalStrings.es[key], `es differs ${key}`).not.toBe(goalStrings.en[key]);
    }
  });
  it("covers every state, reason and wait the server can send", () => {
    for (const status of ["active", "paused", "blocked", "budget_limited", "complete"] as const)
      expect(statusText(status)).toBeTruthy();
    for (const reason of reasons) expect(reasonText(reason, undefined)).not.toContain("reason.");
    for (const wait of waits) expect(waitingText(wait)).not.toContain("waiting.");
    locale.value = "es";
    expect(statusText("paused")).toBe("En pausa");
    expect(reasonText("no_progress", "repeated_reply")).toBe(
      "Sin avance: se repitió la misma respuesta",
    );
    expect(gk("budgetLabel", { used: "1k", budget: "5k" })).toBe("1k de 5k tokens");
  });
  it("shows an unknown detail (an error text) as it is", () => {
    expect(reasonText("run_error", "401 Unauthorized")).toBe("A turn failed: 401 Unauthorized");
  });
});

describe("lazy loading and the setting labels", () => {
  it("keeps the bar, its store and its strings out of the initial bundle", () => {
    const app = readFileSync("packages/web/src/app.tsx", "utf8");
    expect(app).not.toMatch(/^import .*GoalBar/m);
    expect(app).toMatch(/import\("\.\/components\/goal\/GoalBar\.tsx"\)/);
    const store = readFileSync("packages/web/src/store/app.ts", "utf8");
    expect(store).not.toMatch(/^import .*from "\.\/goal\.ts"/m);
    expect(store).toMatch(/import\("\.\/goal\.ts"\)/);
    for (const file of [
      "packages/web/src/store/app.ts",
      "packages/web/src/app.tsx",
      "packages/web/src/components/composer/Composer.tsx",
      "packages/web/src/store/composer.ts",
      "packages/web/src/store/goal-frame.ts",
    ])
      expect(readFileSync(file, "utf8"), file).not.toMatch(/components\/goal\/strings/);
  });
});
