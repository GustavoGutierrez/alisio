import type { PendingApproval, PluginAppInfo } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createAppBridge, type PortLike } from "../packages/web/src/components/apps/bridge.ts";
import { ApiRequestError } from "../packages/web/src/net/api.ts";
import {
  appPending,
  currentId,
  detail,
  openSession,
  pending,
  sidebar,
  visible,
} from "../packages/web/src/store/app.ts";
import { appApprovals, mergeApprovals } from "../packages/web/src/store/pending.ts";
import {
  activeAppKey,
  appCatalog,
  appInstances,
  closeApp,
  openApp,
} from "../packages/web/src/store/plugin-apps.ts";
import {
  appLabel,
  appMenuItems,
  appsOf,
  instanceKey,
  pickAppSession,
} from "../packages/web/src/store/plugin-apps-model.ts";
import { emptySidebar } from "../packages/web/src/store/sessions.ts";

const info = (id: string, label: Record<string, string> = { en: id }): PluginAppInfo => ({
  plugin: "p",
  id,
  label,
});

describe("plugin apps model", () => {
  it("resolves labels by locale, base language, English, then id", () => {
    const app = info("x", { en: "Writing", es: "Redacción" });
    expect(appLabel(app, "es")).toBe("Redacción");
    expect(appLabel(app, "es-CO")).toBe("Redacción");
    expect(appLabel(app, "fr")).toBe("Writing");
    expect(appLabel({ ...app, label: {} }, "fr")).toBe("x");
  });

  it("only exposes a catalog for the workspace it was loaded for", () => {
    const state = { workspace: "w1", apps: [info("a")] };
    expect(appsOf(state, "w1")).toHaveLength(1);
    expect(appsOf(state, "w2")).toEqual([]);
    expect(appsOf(undefined, "w1")).toEqual([]);
  });

  it("picks the open session of the project, else its most recent root session", () => {
    const state = {
      ...emptySidebar(),
      sessions: {
        a: { id: "a", workspaceId: "w1", updatedAt: 1 },
        b: { id: "b", workspaceId: "w1", updatedAt: 9 },
        c: { id: "c", workspaceId: "w1", updatedAt: 99, archived: true },
        d: { id: "d", workspaceId: "w2", updatedAt: 50 },
      },
    } as never;
    expect(pickAppSession(state, "w1", { id: "a", workspaceId: "w1" })).toBe("a");
    expect(pickAppSession(state, "w1", { id: "d", workspaceId: "w2" })).toBe("b");
    expect(pickAppSession(state, "w3")).toBeUndefined();
  });
});

describe("Apps group of the sidebar", () => {
  it("is empty (the whole group is not rendered) without apps for the workspace", () => {
    expect(appMenuItems(undefined, "w1", undefined, "en")).toEqual([]);
    expect(appMenuItems({ workspace: "w1", apps: [] }, "w1", undefined, "en")).toEqual([]);
    // Apps of another project do not leak into this one.
    expect(appMenuItems({ workspace: "w2", apps: [info("a")] }, "w1", undefined, "en")).toEqual([]);
    expect(
      appMenuItems({ workspace: "w1", apps: [info("a")] }, undefined, undefined, "en"),
    ).toEqual([]);
  });

  it("lists the apps of the current workspace, localized, marking the open one", () => {
    const state = { workspace: "w1", apps: [info("a", { en: "Alpha", es: "Alfa" }), info("b")] };
    const items = appMenuItems(state, "w1", instanceKey("w1", "p", "b"), "es");
    expect(items.map((i) => [i.label, i.active])).toEqual([
      ["Alfa", false],
      ["b", true],
    ]);
  });
});

describe("opening apps", () => {
  afterEach(() => {
    appInstances.value = [];
    activeAppKey.value = undefined;
    currentId.value = undefined;
    detail.value = undefined;
    sidebar.value = emptySidebar();
  });
  it("keeps one instance per project, returns to chat and leaves the app on openSession", async () => {
    detail.value = { id: "chat-1", workspaceId: "w1" } as never;
    currentId.value = "chat-1";
    await openApp("p", "editor");
    const key = instanceKey("w1", "p", "editor");
    expect(activeAppKey.value).toBe(key);
    expect(appInstances.value[0]?.sessionId).toBe("chat-1");
    const first = appInstances.value[0];
    closeApp();
    expect(activeAppKey.value).toBeUndefined();
    expect(appInstances.value).toHaveLength(1);
    await openApp("p", "editor");
    expect(appInstances.value[0]).toBe(first);
    await openSession("chat-1");
    expect(activeAppKey.value).toBeUndefined();
    // Another project is another instance with its own session.
    detail.value = { id: "chat-2", workspaceId: "w2" } as never;
    await openApp("p", "editor");
    expect(appInstances.value.map((i) => i.workspace)).toEqual(["w1", "w2"]);
    expect(appInstances.value[1]?.sessionId).toBe("chat-2");
  });
});

