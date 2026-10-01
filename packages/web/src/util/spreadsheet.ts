/**
 * Pure logic of SpreadsheetView (spec §17.4–17.5): the 200-row page grid and its LRU cache, which
 * pages a scroll position needs, how each page is requested (keyset cursor of the previous page,
 * or a jump), sort cycling, keyboard movement between cells, column widths and copy text. No DOM
 * or signals, so it is tested in Node.
 */
import type { DatasetRowsPage } from "@alisio/sdk";

/** Fixed row height (px): virtualization needs no measuring. */
export const ROW_HEIGHT = 28;
/** Rows per page (also the page-cache unit). */
export const PAGE_SIZE = 200;
/** Pages kept in memory. */
export const CACHE_PAGES = 20;
/** Rows rendered above and below the visible ones. */
export const OVERSCAN = 10;
/** The server's `OFFSET` limit when a sort or filter is active. */
export const MAX_OFFSET = 100_000;
export const MIN_COLUMN_WIDTH = 60;
export const MAX_COLUMN_WIDTH = 800;
export const DEFAULT_COLUMN_WIDTH = 140;

/** Sort and filter of the open sheet. */
export interface GridView {
  sheet: string;
  sort?: { column: string; dir: "asc" | "desc" };
  filter?: { text: string; column?: string };
}

/** A stable key of everything that changes which rows a page holds. */
export const viewKey = (datasetId: string, view: GridView): string =>
  JSON.stringify([
    datasetId,
    view.sheet,
    view.sort ?? null,
    view.filter?.text ? view.filter : null,
  ]);

/** A least-recently-used cache. */
export class LruCache<V> {
  private map = new Map<number, V>();
  constructor(private readonly capacity: number = CACHE_PAGES) {}
  get size(): number {
    return this.map.size;
  }
  has(key: number): boolean {
    return this.map.has(key);
  }
  /** Reads and marks as most recently used. */
  get(key: number): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  /** Reads without touching the order. */
  peek(key: number): V | undefined {
    return this.map.get(key);
  }
  set(key: number, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as number;
      this.map.delete(oldest);
    }
  }
  clear(): void {
    this.map.clear();
  }
  keys(): number[] {
    return [...this.map.keys()];
  }
}

/** First and last row index (inclusive, with overscan) for a scroll position. */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  total: number,
  overscan = OVERSCAN,
): { first: number; last: number } {
  if (total <= 0) return { first: 0, last: -1 };
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - overscan);
  const last = Math.min(total - 1, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + overscan);
  return { first, last };
}

/** Page indexes that cover rows `first..last`. */
export function pagesFor(first: number, last: number): number[] {
  if (last < first) return [];
  const pages: number[] = [];
  for (let p = Math.floor(first / PAGE_SIZE); p <= Math.floor(last / PAGE_SIZE); p++) pages.push(p);
  return pages;
}

export interface PageRequest {
  limit: number;
  after?: string;
  offset?: number;
  sort?: string;
  dir?: "asc" | "desc";
  filter?: string;
  column?: string;
}

/** What a loaded page remembers for the next one. */
export interface LoadedPage {
  page: DatasetRowsPage;
}

/**
 * How to request page `index`: with the cursor of the previous page when it is cached (exact
 * continuation), otherwise by jumping (`offset`). A jump is always possible without sorting or
 * filtering (the server uses the dense row id); with them it only reaches `MAX_OFFSET`, so a
 * farther page needs its predecessor first (`need`).
 */
export function planPage(
  index: number,
  view: GridView,
  interactive: boolean,
  cache: { peek(index: number): LoadedPage | undefined },
): { request: PageRequest } | { need: number } {
  const base: PageRequest = { limit: PAGE_SIZE };
  if (interactive && view.sort) {
    base.sort = view.sort.column;
    base.dir = view.sort.dir;
  }
  if (interactive && view.filter?.text) {
    base.filter = view.filter.text;
    if (view.filter.column !== undefined) base.column = view.filter.column;
  }
  if (index === 0) return { request: base };
  const cursor = cache.peek(index - 1)?.page.next;
  if (cursor) return { request: { ...base, after: cursor } };
  const jump = index * PAGE_SIZE;
  const unrestricted = !base.sort && !base.filter;
  if (unrestricted || jump <= MAX_OFFSET) return { request: { ...base, offset: jump } };
  return { need: index - 1 };
}

