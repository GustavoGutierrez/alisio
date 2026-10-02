/**
 * Web side of the Memory tab: the reusable "is plugin X enabled" selector, the tab's visibility and
 * its fallback to Conversation, and the memory controller (pagination, filters, stale-response
 * discard when the chat changes, per-section errors). The data comes from the plugin's views.
 */
import type { PluginInfo, SessionDetail } from "@alisio/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryStrings, tm } from "../packages/web/src/components/memory/strings.ts";
import { en } from "../packages/web/src/i18n/en.ts";
import { es } from "../packages/web/src/i18n/es.ts";
import { locale } from "../packages/web/src/i18n/index.ts";
import {
  activeTab,
  detail,
  failPlugins,
  isPluginEnabled,
  pluginsState,
  receivePlugins,
  sessionTab,
} from "../packages/web/src/store/app.ts";
import {
  createMemoryController,
  type MemoryEntry,
  type MemoryFetch,
  memoryViewUrl,
} from "../packages/web/src/store/memory.ts";
import {
  effectiveTab,
  emptyPlugins,
  type PluginsState,
  pluginAvailability,
  pluginsFailed,
  visibleTabs,
} from "../packages/web/src/store/plugins.ts";

const plugin = (id: string, extra: Partial<PluginInfo> = {}): PluginInfo => ({
  id,
  name: id,
  description: "",
  categories: [],
  builtin: true,
  source: "built-in",
  status: "active",
  enabled: true,
  manageable: true,
  tools: [],
  commands: [],
  toolPrefix: "p_0000000000",
  ...extra,
});

describe("is plugin X enabled (selector)", () => {
  const ready = {
    workspace: "w1",
    list: [
      plugin("memory"),
      plugin("off", { enabled: false, status: "inactive" }),
      plugin("justDisabled", { enabled: false, status: "restart-required" }),
      plugin("justEnabled", { enabled: true, status: "restart-required" }),
      plugin("broken", { enabled: true, status: "failed" }),
    ],
  } satisfies PluginsState;

  it("is enabled only for an enabled plugin that is active", () => {
    expect(pluginAvailability(ready, "w1", "memory")).toBe("enabled");
    expect(pluginAvailability(ready, "w1", "off")).toBe("disabled");
    // Disabled in the config but still running until the workspace restarts: the user's choice wins.
    expect(pluginAvailability(ready, "w1", "justDisabled")).toBe("disabled");
    // Enabled but not loaded yet: its views would 404, so it is not available.
    expect(pluginAvailability(ready, "w1", "justEnabled")).toBe("disabled");
    expect(pluginAvailability(ready, "w1", "broken")).toBe("disabled");
    expect(pluginAvailability(ready, "w1", "not-installed")).toBe("disabled");
  });

  it("is loading before the first answer and for another workspace's list", () => {
    expect(pluginAvailability(emptyPlugins, "w1", "memory")).toBe("loading");
    expect(pluginAvailability(ready, "w2", "memory")).toBe("loading");
    expect(pluginAvailability(ready, undefined, "memory")).toBe("loading");
  });

  it("is error when the first load failed, and keeps the last list when a refresh fails", () => {
    const failed = pluginsFailed(emptyPlugins, "w1");
    expect(pluginAvailability(failed, "w1", "memory")).toBe("error");
    expect(pluginAvailability(pluginsFailed(ready, "w1"), "w1", "memory")).toBe("enabled");
    // A failure for a different workspace never reuses the previous workspace's list.
    expect(pluginAvailability(pluginsFailed(ready, "w2"), "w2", "memory")).toBe("error");
  });
});

describe("tab visibility and fallback", () => {
  it("shows Memory only when the plugin is enabled", () => {
    expect(visibleTabs("enabled")).toEqual(["conversation", "trajectory", "memory"]);
    for (const status of ["disabled", "loading", "error"] as const)
      expect(visibleTabs(status)).toEqual(["conversation", "trajectory"]);
  });

  it("never renders the Memory tab unless it is available", () => {
    expect(effectiveTab("memory", "enabled")).toBe("memory");
    for (const status of ["disabled", "loading", "error"] as const)
      expect(effectiveTab("memory", status)).toBe("conversation");
    expect(effectiveTab("trajectory", "disabled")).toBe("trajectory");
  });
});

