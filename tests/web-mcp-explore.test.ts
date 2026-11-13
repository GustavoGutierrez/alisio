/**
 * Web side of the MCP catalog Explore view (specs/030 phase 2): the pure view model (states,
 * filters, paging, debounce), the EN/ES strings, the hook-free presentational view (walked as a
 * VNode tree: the web tests have no DOM) and the lazy loading that keeps the initial bundle inside
 * its budget. The install button is present but disabled until the installer ships.
 */
import { readFileSync } from "node:fs";
import type { McpCatalogItem, McpCatalogPage, McpCatalogSyncStatus } from "@alisio/sdk";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CATEGORY_IDS } from "../packages/core/src/mcp/catalog/categories.ts";
import {
  DEFAULT_FILTERS,
  debounce,
  type ExploreFilters,
  exploreView,
  filtersActive,
  pageRange,
  setFilter,
  toQueryString,
} from "../packages/web/src/components/settings/mcp-explore/model.ts";
import { exploreStrings, xs } from "../packages/web/src/components/settings/mcp-explore/strings.ts";
import { locale } from "../packages/web/src/i18n/index.ts";

type VNode = { type: unknown; props: Record<string, unknown> };
const VIEW_PATH = "../packages/web/src/components/settings/mcp-explore/ExploreView.tsx";
let ExploreResults: (props: Record<string, unknown>) => unknown;
beforeAll(async () => {
  ExploreResults = (
    (await import(/* @vite-ignore */ VIEW_PATH)) as { ExploreResults: typeof ExploreResults }
  ).ExploreResults;
});
afterEach(() => {
  locale.value = "en";
  vi.useRealTimers();
});

const status = (over: Partial<McpCatalogSyncStatus> = {}): McpCatalogSyncStatus => ({
  sourceId: "fake",
  syncing: false,
  entryCount: 100,
  rejectedCount: 0,
  partial: false,
  lastSuccessAt: "2026-11-12T10:00:00.000Z",
  ...over,
});
const item = (over: Partial<McpCatalogItem> = {}): McpCatalogItem => ({
  sourceId: "fake",
  name: "io.example/alpha",
  description: "Alpha does things",
  version: "1.0.0",
  status: "active",
  execution: "local",
  methods: ["npm"],
  category: { id: "development", method: "rule", confidence: 0.55 },
  ready: true,
  ...over,
});
const page = (over: Partial<McpCatalogPage> = {}): McpCatalogPage => ({
  items: [item()],
  total: 1,
  page: 1,
  pageSize: 24,
  queryApplied: false,
  facets: { categories: [{ id: "development", count: 1 }], execution: [], ready: 1 },
  syncStatus: status(),
  ...over,
});

