/** Web `/btw` side panel: composer interception, history navigation and the API client calls. */
import type { CommandDescriptor, SideQuestionEntry } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { en } from "../packages/web/src/i18n/en.ts";
import { es } from "../packages/web/src/i18n/es.ts";
import { ApiClient } from "../packages/web/src/net/api.ts";
import {
  answeredSideQuestion,
  BTW_USAGE,
  browseSideQuestions,
  currentSideQuestion,
  failedSideQuestion,
  pendingSideQuestion,
  sideQuestionMoves,
  sideQuestionOf,
  stepSideQuestion,
} from "../packages/web/src/store/btw.ts";

const command = (name: string, extra: Partial<CommandDescriptor> = {}): CommandDescriptor => ({
  name,
  description: name,
  source: "builtin",
  surfaces: ["tui", "web", "api"],
  execution: "core",
  ...extra,
});
const entry = (n: number): SideQuestionEntry => ({
  id: `q${n}`,
  question: `question ${n}`,
  answer: `answer ${n}`,
  model: "m",
  usage: { input: n, output: n },
  createdAt: n,
});

describe("web /btw interception", () => {
  const catalog = [command("btw", { argumentHint: "[question]" }), command("compact")];

  it("intercepts /btw with or without a question and leaves everything else alone", () => {
    expect(sideQuestionOf("/btw what changed?", catalog)).toEqual({ question: "what changed?" });
    expect(sideQuestionOf("  /BTW  multi\nline ", catalog)).toEqual({ question: "multi\nline" });
    expect(sideQuestionOf("/btw", catalog)).toEqual({ question: "" });
    expect(sideQuestionOf("/btw ", catalog)).toEqual({ question: "" });
    expect(sideQuestionOf("/compact", catalog)).toBeUndefined();
    expect(sideQuestionOf("btw what", catalog)).toBeUndefined();
    expect(sideQuestionOf("/btwx hi", catalog)).toBeUndefined();
  });

  it("only intercepts the built-in command", () => {
    const pluginOnly = [command("btw", { source: "plugin", owner: "rogue" })];
    expect(sideQuestionOf("/btw hi", pluginOnly)).toBeUndefined();
    expect(sideQuestionOf("/btw hi", [])).toBeUndefined();
  });
});

describe("web /btw panel model", () => {
  it("shows the usage line without history, else the newest entry", () => {
    const empty = browseSideQuestions("s", []);
    expect(empty.usage).toBe(true);
    expect(currentSideQuestion(empty)).toBeUndefined();
    expect(BTW_USAGE).toBe("Usage: /btw <question>");
    const state = browseSideQuestions("s", [entry(1), entry(2), entry(3)]);
    expect(currentSideQuestion(state)?.id).toBe("q3");
    expect(sideQuestionMoves(state)).toEqual({ earlier: true, later: false });
  });

  it("browses earlier and later answers with clamping", () => {
    let state = browseSideQuestions("s", [entry(1), entry(2), entry(3)]);
    state = stepSideQuestion(stepSideQuestion(state, -1), -1);
    expect(state.index).toBe(0);
    expect(stepSideQuestion(state, -1)).toBe(state);
    expect(sideQuestionMoves(state)).toEqual({ earlier: false, later: true });
    expect(stepSideQuestion(state, 1).index).toBe(1);
  });

  it("goes from pending to the answer or to an error that still allows browsing", () => {
    const pending = pendingSideQuestion("s", [entry(1)], "new?", 0);
    expect(currentSideQuestion(pending)).toBeUndefined();
    expect(stepSideQuestion(pending, -1)).toBe(pending);
    expect(sideQuestionMoves(pending)).toEqual({ earlier: false, later: false });
    const answered = answeredSideQuestion(pending, [entry(1), entry(2)]);
    expect(currentSideQuestion(answered)?.id).toBe("q2");
    expect(answered.pending).toBeUndefined();
    const failed = failedSideQuestion(pending, "Provider down");
    expect(failed.error).toEqual({ question: "new?", message: "Provider down" });
    expect(failed.pending).toBeUndefined();
    expect(currentSideQuestion(stepSideQuestion(failed, -1))?.id).toBe("q1");
  });

  it("has every panel string in English and Spanish", () => {
    const keys = Object.keys(en).filter((k) => k.startsWith("btw."));
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) expect(es[key as keyof typeof es], key).toBeTruthy();
  });
});

describe("web /btw API client", () => {
  it("asks, lists and cancels side questions with an abortable request", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const api = new ApiClient({
      requestId: () => "r",
      fetch: async (url, init) => {
        calls.push({ url, init });
        const body = url.endsWith("/cancel") ? { cancelled: true } : url.endsWith("/btw") ? [] : {};
        return new Response(
          JSON.stringify(init.method === "POST" && !url.endsWith("/cancel") ? entry(1) : body),
          {
            status: 200,
          },
        );
      },
    });
    const controller = new AbortController();
    expect(await api.askSideQuestion("s 1", "why?", controller.signal)).toEqual(entry(1));
    expect(await api.sideQuestions("s 1")).toEqual([]);
    expect(await api.cancelSideQuestions("s 1")).toEqual({ cancelled: true });
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "POST /api/sessions/s%201/btw",
      "GET /api/sessions/s%201/btw",
      "POST /api/sessions/s%201/btw/cancel",
    ]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ question: "why?" });
    expect(calls[0]?.init.signal).toBe(controller.signal);
  });
});
