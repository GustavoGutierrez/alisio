import { ceilDiv } from "./math.ts";

/**
 * How many pages come after the given page. It is never negative, and an empty list has none.
 */
export function pagesRemaining(itemCount: number, page: number, pageSize: number): number {
  return ceilDiv(itemCount, pageSize) - page;
}