describe("app wiring of the plugin list", () => {
  beforeEach(() => {
    detail.value = { id: "s1", workspaceId: "w1" } as SessionDetail;
    pluginsState.value = emptyPlugins;
    sessionTab.value = "conversation";
  });

  it("derives the selector and the active tab from the plugin list of the open workspace", () => {
    expect(isPluginEnabled("memory")).toBe(false);
    receivePlugins("w1", [plugin("memory")]);
    expect(isPluginEnabled("memory")).toBe(true);
    sessionTab.value = "memory";
    expect(activeTab()).toBe("memory");
  });

  it("falls back to Conversation when the plugin gets disabled while the tab is active", () => {
    receivePlugins("w1", [plugin("memory")]);
    sessionTab.value = "memory";
    receivePlugins("w1", [plugin("memory", { enabled: false, status: "inactive" })]);
    expect(sessionTab.value).toBe("conversation");
    expect(isPluginEnabled("memory")).toBe(false);
  });

  it("keeps the tab through a failed refresh and ignores lists of another workspace", () => {
    receivePlugins("w1", [plugin("memory")]);
    sessionTab.value = "memory";
    failPlugins("w1");
    expect(sessionTab.value).toBe("memory");
    expect(isPluginEnabled("memory")).toBe(true);
    receivePlugins("w2", [plugin("memory", { enabled: false, status: "inactive" })]);
    expect(isPluginEnabled("memory")).toBe(false); // w2 is not the open workspace: loading
    expect(sessionTab.value).toBe("memory");
  });
});

// ---------------------------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------------------------

const entry = (id: number, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id,
  type: "decision",
  title: `entry ${id}`,
  content: `content ${id}`,
  contentTruncated: false,
  scope: "project",
  pinned: false,
  createdAt: id,
  updatedAt: id,
  revisionCount: 1,
  duplicateCount: 1,
  ...extra,
});
interface Call {
  sessionId: string;
  view: string;
  params: Record<string, string | number | undefined>;
  signal: AbortSignal;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}