/** Sort cycle of a header click: ascending → descending → none. */
export function nextSort(current: GridView["sort"], column: string): GridView["sort"] | undefined {
  if (current?.column !== column) return { column, dir: "asc" };
  if (current.dir === "asc") return { column, dir: "desc" };
  return undefined;
}

export const ariaSort = (
  sort: GridView["sort"],
  column: string,
): "ascending" | "descending" | "none" =>
  sort?.column !== column ? "none" : sort.dir === "asc" ? "ascending" : "descending";

export interface Cell {
  row: number;
  col: number;
}

/**
 * The cell a key moves to (rows and columns are 0-based; `pageRows` is how many rows fit the
 * viewport), or undefined for keys that do not move.
 */
export function moveCell(
  key: string,
  ctrl: boolean,
  at: Cell,
  size: { rows: number; cols: number },
  pageRows: number,
): Cell | undefined {
  const lastRow = Math.max(0, size.rows - 1);
  const lastCol = Math.max(0, size.cols - 1);
  const clamp = (cell: Cell): Cell => ({
    row: Math.min(lastRow, Math.max(0, cell.row)),
    col: Math.min(lastCol, Math.max(0, cell.col)),
  });
  switch (key) {
    case "ArrowDown":
      return clamp({ ...at, row: at.row + 1 });
    case "ArrowUp":
      return clamp({ ...at, row: at.row - 1 });
    case "ArrowRight":
      return clamp({ ...at, col: at.col + 1 });
    case "ArrowLeft":
      return clamp({ ...at, col: at.col - 1 });
    case "PageDown":
      return clamp({ ...at, row: at.row + Math.max(1, pageRows - 1) });
    case "PageUp":
      return clamp({ ...at, row: at.row - Math.max(1, pageRows - 1) });
    case "Home":
      return ctrl ? clamp({ row: 0, col: 0 }) : clamp({ ...at, col: 0 });
    case "End":
      return ctrl ? clamp({ row: lastRow, col: lastCol }) : clamp({ ...at, col: lastCol });
    default:
      return undefined;
  }
}

/** The scroll offset that brings `row` into view (unchanged when already visible). */
export function scrollToRow(
  row: number,
  scrollTop: number,
  viewportHeight: number,
  headerHeight = ROW_HEIGHT,
): number {
  const top = row * ROW_HEIGHT;
  const bottom = top + ROW_HEIGHT;
  const usable = Math.max(ROW_HEIGHT, viewportHeight - headerHeight);
  if (top < scrollTop) return top;
  if (bottom > scrollTop + usable) return bottom - usable;
  return scrollTop;
}

export const clampColumnWidth = (width: number): number =>
  Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));

/** The width after a key on a column's resize handle (←/→ ±16 px, Shift ±64, Home/End bounds). */
export function columnWidthStep(key: string, shift: boolean, width: number): number | undefined {
  const step = shift ? 64 : 16;
  switch (key) {
    case "ArrowRight":
      return clampColumnWidth(width + step);
    case "ArrowLeft":
      return clampColumnWidth(width - step);
    case "Home":
      return MIN_COLUMN_WIDTH;
    case "End":
      return MAX_COLUMN_WIDTH;
    case "Enter":
      return DEFAULT_COLUMN_WIDTH;
    default:
      return undefined;
  }
}

/** A cell as text (what Ctrl/Cmd+C copies): empty for NULL. */
export const cellValueText = (value: string | number | null | undefined): string =>
  value === null || value === undefined ? "" : String(value);

/** A row as tab-separated text; tabs and line breaks inside cells become spaces. */
export const rowText = (row: Array<string | number | null>): string =>
  row.map((value) => cellValueText(value).replace(/[\t\r\n]+/g, " ")).join("\t");

/** A short, readable size such as `12,480 rows` for the toolbar. */
export const rowsLabel = (count: number): string => count.toLocaleString("en-US");
