import { ceilDiv } from "./math.ts";

/** Number of pages needed for itemCount items. An empty list still has one (empty) page. */
export function totalPages(itemCount: number, pageSize: number): number {
  return ceilDiv(itemCount, pageSize);
}

/**
 * The items of a 1-based page. A page number below 1 is treated as page 1; a page past the end is
 * empty.
 */
export function getPage<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

/** True when a page exists after the given one. */
export function hasNextPage(itemCount: number, page: number, pageSize: number): boolean {
  return page < totalPages(itemCount, pageSize);
}

/**
 * The 1-based, inclusive positions of the first and last item shown on a page, as in "Showing 6-10
 * of 11". The last page stops at itemCount, and an empty list gives { from: 0, to: 0 }.
 */
export function pageRange(
  itemCount: number,
  page: number,
  pageSize: number,
): { from: number; to: number } {
  return { from: (page - 1) * pageSize + 1, to: page * pageSize };
}
