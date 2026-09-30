import type { SessionSummary, WorkspaceInfo } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { ApiClient, ApiRequestError } from "../packages/web/src/net/api.ts";
import {
  applySessionStatus,
  emptySidebar,
  groupSessions,
  loadSidebar,
  upsertSession,
} from "../packages/web/src/store/sessions.ts";
import { relativeTime } from "../packages/web/src/util/time.ts";

const summary = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  workspaceId: "w1",
  workspace: "/ws/one",
  provider: "p",
  model: "m",
  status: "idle",
  pinned: false,
  archived: false,
  ...extra,
});
const workspace = (
  id: string,
  path: string,
  extra: Partial<WorkspaceInfo> = {},
): WorkspaceInfo => ({
  id,
  path,
  pinned: false,
  open: false,
  trusted: true,
  untrustedResources: false,
  ...extra,
});

describe("api client", () => {
  it("sends a request id, JSON on writes, and raises typed errors", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let unauthorized = 0;
    const api = new ApiClient({
      requestId: () => "req-1",
      onUnauthorized: () => unauthorized++,
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith("/busy"))
          return new Response(
            JSON.stringify({
              error: { code: "session_busy", message: "Busy" },
              correlationId: "x",
            }),
            { status: 409 },
          );
        if (url === "/api/workspaces") return new Response("{}", { status: 401 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    await api.request("POST", "/api/x", { a: 1 });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["X-Request-Id"]).toBe("req-1");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.init.body).toBe('{"a":1}');
    const error = await api.request("POST", "/api/busy").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 409, code: "session_busy", message: "Busy" });
    await api.workspaces().catch(() => {});
    expect(unauthorized).toBe(1);
  });

  it("reports network failures with the network code", async () => {
    const api = new ApiClient({
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await expect(api.health()).rejects.toMatchObject({ code: "network", status: 0 });
  });
});

describe("sidebar store", () => {
  it("groups sessions under their workspace folders, pinned first then most recent", () => {
    const state = loadSidebar(
      emptySidebar(),
      [workspace("w1", "/ws/one"), workspace("w2", "/ws/two", { label: "Two" })],
      [
        summary("a", { updatedAt: 10 }),
        summary("b", { updatedAt: 30 }),
        summary("c", { pinned: true, updatedAt: 1 }),
        summary("d", { updatedAt: undefined }),
        summary("e", { workspaceId: "w2", workspace: "/ws/two", updatedAt: 5 }),
      ],
    );
    const groups = groupSessions(state, "");
    expect(groups.map((g) => [g.workspace.id, g.name, g.sessions.map((s) => s.id)])).toEqual([
      ["w1", "one", ["c", "b", "a", "d"]],
      ["w2", "Two", ["e"]],
    ]);
  });

  it("filters by title or id prefix, keeping workspaces with matches or a matching name", () => {
    const state = loadSidebar(
      emptySidebar(),
      [workspace("w1", "/ws/one"), workspace("w2", "/ws/docs")],
      [summary("abc", { title: "Fix the parser" }), summary("xyz", { title: "Greeting" })],
    );
    expect(groupSessions(state, "parser").flatMap((g) => g.sessions.map((s) => s.id))).toEqual([
      "abc",
    ]);
    expect(groupSessions(state, "xy").flatMap((g) => g.sessions.map((s) => s.id))).toEqual(["xyz"]);
    expect(groupSessions(state, "docs").map((g) => g.workspace.id)).toEqual(["w2"]);
  });

  it("applies session_status frames and flags unknown sessions for a reload", () => {
    let state = loadSidebar(emptySidebar(), [workspace("w1", "/ws/one")], [summary("a")]);
    state = applySessionStatus(state, {
      t: "session_status",
      sessionId: "a",
      workspaceId: "w1",
      status: "running",
      title: "Named",
      updatedAt: 99,
    });
    expect(state.sessions.a).toMatchObject({ status: "running", title: "Named", updatedAt: 99 });
    expect(state.stale).toBe(false);
    state = applySessionStatus(state, {
      t: "session_status",
      sessionId: "new",
      workspaceId: "w1",
      status: "idle",
    });
    expect(state.stale).toBe(true);
  });

  it("hides archived sessions unless asked, and upserts patched sessions", () => {
    let state = loadSidebar(emptySidebar(), [workspace("w1", "/ws/one")], [summary("a")]);
    state = upsertSession(state, summary("a", { archived: true }));
    expect(groupSessions(state, "")[0]?.sessions).toEqual([]);
    expect(groupSessions(state, "", true)[0]?.sessions.map((s) => s.id)).toEqual(["a"]);
  });
});

describe("relative time", () => {
  it("formats compact relative times and a dash when unknown", () => {
    const now = 1_000_000_000;
    expect(relativeTime(undefined, now, "en")).toBe("—");
    expect(relativeTime(now - 20_000, now, "en")).toBe("now");
    expect(relativeTime(now - 4 * 60_000, now, "en")).toBe("4 min");
    expect(relativeTime(now - 3 * 3_600_000, now, "en")).toBe("3 h");
    expect(relativeTime(now - 2 * 86_400_000, now, "es")).toBe("2 d");
    expect(relativeTime(now - 20 * 86_400_000, now, "es")).toBe("2 sem");
  });
});