function fakePort() {
  const sent: unknown[] = [];
  const port: PortLike & { closed: boolean; receive(data: unknown): void } = {
    closed: false,
    onmessage: null,
    postMessage: (m) => void sent.push(m),
    close() {
      port.closed = true;
    },
    receive: (data) => port.onmessage?.({ data }),
  };
  return { port, sent };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const approval = (
  id: string,
  root: string,
  extra: Partial<PendingApproval> = {},
): PendingApproval => ({
  approvalId: id,
  sessionId: root,
  rootSessionId: root,
  kind: "effect",
  effect: "write",
  input: "",
  ...extra,
});

describe("approvals while an app is open", () => {
  afterEach(() => {
    appInstances.value = [];
    activeAppKey.value = undefined;
    currentId.value = undefined;
    detail.value = undefined;
    pending.value = { approvals: [], interactions: [] };
    sidebar.value = emptySidebar();
  });

  it("selects the approvals of the app's session tree, merged with the chat's without duplicates", () => {
    const state = {
      approvals: [approval("a", "app-s"), approval("b", "chat-s"), approval("c", "other")],
      interactions: [],
    };
    expect(appApprovals(state, "app-s").map((a) => a.approvalId)).toEqual(["a"]);
    expect(appApprovals(state, undefined)).toEqual([]);
    expect(
      mergeApprovals(
        [approval("b", "chat-s")],
        [approval("b", "chat-s"), approval("a", "app-s")],
      ).map((a) => a.approvalId),
    ).toEqual(["b", "a"]);
  });

  it("exposes the approval of the open app even when the open chat is another session", async () => {
    detail.value = { id: "chat-1", workspaceId: "w1" } as never;
    currentId.value = "chat-1";
    await openApp("p", "editor");
    // The app's session leaves the chat: reopening the same app keeps its session.
    pending.value = {
      approvals: [
        approval("x", "chat-1", {
          app: {
            plugin: "p",
            pluginName: "P",
            app: "editor",
            label: { en: "Editor" },
            action: "save",
          },
        }),
      ],
      interactions: [],
    };
    expect(appPending.value.map((a) => a.approvalId)).toEqual(["x"]);
    expect(appPending.value[0]?.app?.action).toBe("save");
    closeApp();
    expect(appPending.value).toEqual([]);
    void visible.value;
  });
});

describe("app frame port protocol", () => {
  it("tells the frame which effect a not_permitted answer needs, and nothing else", async () => {
    const { port, sent } = fakePort();
    createAppBridge({
      port,
      run: async (action) => {
        if (action === "save")
          throw new ApiRequestError(403, "app_action_denied", "no", {
            effect: "write",
            extra: "x",
          });
        throw new ApiRequestError(403, "app_action_denied", "no");
      },
    });
    port.receive({ type: "request", id: "1", action: "save" });
    port.receive({ type: "request", id: "2", action: "plain" });
    await settle();
    expect(sent).toContainEqual({
      type: "response",
      id: "1",
      error: "not_permitted",
      effect: "write",
    });
    expect(sent).toContainEqual({ type: "response", id: "2", error: "not_permitted" });
  });

  it("answers requests with results and maps failures to codes without inputs", async () => {
    const { port, sent } = fakePort();
    createAppBridge({
      port,
      run: async (action, input) => {
        if (action === "boom") throw new ApiRequestError(400, "validation_failed", "bad secret-x");
        return { action, input };
      },
    });
    port.receive({ type: "request", id: "1", action: "docs.list", input: { a: 1 } });
    port.receive({ type: "request", id: "2", action: "boom", input: { token: "secret-x" } });
    port.receive({ type: "request", id: "3", action: "bad action" });
    port.receive({ type: "other" });
    await settle();
    expect(sent).toContainEqual({
      type: "response",
      id: "1",
      result: { action: "docs.list", input: { a: 1 } },
    });
    expect(sent).toContainEqual({ type: "response", id: "2", error: "invalid_input" });
    expect(sent).toContainEqual({ type: "response", id: "3", error: "invalid_input" });
    expect(JSON.stringify(sent)).not.toContain("secret-x");
  });

  it("limits in-flight requests to 8 and aborts them on close", async () => {
    const { port, sent } = fakePort();
    const signals: AbortSignal[] = [];
    const bridge = createAppBridge({
      port,
      run: (_a, _i, o) => {
        signals.push(o.signal);
        return new Promise(() => {});
      },
    });
    for (let i = 0; i < 9; i++) port.receive({ type: "request", id: `r${i}`, action: "x" });
    await settle();
    expect(signals).toHaveLength(8);
    expect(sent).toEqual([{ type: "response", id: "r8", error: "too_many_requests" }]);
    bridge.close();
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(port.closed).toBe(true);
  });

  it("forwards locale and visibility, and reports not_found", async () => {
    const { port, sent } = fakePort();
    let gone = 0;
    const bridge = createAppBridge({
      port,
      onNotFound: () => gone++,
      run: async () => {
        throw new ApiRequestError(404, "not_found", "App not found");
      },
    });
    bridge.setLocale("en");
    bridge.setVisible(false);
    port.receive({ type: "request", id: "n", action: "x" });
    await settle();
    expect(sent).toEqual([
      { type: "locale", locale: "en" },
      { type: "visibility", visible: false },
      { type: "response", id: "n", error: "not_found" },
    ]);
    expect(gone).toBe(1);
  });
});
