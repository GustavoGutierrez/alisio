import type { SessionSummary, WorkspaceInfo } from "@alisio/sdk";
import { describe, expect, it, vi } from "vitest";
import { setLocale } from "../packages/web/src/i18n/index.ts";
import { ApiClient, ApiRequestError } from "../packages/web/src/net/api.ts";
import { errorText } from "../packages/web/src/store/errors.ts";
import {
  applySessionStatus,
  emptySidebar,
  groupSessions,
  loadSidebar,
  newSessionTarget,
  upsertSession,
  upsertWorkspace,
  workspaceHints,
  workspaceOpenMode,
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
  exists: true,
  trusted: true,
  untrustedResources: false,
  archived: false,
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
        if (url.startsWith("/api/workspaces?")) return new Response("{}", { status: 401 });
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
    expect(calls.at(-1)?.url).toBe("/api/workspaces?archived=false");
    await api.patchWorkspace("w/1", { archived: true });
    expect(calls.at(-1)).toMatchObject({
      url: "/api/workspaces/w%2F1",
      init: { method: "PATCH", body: '{"archived":true}' },
    });
    await api.pickFolder();
    expect(calls.at(-1)).toMatchObject({ url: "/api/workspaces/pick", init: { body: "{}" } });
    await api.listDirs("C:\\Users", true);
    expect(calls.at(-1)?.url).toBe("/api/fs/dirs?path=C%3A%5CUsers&hidden=true");
  });

  it("explains a deleted workspace folder with its path instead of a raw error", async () => {
    const api = new ApiClient({
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "workspace_missing",
              message: "Workspace folder not found: /gone/app",
              details: { path: "/gone/app" },
            },
            correlationId: "x",
          }),
          { status: 404 },
        ),
    });
    const error = await api.createSession({ workspace: "w1" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "workspace_missing", details: { path: "/gone/app" } });
    vi.stubGlobal("document", { documentElement: {} });
    try {
      setLocale("en");
      expect(errorText(error)).toBe(
        "The folder /gone/app no longer exists. Its sessions stay readable, but new sessions need an existing folder.",
      );
      setLocale("es");
      expect(errorText(error)).toContain("/gone/app");
      expect(errorText(new Error("boom"))).toBe("boom");
    } finally {
      setLocale("en");
      vi.unstubAllGlobals();
    }
  });

  it("explains archived workspaces and a busy folder dialog", () => {
    vi.stubGlobal("document", { documentElement: {} });
    try {
      setLocale("en");
      const archived = new ApiRequestError(409, "workspace_archived", "raw", { path: "/w/app" });
      expect(errorText(archived)).toBe(
        "The workspace /w/app is archived. Unarchive it to start new sessions.",
      );
      expect(errorText(new ApiRequestError(409, "picker_busy", "raw"))).toContain("dialog");
      setLocale("es");
      expect(errorText(archived)).toContain("archivado");
    } finally {
      setLocale("en");
      vi.unstubAllGlobals();
    }
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

  it("tells apart workspaces that share a folder name with a short parent-path hint", () => {
    const gone = workspace("w1", "/home/me/Descargas/alisio-0.1.0-alpha.1/alisio");
    const here = workspace("w2", "/home/me/Documentos/Proyectos/Personal/alisio");
    const other = workspace("w3", "/home/me/other");
    const hints = workspaceHints([gone, here, other]);
    expect(hints.get("w1")).toBe("Descargas/alisio-0.1.0-alpha.1");
    expect(hints.get("w2")).toBe("Proyectos/Personal");
    expect(hints.has("w3")).toBe(false);
    const state = loadSidebar(emptySidebar(), [gone, here, other], []);
    expect(groupSessions(state, "").map((g) => [g.name, g.hint])).toEqual([
      ["alisio", "Descargas/alisio-0.1.0-alpha.1"],
      ["alisio", "Proyectos/Personal"],
      ["other", undefined],
    ]);
  });

  it("grows the hint until same-named folders with a common parent differ", () => {
    const hints = workspaceHints([
      workspace("a", "/x/one/common/deep/app"),
      workspace("b", "/y/one/common/deep/app"),
      workspace("c", "/app"),
    ]);
    expect([hints.get("a"), hints.get("b"), hints.get("c")]).toEqual([
      "x/one/common/deep",
      "y/one/common/deep",
      "/",
    ]);
  });

  it("does not hint labelled workspaces, whose names are already chosen", () => {
    const hints = workspaceHints([
      workspace("a", "/x/app", { label: "Main" }),
      workspace("b", "/y/app"),
    ]);
    expect(hints.size).toBe(0);
  });

  it("starts new sessions in an existing workspace, never a missing one", () => {
    const state = loadSidebar(
      emptySidebar(),
      [
        workspace("gone", "/a/gone", { exists: false, lastOpenedAt: 900 }),
        workspace("old", "/b/old", { lastOpenedAt: 100 }),
        workspace("recent", "/c/recent", { lastOpenedAt: 500 }),
      ],
      [],
    );
    expect(newSessionTarget(state, "old")).toBe("old");
    expect(newSessionTarget(state, "gone")).toBe("recent");
    expect(newSessionTarget(state)).toBe("recent");
    const onlyMissing = loadSidebar(
      emptySidebar(),
      [workspace("gone", "/a/gone", { exists: false })],
      [],
    );
    expect(newSessionTarget(onlyMissing)).toBeUndefined();
  });

  it("falls back to the workspace with the latest session when none was opened yet", () => {
    const state = loadSidebar(
      emptySidebar(),
      [workspace("w1", "/ws/one"), workspace("w2", "/ws/two")],
      [summary("a", { updatedAt: 10 }), summary("b", { workspaceId: "w2", updatedAt: 20 })],
    );
    expect(newSessionTarget(state)).toBe("w2");
  });
});

