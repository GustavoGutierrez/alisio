/**
 * Walks a `CatalogSource` into the store (CAT-01..03). Bounded by a page cap and a deadline,
 * cancellable through an `AbortSignal`, idempotent per (source, name, version). The checkpoint
 * advances only when the whole walk finished; a failure in the middle keeps the previous one, so
 * the retry re-reads the same window (with a five-minute overlap) and loses nothing.
 */
import type { CategoryClassifier } from "./classifier.ts";
import { type CatalogSource, CatalogSourceError, MAX_PAGE_LIMIT } from "./source.ts";
import type { CatalogStore } from "./store.ts";

export const SYNC_OVERLAP_MS = 5 * 60_000;

export interface SyncOptions {
  source: CatalogSource;
  store: CatalogStore;
  classifier: CategoryClassifier;
  baseUrl?: string;
  now?: () => Date;
  signal?: AbortSignal;
  pageSize?: number;
  /** Page cap of one walk (default 300 pages = 30 000 entries). */
  maxPages?: number;
  /** Total time cap of one walk (default 5 minutes). */
  deadlineMs?: number;
}

export interface SyncOutcome {
  state: "complete" | "failed";
  incremental: boolean;
  pages: number;
  applied: number;
  rejected: number;
  error?: { code: string; message: string };
  /** Some pages were applied before the walk stopped. */
  partial: boolean;
}

/** User-safe text per failure code: never a URL, a response body or a stack. */
export const SYNC_ERROR_MESSAGES: Record<string, string> = {
  network: "The catalog could not be reached.",
  timeout: "The catalog did not answer in time.",
  http: "The catalog service answered with an error.",
  too_large: "The catalog sent more data than Alisio accepts.",
  bad_response: "The catalog answered with something Alisio does not understand.",
  aborted: "The update was cancelled.",
  invalid_config: "The catalog source is not configured correctly.",
  unknown_source: "The configured catalog source is not available.",
  page_cap: "The catalog is larger than one update can read.",
  internal: "The catalog update failed.",
};

export function describeSyncError(error: unknown): { code: string; message: string } {
  const code = error instanceof CatalogSourceError ? error.code : "internal";
  return { code, message: SYNC_ERROR_MESSAGES[code] ?? SYNC_ERROR_MESSAGES.internal ?? "" };
}

export async function runSync(options: SyncOptions): Promise<SyncOutcome> {
  const { source, store, classifier } = options;
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const state = store.getSource(source.sourceId);
  const incremental = !!(source.capabilities.supportsIncremental && state?.checkpoint);
  const updatedSince = incremental
    ? new Date(Date.parse(state?.checkpoint as string) - SYNC_OVERLAP_MS).toISOString()
    : undefined;
  const limit = Math.max(1, Math.min(options.pageSize ?? MAX_PAGE_LIMIT, MAX_PAGE_LIMIT));
  const maxPages = options.maxPages ?? 300;
  const deadline = AbortSignal.timeout(options.deadlineMs ?? 5 * 60_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let pages = 0;
  let applied = 0;
  let rejected = 0;
  const fail = (error: { code: string; message: string }): SyncOutcome => {
    store.recordAttempt(source.sourceId, {
      at: now().toISOString(),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      error,
      partial: pages > 0,
    });
    return { state: "failed", incremental, pages, applied, rejected, error, partial: pages > 0 };
  };
  let cursor: string | undefined;
  try {
    for (;;) {
      if (signal.aborted)
        throw new CatalogSourceError(
          deadline.aborted && !options.signal?.aborted ? "timeout" : "aborted",
          "stopped",
        );
      if (pages >= maxPages)
        return fail({ code: "page_cap", message: SYNC_ERROR_MESSAGES.page_cap ?? "" });
      const page = await source.listPage({
        limit,
        signal,
        ...(cursor ? { cursor } : {}),
        ...(updatedSince ? { updatedSince } : {}),
      });
      pages++;
      const result = store.applyPage({
        sourceId: source.sourceId,
        entries: page.entries,
        rejected: page.rejected,
        classifier,
        fetchedAt: now().toISOString(),
      });
      applied += result.applied;
      rejected += page.rejected.length;
      cursor = page.nextCursor;
      if (!cursor) break;
    }
  } catch (error) {
    return fail(describeSyncError(error));
  }
  // The checkpoint is the instant the walk STARTED: anything changed during it is re-read next time.
  store.recordAttempt(source.sourceId, {
    at: now().toISOString(),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    success: { checkpoint: startedAt.toISOString() },
  });
  return { state: "complete", incremental, pages, applied, rejected, partial: false };
}
