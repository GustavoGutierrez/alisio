/**
 * Settings → MCP → Explore (specs/030 phase 2, UX-01): browse, search (300 ms debounce, local
 * index only), filter, page by 24, with distinct states and a useful action for each. Installing
 * (phase 3) opens `InstallPanel` (a lazy chunk) under the card; entries that cannot be installed
 * automatically say why and how to continue by hand. `ExploreResults` is hook-free so the web
 * tests can walk it as a VNode tree; `ExploreView` is the thin stateful shell.
 */
import type { McpCatalogItem, McpCatalogPage } from "@alisio/sdk";
import type { ComponentChildren, ComponentType } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { locale } from "../../../i18n/index.ts";
import { api, showToast } from "../../../store/app.ts";
import { ageLabel } from "../catalog-model.ts";
import type { InstallPanelProps } from "../mcp-install/InstallPanel.tsx";
import {
  actionKey,
  blockedReason,
  defaultScope,
  type Scope,
  scopeOptions,
  unsupportedKey,
} from "../mcp-install/model.ts";
import { ms } from "../mcp-install/strings.ts";
import styles from "../settings.module.css";
import { errorMessage, Pill, settingsWorkspace } from "../shared.tsx";
import css from "./explore.module.css";
import {
  DEFAULT_FILTERS,
  debounce,
  type ExploreFilters,
  type ExploreViewState,
  exploreView,
  filtersActive,
  pageRange,
  SEARCH_DEBOUNCE_MS,
  setFilter,
  toQueryString,
} from "./model.ts";
import { type ExploreStringKey, syncErrorText, xs } from "./strings.ts";

const when = (iso: string | undefined) =>
  iso
    ? new Date(iso).toLocaleString(locale.value, { dateStyle: "medium", timeStyle: "short" })
    : "";

function blockedText(item: McpCatalogItem): string | undefined {
  if (!item.blocked) return undefined;
  if (item.blocked.reason === "method_unsupported" && item.blocked.detail)
    return xs("blocked.methodDetail", { detail: item.blocked.detail });
  return xs(`blocked.${item.blocked.reason}` as ExploreStringKey);
}

/** What the cards need to offer installing; absent in tests that only walk the list. */
export interface InstallHooks {
  /** `name@version` of the card whose panel is open. */
  open?: string;
  onOpen: (item: McpCatalogItem) => void;
  /** The panel of the open card (rendered under it). */
  panel?: ComponentChildren;
  disabled?: boolean;
}

const cardKey = (item: McpCatalogItem) => `${item.name}@${item.version}`;

function Card(props: { item: McpCatalogItem; install?: InstallHooks }) {
  const { item, install } = props;
  const reason = blockedText(item);
  const open = install?.open === cardKey(item);
  const guidance =
    item.blocked?.reason === "method_unsupported" || item.blocked?.reason === "schema_unsupported"
      ? ms(unsupportedKey(blockedReason(item)))
      : undefined;
  return (
    <li class={css.card}>
      <div class={css.cardMain}>
        <h4 class={css.cardTitle}>{item.title ?? item.name}</h4>
        <p class={css.cardName}>{item.name}</p>
        {item.description ? <p class={css.desc}>{item.description}</p> : null}
        <div class={css.badges}>
          <Pill tone="off">{xs(`exec.${item.execution}` as ExploreStringKey)}</Pill>
          <span title={xs(`category.${item.category.method}` as ExploreStringKey)}>
            <Pill tone="off">{xs(`cat.${item.category.id}` as ExploreStringKey)}</Pill>
          </span>
          {item.status === "deprecated" ? <Pill tone="warn">{xs("status.deprecated")}</Pill> : null}
          {item.ready ? <Pill tone="ok">{xs("ready.yes")}</Pill> : null}
        </div>
        {reason ? <p class={css.reason}>{reason}</p> : null}
        {guidance ? <p class={css.reason}>{guidance}</p> : null}
        {open ? install?.panel : null}
      </div>
      {item.ready && install ? (
        <div class={css.install}>
          <button
            type="button"
            class={styles.secondary}
            disabled={install.disabled}
            aria-expanded={open}
            onClick={() => install.onOpen(item)}
          >
            {ms(actionKey(item.execution === "remote" ? "remote" : "local"))}
          </button>
        </div>
      ) : null}
    </li>
  );
}

