/**
 * The catalog service: the one object the HTTP routes talk to. It owns the lazily opened store,
 * the active source (built by the factory from configuration) and a single-flight background sync
 * per source with the CAT-01 budget (at most one automatic or manual walk per hour; a failed walk
 * may be retried after a short cool-down). Opening the store and syncing never block startup: both
 * happen on first use, off the request path.
 */
import { join } from "node:path";
import type { McpCatalogDetail, McpCatalogPage, McpCatalogSyncStatus } from "@alisio/sdk";
import { stateHome } from "../../config.ts";
import { type CategoryClassifier, createRuleClassifier } from "./classifier.ts";
import type { CatalogSource } from "./source.ts";
import {
  type CatalogSourceConfig,
  createSourceFactory,
  type SourceFactory,
} from "./source-factory.ts";
import { type CatalogQuery, CatalogStore } from "./store.ts";
import { describeSyncError, runSync } from "./sync.ts";
import { toDetail } from "./view.ts";

export interface CatalogServiceOptions {
  /** Database file (default `<stateHome>/mcp/catalog.sqlite`); `:memory:` works. */
  dbPath?: string;
  source?: CatalogSourceConfig;
  factory?: SourceFactory;
  classifier?: CategoryClassifier;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => Date;
  /** Start a background sync when the index is missing or older than the interval. */
  autoSync?: boolean;
  minIntervalMs?: number;
  retryCooldownMs?: number;
  pageSize?: number;
  maxPages?: number;
  deadlineMs?: number;
}

export interface McpCatalogService {
  readonly sourceId: string;
  list(query: CatalogQuery): McpCatalogPage;
  detail(name: string, version?: string): McpCatalogDetail | undefined;
  status(): McpCatalogSyncStatus;
  /** Starts a background walk unless one runs or the budget forbids it; returns the new state. */
  sync(): McpCatalogSyncStatus;
  /** Switches the active source; its rows replace the previous ones after it synced once. */
  setSource(config: CatalogSourceConfig): void;
  /** Fire-and-forget: syncs when the index is empty or stale (never throws, never awaits). */
  ensureFresh(): void;
  /** Resolves when no walk is running (tests and shutdown). */
  idle(): Promise<void>;
  close(): void;
}

const HOUR = 60 * 60_000;

export function createCatalogService(options: CatalogServiceOptions = {}): McpCatalogService {
  const now = options.now ?? (() => new Date());
  const classifier = options.classifier ?? createRuleClassifier();
  const factory = options.factory ?? createSourceFactory();
  const minInterval = options.minIntervalMs ?? HOUR;
  const cooldown = options.retryCooldownMs ?? 60_000;
  let config: CatalogSourceConfig = options.source ?? {};
  let source: CatalogSource | undefined;
  let sourceError: { code: string; message: string } | undefined;
  let store: CatalogStore | undefined;
  let running: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let closed = false;

  const build = () => {
    source = undefined;
    sourceError = undefined;
    try {
      source = factory.create(config, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
      });
    } catch (error) {
      sourceError = describeSyncError(error);
    }
  };
  build();

  const db = () => {
    if (!store) {
      store = CatalogStore.open(options.dbPath ?? join(stateHome(), "mcp", "catalog.sqlite"));
      if (source) store.reclassify(source.sourceId, classifier);
    }
    return store;
  };
  const sourceId = () => source?.sourceId ?? `invalid:${config.source ?? "official"}`;

  const status = (): McpCatalogSyncStatus => {
    const id = sourceId();
    const s = db();
    const state = s.getSource(id);
    const counts = s.counts(id);
    const error = sourceError ?? state?.lastError;
    const allowed = nextAllowed(state, counts.entries);
    return {
      sourceId: id,
      syncing: !!running,
      entryCount: counts.entries,
      rejectedCount: counts.rejected,
      ...(state?.lastSuccess ? { lastSuccessAt: state.lastSuccess } : {}),
      ...(state?.lastAttempt ? { lastAttemptAt: state.lastAttempt } : {}),
      ...(error ? { lastError: error } : {}),
      partial: !!state?.partial && !!error,
      ...(allowed && allowed.getTime() > now().getTime()
        ? { nextSyncAllowedAt: allowed.toISOString() }
        : {}),
    };
  };

  /** When a new walk is next allowed (undefined = now). */
  function nextAllowed(
    state: ReturnType<CatalogStore["getSource"]>,
    entries: number,
  ): Date | undefined {
    if (!state?.lastAttempt) return undefined;
    if (state.lastError || !state.lastSuccess)
      return new Date(Date.parse(state.lastAttempt) + cooldown);
    if (entries === 0) return undefined;
    return new Date(Date.parse(state.lastSuccess) + minInterval);
  }

  const start = (ignoreBudget: boolean): boolean => {
    if (closed || running || !source) return false;
    const s = db();
    if (!ignoreBudget) {
      const allowed = nextAllowed(s.getSource(source.sourceId), s.counts(source.sourceId).entries);
      if (allowed && allowed.getTime() > now().getTime()) return false;
    }
    const active = source;
    controller = new AbortController();
    running = (async () => {
      try {
        const outcome = await runSync({
          source: active,
          store: s,
          classifier,
          ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
          now,
          signal: (controller as AbortController).signal,
          ...(options.pageSize ? { pageSize: options.pageSize } : {}),
          ...(options.maxPages ? { maxPages: options.maxPages } : {}),
          ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
        });
        if (outcome.state === "complete" && active.sourceId === source?.sourceId) {
          s.purgeOtherSources(active.sourceId);
        }
      } catch {
        // runSync records its own failures; a thrown store error leaves the previous state.
      } finally {
        running = undefined;
        controller = undefined;
      }
    })();
    return true;
  };

  return {
    get sourceId() {
      return sourceId();
    },
    list(query) {
      const id = sourceId();
      const page = db().query(id, query);
      return { ...page, syncStatus: status() };
    },
    detail(name, version) {
      const entry = source ? db().detail(source.sourceId, name, version) : undefined;
      return entry ? toDetail(entry, classifier) : undefined;
    },
    status,
    sync() {
      const started = start(false);
      const current = status();
      return !started && !running ? { ...current, throttled: true } : current;
    },
    setSource(next) {
      controller?.abort();
      config = next;
      build();
      const wait = running;
      // Start the new source's first walk as soon as the old walk has stopped.
      if (wait) void wait.then(() => start(true));
      else start(true);
    },
    ensureFresh() {
      if (!options.autoSync || closed) return;
      try {
        start(false);
      } catch {
        /* a broken index is reported through status() */
      }
    },
    async idle() {
      while (running) await running;
    },
    close() {
      closed = true;
      controller?.abort();
      store?.close();
      store = undefined;
    },
  };
}
