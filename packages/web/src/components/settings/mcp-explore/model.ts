/**
 * Pure model of Settings → MCP → Explore (specs/030, UX-01): the filters and their query string,
 * paging arithmetic, the 300 ms debounce and the one decision that matters, which of the six
 * states to show (loading, empty catalog, no matches, offline with cache, error, partial sync) and
 * with which action. No DOM and no store: tested directly in `tests/web-mcp-explore.test.ts`.
 */
import type { McpCatalogPage } from "@alisio/sdk";

export const PAGE_SIZE = 24;
export const SEARCH_DEBOUNCE_MS = 300;

export interface ExploreFilters {
  q: string;
  category: string;
  execution: "" | "local" | "remote";
  ready: boolean;
  page: number;
}

export const DEFAULT_FILTERS: ExploreFilters = {
  q: "",
  category: "",
  execution: "",
  ready: false,
  page: 1,
};

/** Changing any filter returns to page 1; only an explicit `page` keeps its value. */
export function setFilter(filters: ExploreFilters, patch: Partial<ExploreFilters>): ExploreFilters {
  return { ...filters, page: 1, ...patch };
}

export const filtersActive = (f: ExploreFilters): boolean =>
  !!f.q.trim() || !!f.category || !!f.execution || f.ready;

export function toQueryString(f: ExploreFilters): string {
  const params = new URLSearchParams();
  if (f.q.trim()) params.set("q", f.q.trim());
  if (f.category) params.set("category", f.category);
  if (f.execution) params.set("execution", f.execution);
  if (f.ready) params.set("ready", "true");
  params.set("page", String(f.page));
  params.set("pageSize", String(PAGE_SIZE));
  return params.toString();
}

export function pageRange(
  page: number,
  pageSize: number,
  total: number,
): { from: number; to: number; pages: number } {
  if (total <= 0) return { from: 0, to: 0, pages: 1 };
  return {
    from: (page - 1) * pageSize + 1,
    to: Math.min(page * pageSize, total),
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export type ExploreBody = "loading" | "error" | "empty-catalog" | "no-matches" | "list";
export type ExploreNotice = "offline" | "partial" | "syncing" | "skipped";
export type ExploreAction = "retry" | "sync" | "clear-filters";

export interface ExploreViewState {
  body: ExploreBody;
  notice?: ExploreNotice;
  /** The recovery action the state offers. */
  action?: ExploreAction;
}

export function exploreView(input: {
  loading: boolean;
  error?: string;
  filters: ExploreFilters;
  page?: McpCatalogPage;
}): ExploreViewState {
  const { page, filters } = input;
  if (!page) return input.error ? { body: "error", action: "retry" } : { body: "loading" };
  const sync = page.syncStatus;
  if (page.total === 0 && !filtersActive(filters) && sync.entryCount === 0) {
    if (sync.syncing) return { body: "loading" };
    return sync.lastError
      ? { body: "error", action: "sync" }
      : { body: "empty-catalog", action: "sync" };
  }
  if (page.total === 0) return { body: "no-matches", action: "clear-filters" };
  if (sync.syncing) return { body: "list", notice: "syncing" };
  if (sync.lastError)
    return { body: "list", notice: sync.partial ? "partial" : "offline", action: "sync" };
  if (sync.rejectedCount > 0) return { body: "list", notice: "skipped" };
  return { body: "list" };
}

/** Calls `fn` with the last arguments once `ms` passed without a new call. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    call(...args: A) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        fn(...args);
      }, ms);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