export interface ExploreResultsProps {
  view: ExploreViewState;
  page?: McpCatalogPage;
  filters: ExploreFilters;
  error?: string;
  onSync: () => void;
  onRetry: () => void;
  onClear: () => void;
  onPage: (page: number) => void;
  install?: InstallHooks;
}

/** The body of Explore: a notice, then exactly one of the states or the list with its pager. */
export function ExploreResults(props: ExploreResultsProps) {
  const { view, page, filters } = props;
  const sync = page?.syncStatus;
  const action = (label: ExploreStringKey, onClick: () => void) => (
    <button type="button" class={styles.secondary} onClick={onClick}>
      {xs(label)}
    </button>
  );
  const noticeText =
    view.notice === "offline"
      ? xs("notice.offline", { date: when(sync?.lastSuccessAt) })
      : view.notice === "partial"
        ? xs("notice.partial", { date: when(sync?.lastSuccessAt) })
        : view.notice === "syncing"
          ? xs("notice.syncing")
          : view.notice === "skipped"
            ? xs("notice.skipped", { n: sync?.rejectedCount ?? 0 })
            : undefined;
  return (
    <>
      {noticeText ? (
        <div
          class={css.notice}
          data-tone={view.notice === "syncing" || view.notice === "skipped" ? "info" : "warn"}
          role="status"
        >
          <span>{noticeText}</span>
          {view.action === "sync" ? action("state.retry", props.onSync) : null}
        </div>
      ) : null}
      {view.body === "loading" ? (
        <p class={styles.note} role="status">
          {xs("state.loading")}
        </p>
      ) : null}
      {view.body === "error" ? (
        <div class={css.state} role="alert">
          <h4>{xs("state.errorTitle")}</h4>
          <p>{props.error ?? (sync?.lastError ? syncErrorText(sync.lastError.code) : "")}</p>
          {action("state.retry", view.action === "sync" ? props.onSync : props.onRetry)}
        </div>
      ) : null}
      {view.body === "empty-catalog" ? (
        <div class={css.state}>
          <h4>{xs("state.emptyTitle")}</h4>
          <p>{xs("state.emptyBody")}</p>
          {action("state.sync", props.onSync)}
        </div>
      ) : null}
      {view.body === "no-matches" ? (
        <div class={css.state}>
          <h4>{xs("state.noMatchTitle")}</h4>
          <p>{xs("state.noMatchBody")}</p>
          {filtersActive(filters) ? action("filter.clear", props.onClear) : null}
        </div>
      ) : null}
      {view.body === "list" && page ? (
        <CatalogList
          page={page}
          onPage={props.onPage}
          {...(props.install ? { install: props.install } : {})}
        />
      ) : null}
    </>
  );
}

function CatalogList(props: {
  page: McpCatalogPage;
  onPage: (page: number) => void;
  install?: InstallHooks;
}) {
  const { page } = props;
  const range = pageRange(page.page, page.pageSize, page.total);
  const to = range.from + page.items.length - 1;
  return (
    <>
      <p class={css.bar} role="status" aria-live="polite">
        <span>{xs("results.range", { from: range.from, to, total: page.total })}</span>
      </p>
      <ul class={css.cards} aria-label={xs("results.label")}>
        {page.items.map((item) => (
          <Card
            key={cardKey(item)}
            item={item}
            {...(props.install ? { install: props.install } : {})}
          />
        ))}
      </ul>
      {range.pages > 1 ? (
        <nav class={css.pager} aria-label={xs("page.label")}>
          <button
            type="button"
            class={styles.secondary}
            aria-label={xs("page.prev")}
            disabled={page.page <= 1}
            onClick={() => props.onPage(page.page - 1)}
          >
            ‹
          </button>
          <span>{xs("page.of", { page: page.page, pages: range.pages })}</span>
          <button
            type="button"
            class={styles.secondary}
            aria-label={xs("page.next")}
            disabled={page.page >= range.pages}
            onClick={() => props.onPage(page.page + 1)}
          >
            ›
          </button>
        </nav>
      ) : null}
    </>
  );
}