describe("explore view model", () => {
  it("derives one body state and at most one notice, each with a useful action", () => {
    const filters = DEFAULT_FILTERS;
    expect(exploreView({ loading: true, filters })).toMatchObject({ body: "loading" });
    expect(exploreView({ loading: false, error: "boom", filters })).toMatchObject({
      body: "error",
      action: "retry",
    });
    expect(exploreView({ loading: false, filters, page: page() })).toMatchObject({ body: "list" });

    const empty = page({
      items: [],
      total: 0,
      syncStatus: status({ entryCount: 0, lastSuccessAt: undefined }),
    });
    expect(exploreView({ loading: false, filters, page: empty })).toMatchObject({
      body: "empty-catalog",
      action: "sync",
    });
    const syncingFirst = page({
      items: [],
      total: 0,
      syncStatus: status({ entryCount: 0, syncing: true }),
    });
    expect(exploreView({ loading: false, filters, page: syncingFirst })).toMatchObject({
      body: "loading",
    });
    const failedFirst = page({
      items: [],
      total: 0,
      syncStatus: status({ entryCount: 0, lastError: { code: "network", message: "x" } }),
    });
    expect(exploreView({ loading: false, filters, page: failedFirst })).toMatchObject({
      body: "error",
      action: "sync",
    });

    const none = page({ items: [], total: 0 });
    expect(
      exploreView({ loading: false, filters: setFilter(filters, { q: "zzz" }), page: none }),
    ).toMatchObject({ body: "no-matches", action: "clear-filters" });

    const offline = page({ syncStatus: status({ lastError: { code: "network", message: "x" } }) });
    expect(exploreView({ loading: false, filters, page: offline })).toMatchObject({
      body: "list",
      notice: "offline",
      action: "sync",
    });
    const partial = page({
      syncStatus: status({ partial: true, lastError: { code: "timeout", message: "x" } }),
    });
    expect(exploreView({ loading: false, filters, page: partial })).toMatchObject({
      body: "list",
      notice: "partial",
    });
    expect(
      exploreView({
        loading: false,
        filters,
        page: page({ syncStatus: status({ syncing: true }) }),
      }),
    ).toMatchObject({ notice: "syncing" });
    expect(
      exploreView({
        loading: false,
        filters,
        page: page({ syncStatus: status({ rejectedCount: 3 }) }),
      }),
    ).toMatchObject({ notice: "skipped" });
  });

  it("resets the page when a filter changes and builds the query from the filters", () => {
    let f: ExploreFilters = { ...DEFAULT_FILTERS, page: 4 };
    f = setFilter(f, { category: "data" });
    expect(f.page).toBe(1);
    expect(setFilter(f, { page: 3 }).page).toBe(3);
    expect(toQueryString(DEFAULT_FILTERS)).toBe("page=1&pageSize=24");
    const q = new URLSearchParams(
      toQueryString({
        q: " mail ",
        category: "communication",
        execution: "remote",
        ready: true,
        page: 2,
      }),
    );
    expect(Object.fromEntries(q)).toEqual({
      q: "mail",
      category: "communication",
      execution: "remote",
      ready: "true",
      page: "2",
      pageSize: "24",
    });
    expect(filtersActive(DEFAULT_FILTERS)).toBe(false);
    expect(filtersActive(setFilter(DEFAULT_FILTERS, { ready: true }))).toBe(true);
    expect(filtersActive(setFilter(DEFAULT_FILTERS, { q: "  " }))).toBe(false);
  });

  it("computes the visible range and the page count", () => {
    expect(pageRange(1, 24, 150)).toEqual({ from: 1, to: 24, pages: 7 });
    expect(pageRange(7, 24, 150)).toEqual({ from: 145, to: 150, pages: 7 });
    expect(pageRange(1, 24, 0)).toEqual({ from: 0, to: 0, pages: 1 });
  });

  it("debounces by 300 ms: only the last keystroke reaches the callback", () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const d = debounce((value: string) => seen.push(value), 300);
    d.call("m");
    vi.advanceTimersByTime(200);
    d.call("ma");
    vi.advanceTimersByTime(200);
    d.call("mai");
    vi.advanceTimersByTime(299);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(["mai"]);
    d.call("x");
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(["mai"]);
  });
});

describe("explore strings", () => {
  it("keep EN and ES in step: same keys, same placeholders, one label per category", () => {
    const { en, es } = exploreStrings;
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as Array<keyof typeof en>)
      expect(holes(es[key]), key).toEqual(holes(en[key]));
    for (const id of CATEGORY_IDS) expect(en[`cat.${id}` as keyof typeof en]).toBeTruthy();
  });

  it("follows the locale signal", () => {
    expect(xs("tab.explore")).toBe("Explore");
    locale.value = "es";
    expect(xs("tab.explore")).toBe("Explorar");
  });
});

// ---- the presentational view, walked without a DOM ----------------------------------------

const noop = () => {};
const handlers = {
  onSync: noop,
  onRetry: noop,
  onClear: noop,
  onPage: noop,
  onFilter: noop,
};
function walk(node: unknown, visit: (n: VNode) => void): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (typeof node !== "object") return;
  const vnode = node as VNode;
  visit(vnode);
  if (typeof vnode.type === "function") {
    walk((vnode.type as (p: unknown) => unknown)(vnode.props), visit);
    return;
  }
  walk(vnode.props?.children, visit);
}
const textOf = (root: unknown) => {
  const parts: string[] = [];
  const collect = (n: unknown) => {
    if (typeof n === "string" || typeof n === "number") parts.push(String(n));
    else if (Array.isArray(n)) n.forEach(collect);
    else if (n && typeof n === "object") {
      const v = n as VNode;
      if (typeof v.type === "function") collect((v.type as (p: unknown) => unknown)(v.props));
      else collect(v.props?.children);
    }
  };
  collect(root);
  return parts.join(" ");
};
const buttons = (root: unknown) => {
  const found: VNode[] = [];
  walk(root, (n) => {
    if (n.type === "button") found.push(n);
  });
  return found;
};
const render = (props: Record<string, unknown>) => ExploreResults({ ...handlers, ...props });

