/**
 * Controller of the Memory tab: the memory of the open chat, read through the memory plugin's
 * data views (`records`, `summary`, `context`; see specs/archive/alisio-web-memory-tab-v1.md). Three
 * independent sections, a cursor-paginated list, filters, and strict discarding of stale answers:
 * every request is aborted when superseded AND carries a sequence number, so an answer that still
 * arrives after the chat (or the filter) changed never reaches the state.
 */
import { type Signal, signal } from "@preact/signals";

export interface MemoryEntry {
  id: number;
  type: string;
  title: string;
  content: string;
  contentTruncated: boolean;
  scope: string;
  topicKey?: string;
  /** Producer, e.g. memory_save, compaction or session_summary. */
  source?: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  revisionCount: number;
  duplicateCount: number;
}
export interface RecordsPage {
  items: MemoryEntry[];
  total?: number;
  next?: string;
}
export interface TextView {
  content: string;
  truncated: boolean;
  /** `updatedAt` of a summary, `injectedAt` of the loaded context. */
  at: number;
}
type View = "records" | "summary" | "context";
export type MemoryFetch = (
  sessionId: string,
  view: View,
  params: Record<string, string | number | undefined>,
  signal: AbortSignal,
) => Promise<unknown>;

export interface RecordsState {
  status: "loading" | "ready" | "error";
  items: MemoryEntry[];
  total?: number;
  next?: string;
  loadingMore: boolean;
  error?: string;
  loadMoreError?: string;
}
export interface SectionState {
  status: "loading" | "ready" | "error";
  /** `null`: the plugin has nothing for this chat. */
  value?: TextView | null;
  error?: string;
}
export interface MemoryState {
  sessionId: string;
  /** Selected memory type ("" = all). */
  type: string;
  query: string;
  records: RecordsState;
  summary: SectionState;
  context: SectionState;
}

/**
 * URL of one of the memory plugin's data views for a chat (`GET …/views/memory/:view`). Empty
 * parameters are skipped, so the query only carries what the user chose.
 */
export function memoryViewUrl(
  sessionId: string,
  view: View,
  params: Record<string, string | number | undefined> = {},
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== "") query.set(key, String(value));
  const text = query.toString();
  return `/api/sessions/${encodeURIComponent(sessionId)}/views/memory/${view}${text ? `?${text}` : ""}`;
}

const loadingRecords = (): RecordsState => ({ status: "loading", items: [], loadingMore: false });
const initial = (sessionId = "", type = "", query = ""): MemoryState => ({
  sessionId,
  type,
  query,
  records: loadingRecords(),
  summary: { status: "loading" },
  context: { status: "loading" },
});
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";

/** Appends a page, skipping entries already shown (rows can move while the user browses). */
export function mergeEntries(current: MemoryEntry[], page: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set(current.map((entry) => entry.id));
  return [...current, ...page.filter((entry) => !seen.has(entry.id))];
}

export function createMemoryController(
  fetchView: MemoryFetch,
  options: { pageSize?: number } = {},
) {
  const pageSize = options.pageSize ?? 20;
  const state: Signal<MemoryState> = signal(initial());
  const seq = { records: 0, summary: 0, context: 0 };
  const aborts: Partial<Record<View, AbortController>> = {};

  const begin = (view: View): { id: number; signal: AbortSignal } => {
    aborts[view]?.abort();
    const controller = new AbortController();
    aborts[view] = controller;
    return { id: ++seq[view], signal: controller.signal };
  };
  /** Whether an answer still belongs to the open chat and is the newest request of its view. */
  const current = (view: View, id: number, sessionId: string) =>
    seq[view] === id && state.value.sessionId === sessionId;
  const patch = (next: Partial<MemoryState>) => {
    state.value = { ...state.value, ...next };
  };

  function loadRecords(more: boolean): void {
    const { sessionId, type, query, records } = state.value;
    if (more && (!records.next || records.loadingMore || records.status !== "ready")) return;
    const { id, signal: abort } = begin("records");
    const cursor = more ? records.next : undefined;
    state.value = {
      ...state.value,
      records: more
        ? { ...records, loadingMore: true, loadMoreError: undefined }
        : loadingRecords(),
    };
    const params = {
      limit: pageSize,
      ...(type ? { type } : {}),
      ...(query ? { q: query } : {}),
      ...(cursor ? { cursor } : {}),
    };
    fetchView(sessionId, "records", params, abort).then(
      (answer) => {
        if (!current("records", id, sessionId)) return;
        const page = answer as RecordsPage;
        const shown = state.value.records;
        patch({
          records: {
            status: "ready",
            items: more ? mergeEntries(shown.items, page.items) : page.items,
            ...(page.total !== undefined ? { total: page.total } : {}),
            ...(page.next ? { next: page.next } : {}),
            loadingMore: false,
          },
        });
      },
      (error) => {
        if (isAbort(error) || !current("records", id, sessionId)) return;
        const shown = state.value.records;
        patch({
          records: more
            ? { ...shown, loadingMore: false, loadMoreError: reason(error) }
            : { ...loadingRecords(), status: "error", error: reason(error) },
        });
      },
    );
  }

  function loadText(view: "summary" | "context"): void {
    const { sessionId } = state.value;
    const { id, signal: abort } = begin(view);
    patch({ [view]: { status: "loading" } });
    fetchView(sessionId, view, {}, abort).then(
      (answer) => {
        if (!current(view, id, sessionId)) return;
        const body = (answer as Record<string, unknown>)[view] as
          | { content: string; truncated: boolean; updatedAt?: number; injectedAt?: number }
          | null
          | undefined;
        patch({
          [view]: {
            status: "ready",
            value: body
              ? {
                  content: body.content,
                  truncated: body.truncated,
                  at: body.updatedAt ?? body.injectedAt ?? 0,
                }
              : null,
          },
        });
      },
      (error) => {
        if (isAbort(error) || !current(view, id, sessionId)) return;
        patch({ [view]: { status: "error", error: reason(error) } });
      },
    );
  }

  const loadAll = () => {
    loadRecords(false);
    loadText("summary");
    loadText("context");
  };

  return {
    state,
    /** Opens a chat: resets everything (filters too) and loads the three sections. */
    open(sessionId: string): void {
      state.value = initial(sessionId);
      loadAll();
    },
    /** Reloads every section of the open chat, keeping the filters. */
    refresh(): void {
      if (!state.value.sessionId) return;
      state.value = initial(state.value.sessionId, state.value.type, state.value.query);
      loadAll();
    },
    setType(type: string): void {
      if (type === state.value.type) return;
      patch({ type });
      loadRecords(false);
    },
    setQuery(query: string): void {
      const next = query.trim();
      if (next === state.value.query) return;
      patch({ query: next });
      loadRecords(false);
    },
    loadMore: () => loadRecords(true),
    retry(section: "records" | "summary" | "context"): void {
      if (section === "records") loadRecords(false);
      else loadText(section);
    },
    /** Aborts everything in flight; late answers are ignored. */
    close(): void {
      for (const view of ["records", "summary", "context"] as const) {
        aborts[view]?.abort();
        seq[view]++;
      }
    },
  };
}