/** «Solo este proyecto» / «Todos mis proyectos» (SCP-01): one choice for every install on the page. */
export function ScopePicker(props: {
  workspaceName: string | undefined;
  value: Scope;
  onChange: (scope: Scope) => void;
}) {
  const options = scopeOptions(props.workspaceName);
  return (
    <fieldset class={css.scope}>
      <legend class={css.scopeLegend}>{ms("scope.label")}</legend>
      {options.map((option) => (
        <label key={option.id} class={css.scopeOption}>
          <input
            type="radio"
            name="mcp-install-scope"
            value={option.id}
            checked={props.value === option.id}
            onChange={() => props.onChange(option.id)}
          />
          <span>
            {ms(option.labelKey, option.params)}
            <small>{ms(option.hintKey)}</small>
          </span>
        </label>
      ))}
      {!props.workspaceName ? <p class={css.scopeNote}>{ms("scope.noProject")}</p> : null}
    </fieldset>
  );
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

// Filters survive switching tabs and reopening Settings during the session (UX-01).
let saved: ExploreFilters = DEFAULT_FILTERS;
let savedScope: Scope | undefined;

interface Loaded {
  page?: McpCatalogPage;
  error?: string;
  loading: boolean;
}

export function ExploreView() {
  const [filters, setFilters] = useState<ExploreFilters>(saved);
  const [typed, setTyped] = useState(saved.q);
  const [state, setState] = useState<Loaded>({ loading: true });
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const workspace = settingsWorkspace();
  const workspaceName = workspace ? baseName(workspace.path) : undefined;
  const [scope, setScopeState] = useState<Scope>(savedScope ?? defaultScope(!!workspace));
  const [openKey, setOpenKey] = useState<string | undefined>();
  const [Panel, setPanel] = useState<ComponentType<InstallPanelProps> | undefined>();
  const setScope = (next: Scope) => {
    savedScope = next;
    setScopeState(next);
  };
  const openItem = (item: McpCatalogItem) => {
    setOpenKey(openKey === cardKey(item) ? undefined : cardKey(item));
    if (!Panel)
      void import("../mcp-install/InstallPanel.tsx").then((m) => setPanel(() => m.InstallPanel));
  };
  const effectiveScope: Scope = workspaceName ? scope : "global";
  const where = ms(effectiveScope === "project" ? "scope.project" : "scope.global", {
    name: workspaceName ?? "",
  });
  const apply = (next: ExploreFilters) => {
    saved = next;
    setFilters(next);
  };
  const latest = useRef(filters);
  latest.current = filters;
  const query = toQueryString(filters);

  // One request per settled change; the previous page stays visible while the next one loads.
  useEffect(() => {
    let alive = true;
    setState((previous) => ({ ...previous, loading: true }));
    api.request<McpCatalogPage>("GET", `/api/mcp/catalog?${query}`).then(
      (page) => alive && setState({ page, loading: false }),
      (error: unknown) =>
        alive &&
        setState((previous) => ({ ...previous, error: errorMessage(error), loading: false })),
    );
    return () => {
      alive = false;
    };
  }, [query, nonce]);

  // While a background update runs, look again every two seconds.
  useEffect(() => {
    if (!state.page?.syncStatus.syncing) return;
    const timer = setTimeout(() => setNonce((n) => n + 1), 2000);
    return () => clearTimeout(timer);
  }, [state.page]);

  const search = useMemo(
    () => debounce((q: string) => apply(setFilter(latest.current, { q })), SEARCH_DEBOUNCE_MS),
    [],
  );
  useEffect(() => () => search.cancel(), [search]);

  const sync = async () => {
    setBusy(true);
    try {
      const status = await api.request<{ throttled?: boolean; nextSyncAllowedAt?: string }>(
        "POST",
        "/api/mcp/catalog/sync",
      );
      if (status.throttled && status.nextSyncAllowedAt)
        showToast(
          xs("results.throttled", {
            age: ageLabel(Date.parse(status.nextSyncAllowedAt), Date.now(), locale.value),
          }),
        );
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setBusy(false);
      setNonce((n) => n + 1);
    }
  };

  const view = exploreView({
    loading: state.loading,
    ...(state.error && !state.page ? { error: state.error } : {}),
    filters,
    ...(state.page ? { page: state.page } : {}),
  });
  const facets = state.page?.facets;
  const updated = state.page?.syncStatus.lastSuccessAt;
  const syncing = busy || !!state.page?.syncStatus.syncing;
  return (
    <section aria-labelledby="mcp-explore-lead">
      <p id="mcp-explore-lead" class={styles.lead}>
        {xs("explore.lead")}
      </p>
      <label class={styles.search}>
        <input
          type="search"
          value={typed}
          placeholder={xs("search.hint")}
          aria-label={xs("search.label")}
          onInput={(event) => {
            const value = (event.target as HTMLInputElement).value;
            setTyped(value);
            search.call(value);
          }}
        />
      </label>
      <ScopePicker workspaceName={workspaceName} value={effectiveScope} onChange={setScope} />
      <div class={css.filters}>
        <label class={css.field}>
          {xs("filter.category")}
          <select
            class={css.select}
            value={filters.category}
            onChange={(event) =>
              apply(setFilter(filters, { category: (event.target as HTMLSelectElement).value }))
            }
          >
            <option value="">{xs("filter.categoryAll")}</option>
            {(facets?.categories ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {xs(`cat.${c.id}` as ExploreStringKey)} ({c.count})
              </option>
            ))}
          </select>
        </label>
        <label class={css.field}>
          {xs("filter.execution")}
          <select
            class={css.select}
            value={filters.execution}
            onChange={(event) =>
              apply(
                setFilter(filters, {
                  execution: (event.target as HTMLSelectElement)
                    .value as ExploreFilters["execution"],
                }),
              )
            }
          >
            <option value="">{xs("filter.executionAll")}</option>
            <option value="local">{xs("exec.local")}</option>
            <option value="remote">{xs("exec.remote")}</option>
          </select>
        </label>
        <label class={css.check}>
          <input
            type="checkbox"
            checked={filters.ready}
            onChange={(event) =>
              apply(setFilter(filters, { ready: (event.target as HTMLInputElement).checked }))
            }
          />
          {xs("filter.ready")}
        </label>
        {filtersActive(filters) ? (
          <button
            type="button"
            class={styles.secondary}
            onClick={() => {
              setTyped("");
              search.cancel();
              apply(DEFAULT_FILTERS);
            }}
          >
            {xs("filter.clear")}
          </button>
        ) : null}
      </div>
      <div class={css.bar}>
        <span>
          {updated
            ? xs("results.updated", {
                age: ageLabel(Date.parse(updated), Date.now(), locale.value),
              })
            : xs("results.neverUpdated")}
        </span>
        <button
          type="button"
          class={styles.secondary}
          disabled={syncing}
          onClick={() => void sync()}
        >
          {syncing ? xs("results.updating") : xs("results.update")}
        </button>
      </div>
      <ExploreResults
        view={view}
        filters={filters}
        {...(state.page ? { page: state.page } : {})}
        {...(state.error ? { error: state.error } : {})}
        onSync={() => void sync()}
        onRetry={() => setNonce((n) => n + 1)}
        onClear={() => {
          setTyped("");
          apply(DEFAULT_FILTERS);
        }}
        onPage={(page) => apply(setFilter(filters, { page }))}
        install={{
          ...(openKey ? { open: openKey } : {}),
          onOpen: openItem,
          disabled: !workspace,
          panel:
            Panel && openKey
              ? (() => {
                  const item = state.page?.items.find((i) => cardKey(i) === openKey);
                  return item ? (
                    <Panel
                      key={`${openKey}|${effectiveScope}`}
                      item={item}
                      scope={effectiveScope}
                      workspace={
                        workspace && workspaceName
                          ? { id: workspace.id, name: workspaceName }
                          : undefined
                      }
                      where={where}
                      onClose={() => setOpenKey(undefined)}
                      onChooseGlobal={() => setScope("global")}
                    />
                  ) : null;
                })()
              : undefined,
        }}
      />
    </section>
  );
}