describe("ExploreResults", () => {
  it("shows the total and range, cards with execution, category and reason badges as text", () => {
    const rows = [
      item(),
      item({
        name: "io.example/beta",
        execution: "remote",
        ready: false,
        blocked: { reason: "method_unsupported", detail: "pypi" },
        methods: ["pypi"],
      }),
    ];
    const tree = render({
      page: page({ items: rows, total: 150 }),
      filters: DEFAULT_FILTERS,
      view: exploreView({
        loading: false,
        filters: DEFAULT_FILTERS,
        page: page({ items: rows, total: 150 }),
      }),
    });
    const text = textOf(tree);
    expect(text).toContain("1–2 of 150");
    expect(text).toContain("io.example/alpha");
    expect(text).toContain("On this computer");
    expect(text).toContain("Remote service");
    expect(text).toContain("Development");
    expect(text).toContain("Not supported yet");
    expect(text).toContain("pypi");
  });

  it("offers a disabled install control with its reason: installing is not enabled yet", () => {
    const tree = render({
      page: page(),
      filters: DEFAULT_FILTERS,
      view: exploreView({ loading: false, filters: DEFAULT_FILTERS, page: page() }),
    });
    const install = buttons(tree).find((b) => textOf(b.props.children).includes("Install"));
    expect(install?.props.disabled).toBe(true);
    expect(textOf(tree)).toContain("Installing arrives in a later update");
  });

  it.each([
    ["loading", { loading: true }, "Loading the catalog"],
    ["error", { loading: false, error: "Network down" }, "Try again"],
    [
      "empty-catalog",
      {
        loading: false,
        page: page({
          items: [],
          total: 0,
          syncStatus: status({ entryCount: 0, lastSuccessAt: undefined }),
        }),
      },
      "Update the catalog",
    ],
    [
      "no-matches",
      {
        loading: false,
        filters: setFilter(DEFAULT_FILTERS, { q: "zzz" }),
        page: page({ items: [], total: 0 }),
      },
      "Clear filters",
    ],
  ] as const)("state %s shows its message and a useful action", (_name, input, expected) => {
    const filters = (input as { filters?: ExploreFilters }).filters ?? DEFAULT_FILTERS;
    const pg = (input as { page?: McpCatalogPage }).page;
    const view = exploreView({
      loading: input.loading,
      ...("error" in input ? { error: input.error } : {}),
      filters,
      ...(pg ? { page: pg } : {}),
    });
    const tree = render({
      page: pg,
      filters,
      view,
      error: "error" in input ? input.error : undefined,
    });
    expect(textOf(tree)).toContain(expected);
    if (_name !== "loading")
      expect(buttons(tree).some((b) => textOf(b.props.children).includes(expected))).toBe(true);
  });

  it("explains the offline cache with its date and the partial sync, each with an action", () => {
    const offline = page({ syncStatus: status({ lastError: { code: "network", message: "x" } }) });
    const tree = render({
      page: offline,
      filters: DEFAULT_FILTERS,
      view: exploreView({ loading: false, filters: DEFAULT_FILTERS, page: offline }),
    });
    const text = textOf(tree);
    expect(text).toContain("saved copy");
    expect(buttons(tree).some((b) => textOf(b.props.children).includes("Try again"))).toBe(true);
    const part = page({
      syncStatus: status({ partial: true, lastError: { code: "timeout", message: "x" } }),
    });
    const tree2 = render({
      page: part,
      filters: DEFAULT_FILTERS,
      view: exploreView({ loading: false, filters: DEFAULT_FILTERS, page: part }),
    });
    expect(textOf(tree2)).toContain("partly updated");
  });

  it("renders in Spanish and exposes pagination with accessible names", () => {
    locale.value = "es";
    const pg = page({ items: [item()], total: 60, page: 2 });
    const tree = render({
      page: pg,
      filters: { ...DEFAULT_FILTERS, page: 2 },
      view: exploreView({ loading: false, filters: DEFAULT_FILTERS, page: pg }),
    });
    expect(textOf(tree)).toContain("25–25 de 60");
    expect(textOf(tree)).toContain("En este equipo");
    const named: string[] = [];
    walk(tree, (n) => {
      const label = n.props?.["aria-label"];
      if (typeof label === "string") named.push(label);
    });
    expect(named).toContain("Anterior");
    expect(named).toContain("Siguiente");
  });
});

describe("lazy loading", () => {
  it("keeps Explore out of the initial bundle: strings, view and API calls live in the settings chunk", () => {
    const read = (p: string) =>
      readFileSync(new URL(`../packages/web/src/${p}`, import.meta.url), "utf8");
    const mcpPage = read("components/settings/McpPage.tsx");
    expect(mcpPage).toMatch(/import\(["']\.\/mcp-explore\/ExploreView\.tsx["']\)/);
    expect(mcpPage).not.toMatch(/^import .*mcp-explore\/(ExploreView|model)/m);
    expect(read("i18n/en.ts")).not.toContain("explore.");
    expect(read("net/api.ts")).not.toContain("mcp/catalog");
  });
});