describe("archived workspaces in the sidebar", () => {
  const state = () =>
    loadSidebar(
      emptySidebar(),
      [
        workspace("w1", "/ws/one"),
        workspace("old", "/ws/archived", { archived: true, lastOpenedAt: 999 }),
      ],
      [
        summary("a", { updatedAt: 1 }),
        summary("b", { workspaceId: "old", workspace: "/ws/archived", updatedAt: 50 }),
      ],
    );

  it("hides archived workspaces and their sessions unless archived items are shown", () => {
    expect(groupSessions(state(), "").map((g) => g.workspace.id)).toEqual(["w1"]);
    const shown = groupSessions(state(), "", true);
    // Archived workspaces go last, with their sessions.
    expect(shown.map((g) => [g.workspace.id, g.sessions.map((s) => s.id)])).toEqual([
      ["w1", ["a"]],
      ["old", ["b"]],
    ]);
  });

  it("disambiguates names only among the workspaces on screen", () => {
    const twins = loadSidebar(
      emptySidebar(),
      [
        workspace("gone", "/a/Descargas/app", { archived: true }),
        workspace("here", "/b/Proyectos/app"),
      ],
      [],
    );
    expect(groupSessions(twins, "").map((g) => [g.name, g.hint])).toEqual([["app", undefined]]);
    expect(groupSessions(twins, "", true).map((g) => g.hint)).toEqual([
      "b/Proyectos",
      "a/Descargas",
    ]);
  });

  it("never starts a new session in an archived workspace", () => {
    expect(newSessionTarget(state(), "old")).toBe("w1");
    expect(newSessionTarget(state())).toBe("w1");
  });

  it("replaces a workspace in place after archiving or unarchiving it", () => {
    const next = upsertWorkspace(state(), workspace("old", "/ws/archived", { archived: false }));
    expect(groupSessions(next, "").map((g) => g.workspace.id)).toEqual(["old", "w1"]);
  });
});

describe("open-a-workspace mode", () => {
  it("prefers the native dialog, then the in-app browser, then a typed path", () => {
    const caps = (extra: Record<string, boolean>) => ({ nativePicker: false, ...extra });
    expect(workspaceOpenMode(caps({ nativePicker: true, folderBrowser: true }))).toBe("native");
    expect(workspaceOpenMode(caps({ folderBrowser: true }))).toBe("browser");
    expect(workspaceOpenMode(caps({ folderBrowser: false }))).toBe("manual");
    // An older server (no capability flags) or an unknown health: type a path.
    expect(workspaceOpenMode(undefined)).toBe("manual");
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