/** A fetch whose answers the test controls; it records every call and honors abort. */
function harness() {
  const calls: Call[] = [];
  const fetchView: MemoryFetch = (sessionId, view, params, signal) =>
    new Promise((resolve, reject) => {
      const call: Call = { sessionId, view, params, signal, resolve, reject };
      calls.push(call);
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  const controller = createMemoryController(fetchView, { pageSize: 2 });
  const of = (view: string) => calls.filter((c) => c.view === view);
  return { controller, calls, of };
}
const page = (ids: number[], total: number, next?: string) => ({
  items: ids.map((id) => entry(id)),
  total,
  ...(next ? { next } : {}),
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("memory controller", () => {
  it("loads the three sections of the chat in parallel", async () => {
    const { controller, calls, of } = harness();
    controller.open("A");
    expect(calls.map((c) => c.view).sort()).toEqual(["context", "records", "summary"]);
    expect(of("records")[0]?.params).toEqual({ limit: 2 });
    expect(controller.state.value.records.status).toBe("loading");
    of("records")[0]?.resolve(page([3, 2], 3, "c1"));
    of("summary")[0]?.resolve({ summary: { content: "S", updatedAt: 5, truncated: false } });
    of("context")[0]?.resolve({ context: null });
    await flush();
    const state = controller.state.value;
    expect(state.records).toMatchObject({ status: "ready", total: 3, next: "c1" });
    expect(state.records.items.map((i) => i.id)).toEqual([3, 2]);
    expect(state.summary).toMatchObject({ status: "ready", value: { content: "S" } });
    expect(state.context).toMatchObject({ status: "ready", value: null });
  });

  it("paginates by cursor and never repeats an entry already shown", async () => {
    const { controller, of } = harness();
    controller.open("A");
    of("records")[0]?.resolve(page([5, 4], 5, "c1"));
    await flush();
    controller.loadMore();
    expect(of("records")[1]?.params).toEqual({ limit: 2, cursor: "c1" });
    expect(controller.state.value.records.loadingMore).toBe(true);
    // An entry that moved while browsing (id 4) comes again: it is not duplicated.
    of("records")[1]?.resolve(page([4, 3], 5, "c2"));
    await flush();
    expect(controller.state.value.records.items.map((i) => i.id)).toEqual([5, 4, 3]);
    expect(controller.state.value.records).toMatchObject({ loadingMore: false, next: "c2" });
    controller.loadMore();
    of("records")[2]?.resolve(page([2, 1], 5));
    await flush();
    expect(controller.state.value.records.items.map((i) => i.id)).toEqual([5, 4, 3, 2, 1]);
    expect(controller.state.value.records.next).toBeUndefined();
    // No cursor left: loading more does nothing.
    controller.loadMore();
    expect(of("records")).toHaveLength(3);
  });

  it("ignores a second loadMore while one is running", async () => {
    const { controller, of } = harness();
    controller.open("A");
    of("records")[0]?.resolve(page([3, 2], 3, "c1"));
    await flush();
    controller.loadMore();
    controller.loadMore();
    expect(of("records")).toHaveLength(2);
  });

  it("restarts the list with the filters (type and text) from the first page", async () => {
    const { controller, of } = harness();
    controller.open("A");
    of("records")[0]?.resolve(page([3, 2], 3, "c1"));
    await flush();
    controller.setType("bugfix");
    expect(of("records")[1]?.params).toEqual({ limit: 2, type: "bugfix" });
    expect(controller.state.value.records.items).toEqual([]);
    of("records")[1]?.resolve(page([9], 1));
    await flush();
    controller.setQuery("  cache ");
    expect(of("records")[2]?.params).toEqual({ limit: 2, type: "bugfix", q: "cache" });
    controller.setType("");
    expect(of("records")[3]?.params).toEqual({ limit: 2, q: "cache" });
  });

  it("discards the answer of a chat that is no longer open (stale responses)", async () => {
    const { controller, of } = harness();
    controller.open("A");
    const [staleRecords] = of("records");
    controller.open("B");
    expect(controller.state.value.sessionId).toBe("B");
    expect(controller.state.value.records.items).toEqual([]);
    // A's request was aborted and, even if its answer still arrives, it never shows up.
    expect(staleRecords?.signal.aborted).toBe(true);
    staleRecords?.resolve(page([1], 1));
    of("summary")[0]?.resolve({
      summary: { content: "A summary", updatedAt: 1, truncated: false },
    });
    await flush();
    expect(controller.state.value.records.status).toBe("loading");
    expect(controller.state.value.summary.status).toBe("loading");
    of("records")[1]?.resolve(page([7], 1));
    of("summary")[1]?.resolve({ summary: null });
    await flush();
    expect(controller.state.value.records.items.map((i) => i.id)).toEqual([7]);
    expect(controller.state.value.summary).toMatchObject({ status: "ready", value: null });
  });

  it("discards an older answer of the same chat after a newer request (filter, refresh)", async () => {
    const { controller, of } = harness();
    controller.open("A");
    of("records")[0]?.resolve(page([1], 1));
    await flush();
    controller.setQuery("a");
    controller.setQuery("ab");
    // The answer to "a" arrives last but must not replace "ab" (the aborted one rejects).
    of("records")[2]?.resolve(page([2], 1));
    of("records")[1]?.resolve(page([99], 1));
    await flush();
    expect(controller.state.value.records.items.map((i) => i.id)).toEqual([2]);
  });

  it("drops a pending page of loadMore when the list restarts", async () => {
    const { controller, of } = harness();
    controller.open("A");
    of("records")[0]?.resolve(page([3, 2], 4, "c1"));
    await flush();
    controller.loadMore();
    controller.setType("bugfix");
    of("records")[1]?.resolve(page([1, 0], 4));
    of("records")[2]?.resolve(page([8], 1));
    await flush();
    expect(controller.state.value.records.items.map((i) => i.id)).toEqual([8]);
    expect(controller.state.value.records.loadingMore).toBe(false);
  });

  it("keeps sections independent: one failing section does not hide the others, and retries", async () => {
    const { controller, of } = harness();
    controller.open("A");
    of("records")[0]?.resolve(page([1], 1));
    of("summary")[0]?.reject(new Error("The view failed"));
    of("context")[0]?.resolve({ context: { content: "ctx", injectedAt: 1, truncated: false } });
    await flush();
    const state = controller.state.value;
    expect(state.records.status).toBe("ready");
    expect(state.summary).toMatchObject({ status: "error", error: "The view failed" });
    expect(state.context).toMatchObject({ status: "ready" });
    controller.retry("summary");
    expect(controller.state.value.summary.status).toBe("loading");
    of("summary")[1]?.resolve({ summary: null });
    await flush();
    expect(controller.state.value.summary).toMatchObject({ status: "ready", value: null });
  });

  it("reports a failed records page and a failed load-more separately, keeping what was shown", async () => {
    const { controller, of } = harness();
    controller.open("A");
    of("records")[0]?.reject(new Error("boom"));
    await flush();
    expect(controller.state.value.records).toMatchObject({ status: "error", error: "boom" });
    controller.retry("records");
    of("records")[1]?.resolve(page([2, 1], 3, "c1"));
    await flush();
    controller.loadMore();
    of("records")[2]?.reject(new Error("later"));
    await flush();
    expect(controller.state.value.records).toMatchObject({
      status: "ready",
      loadingMore: false,
      loadMoreError: "later",
    });
    expect(controller.state.value.records.items).toHaveLength(2);
  });

  it("refresh reloads every section for the same chat and keeps the filters", async () => {
    const { controller, of } = harness();
    controller.open("A");
    controller.setType("bugfix");
    controller.refresh();
    const last = of("records").at(-1);
    expect(last?.params).toEqual({ limit: 2, type: "bugfix" });
    expect(of("summary")).toHaveLength(2);
    expect(of("context")).toHaveLength(2);
  });

  it("close aborts everything in flight and ignores late answers", async () => {
    const { controller, calls } = harness();
    controller.open("A");
    controller.close();
    expect(calls.every((c) => c.signal.aborted)).toBe(true);
    calls[0]?.resolve(page([1], 1));
    await flush();
    expect(controller.state.value.records.items).toEqual([]);
  });
});

describe("view URL", () => {
  it("builds the memory view URL with encoded params and skips empty ones", () => {
    expect(
      memoryViewUrl("s 1", "records", { q: "a&b c", limit: 20, type: undefined, cursor: "" }),
    ).toBe("/api/sessions/s%201/views/memory/records?q=a%26b+c&limit=20");
    expect(memoryViewUrl("s1", "summary")).toBe("/api/sessions/s1/views/memory/summary");
  });
});

describe("Memory tab strings", () => {
  it("has the same keys and placeholders in English and Spanish", () => {
    const keys = Object.keys(memoryStrings.en).sort();
    expect(Object.keys(memoryStrings.es).sort()).toEqual(keys);
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of keys)
      expect(placeholders(memoryStrings.es[key as keyof typeof memoryStrings.en]), key).toEqual(
        placeholders(memoryStrings.en[key as keyof typeof memoryStrings.en]),
      );
  });

  it("translates through the active locale and fills placeholders", () => {
    locale.value = "en";
    expect(tm("empty")).toBe("No memory stored for this chat yet");
    expect(tm("count", { shown: 2, total: 3 })).toBe("2 of 3");
    locale.value = "es";
    expect(tm("empty")).not.toBe("No memory stored for this chat yet");
    locale.value = "en";
  });

  it("adds only the tab label to the always-loaded dictionaries", () => {
    expect(en["header.memory"]).toBe("Memory");
    expect(es["header.memory"]).toBe("Memoria");
  });
});
