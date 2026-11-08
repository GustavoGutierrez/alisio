/**
 * Settings → Plugins → Plugin catalog: search, category and tag filters, optional grouping by
 * category, ten compact rows per page (icon, name, one-line description, action button), and a
 * detail panel in the same tab. The list state lives in a reducer next to the open detail, so Back
 * returns to the same search, filters and page.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";
import { locale } from "../../i18n/index.ts";
import { Icon } from "../icons.tsx";
import { CatalogDetail } from "./CatalogDetail.tsx";
import {
  ageLabel,
  type CatalogPluginView,
  catalogNav,
  filterCatalog,
  groupByCategory,
  INITIAL_NAV,
  type InstallTarget,
  orderByCategory,
  type PluginCatalogView,
  pageNumbers,
  paginate,
  rowAction,
  sortCatalog,
  tagCounts,
  truncateDescription,
} from "./catalog-model.ts";
import { ActionIcon, actionText, PluginIcon } from "./catalog-parts.tsx";
import { cs } from "./catalog-strings.ts";
import { useInstallFlow, useUninstallFlow } from "./InstallFlow.tsx";
import { working } from "./plugin-ops.ts";
import styles from "./settings.module.css";
import { type Loaded, Pill, SearchBox } from "./shared.tsx";

const TOP_TAGS = 8;

/** One compact row: icon, name, one-line description and the action as an icon button. */
function CatalogRow(props: {
  plugin: CatalogPluginView;
  sdkVersion?: string;
  onOpen: (slug: string) => void;
  onAsk: (target: InstallTarget) => void;
}) {
  const { plugin } = props;
  const action = rowAction(plugin, working.value);
  const text = actionText(plugin, action, props.sdkVersion);
  const descId = `row-desc-${plugin.slug}`;
  const badge =
    action.kind === "installing"
      ? undefined
      : action.kind === "incompatible"
        ? { tone: "danger" as const, text: cs("action.incompatible") }
        : plugin.installedVersion
          ? plugin.updateAvailable
            ? { tone: "warn" as const, text: cs("update.button") }
            : { tone: "ok" as const, text: cs("action.installed") }
          : undefined;
  return (
    <li class={styles.row} aria-busy={action.kind === "installing" || undefined}>
      <button
        type="button"
        class={styles.rowMain}
        data-slug={plugin.slug}
        title={plugin.description}
        aria-label={cs("row.open", { name: plugin.name })}
        aria-describedby={descId}
        onClick={() => props.onOpen(plugin.slug)}
      >
        <PluginIcon icon={plugin.icon} />
        <span class={styles.rowText}>
          <span class={styles.rowName}>
            <span class={styles.rowNameText}>{plugin.name}</span>
            {badge ? (
              <span class={styles.rowBadge} data-tone={badge.tone}>
                {badge.text}
              </span>
            ) : null}
          </span>
          <span class={styles.rowDesc} aria-hidden="true">
            {truncateDescription(plugin.description)}
          </span>
          <span id={descId} class={styles.srOnly}>
            {plugin.description}
          </span>
        </span>
      </button>
      <button
        type="button"
        class={styles.rowAction}
        data-kind={action.kind}
        disabled={action.disabled}
        title={text.reason ? `${text.label}: ${text.reason}` : text.label}
        aria-label={text.aria}
        onClick={() => action.mode && props.onAsk(rowTarget(plugin, action.mode))}
      >
        <ActionIcon kind={action.kind} />
      </button>
    </li>
  );
}

const rowTarget = (plugin: CatalogPluginView, mode: InstallTarget["mode"]): InstallTarget => ({
  package: plugin.package,
  name: plugin.name,
  version: plugin.version,
  ...(plugin.icon ? { icon: plugin.icon } : {}),
  ...(plugin.installedVersion ? { installedVersion: plugin.installedVersion } : {}),
  mode,
});

function Skeletons() {
  return (
    <ul class={styles.catalogGrid} aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <li key={index} class={styles.row} data-skeleton="true">
          <span class={styles.skeletonIcon} />
          <span class={styles.skeletonLines}>
            <span class={styles.skeletonLine} />
            <span class={styles.skeletonLine} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function PluginCatalog(props: {
  data: Loaded<PluginCatalogView>;
  checking: boolean;
  onCheck: () => void;
  onChanged: () => void;
}) {
  const { data } = props;
  const [nav, dispatch] = useReducer(catalogNav, INITIAL_NAV);
  const { query, category, tags, group, page } = nav.list;
  const [text, setText] = useState(query);
  const [moreTags, setMoreTags] = useState(false);
  const flow = useInstallFlow(props.onChanged);
  const removal = useUninstallFlow(props.onChanged);
  const listRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<string | undefined>();

  useEffect(() => {
    if (text === query) return;
    const timer = setTimeout(() => dispatch({ type: "filter", patch: { query: text } }), 200);
    return () => clearTimeout(timer);
  }, [text, query]);
  // Back from the detail: put the focus on the row that was opened.
  useEffect(() => {
    if (nav.detail !== undefined || !returnTo.current) return;
    const slug = returnTo.current;
    returnTo.current = undefined;
    for (const button of listRef.current?.querySelectorAll<HTMLElement>("[data-slug]") ?? [])
      if (button.dataset.slug === slug) button.focus();
  }, [nav.detail]);

  const catalog = data.data?.catalog;
  const filtered = useMemo(() => {
    if (!catalog) return [];
    const matches = filterCatalog(catalog.plugins, {
      query,
      ...(category ? { category } : {}),
      tags,
    });
    return group ? orderByCategory(matches, catalog.categories) : sortCatalog(matches);
  }, [catalog, query, category, tags.join("|"), group]);
  const view = paginate(filtered, page);
  const allTags = useMemo(() => tagCounts(catalog?.plugins ?? []), [catalog]);
  const shownTags = moreTags ? allTags : allTags.slice(0, TOP_TAGS);
  const filtering = !!query || !!category || tags.length > 0;
  const meta = data.data?.meta;
  const toggleTag = (tag: string) =>
    dispatch({
      type: "filter",
      patch: { tags: tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag] },
    });

  const detailPlugin = nav.detail
    ? catalog?.plugins.find((plugin) => plugin.slug === nav.detail)
    : undefined;
  if (detailPlugin)
    return (
      <div class={styles.catalogPage}>
        <CatalogDetail
          plugin={detailPlugin}
          {...(data.data?.sdkVersion ? { sdkVersion: data.data.sdkVersion } : {})}
          onBack={() => dispatch({ type: "back" })}
          onAsk={flow.ask}
          onUninstall={removal.ask}
        />
        {flow.dialog}
        {removal.dialog}
      </div>
    );

  if (data.error && !data.data)
    return (
      <div class={styles.errorPanel} role="alert">
        <p>{cs("catalog.offlineError", { message: data.error })}</p>
        <button type="button" class={styles.primaryButton} onClick={() => data.reload()}>
          {cs("catalog.retry")}
        </button>
      </div>
    );

  return (
    <div class={styles.catalogPage} ref={listRef}>
      <p class={styles.note}>{cs("catalog.lead")}</p>
      <div class={styles.catalogBar}>
        <SearchBox value={text} label={cs("catalog.search")} onInput={setText} />
        <button
          type="button"
          class={styles.ghostButton}
          disabled={props.checking}
          aria-busy={props.checking || undefined}
          onClick={props.onCheck}
        >
          {props.checking ? (
            <span class={styles.spinner} aria-hidden="true" />
          ) : (
            <Icon name="refresh" size={15} />
          )}
          {props.checking ? cs("catalog.checking") : cs("catalog.check")}
        </button>
      </div>
      <p class={styles.statusLine} aria-live="polite">
        {meta ? (
          <>
            {cs("catalog.checked", { age: ageLabel(meta.checkedAt, Date.now(), locale.value) })}
            {" · "}
            {meta.offline
              ? cs("catalog.offline")
              : meta.fromCache
                ? cs("catalog.cached")
                : cs("catalog.live")}
            {meta.stale && meta.offline ? ` · ${cs("catalog.stale")}` : ""}
          </>
        ) : (
          cs("catalog.neverChecked")
        )}
      </p>
      <div class={styles.filters}>
        <label class={styles.selectLabel}>
          <span>{cs("catalog.category")}</span>
          <select
            value={category ?? ""}
            onChange={(event) =>
              dispatch({
                type: "filter",
                patch: { category: (event.target as HTMLSelectElement).value || undefined },
              })
            }
          >
            <option value="">
              {cs("catalog.categoryAll", { n: catalog?.plugins.length ?? 0 })}
            </option>
            {(catalog?.categories ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.id} ({item.count})
              </option>
            ))}
          </select>
        </label>
        <label class={styles.checkLine}>
          <input
            type="checkbox"
            checked={group}
            onChange={(event) =>
              dispatch({
                type: "filter",
                patch: { group: (event.target as HTMLInputElement).checked },
              })
            }
          />
          <span>{cs("catalog.group")}</span>
        </label>
        {filtering ? (
          <button
            type="button"
            class={styles.inlineLink}
            onClick={() => {
              setText("");
              dispatch({ type: "clear" });
            }}
          >
            {cs("catalog.clearFilters")}
          </button>
        ) : null}
      </div>
      {allTags.length ? (
        <div class={styles.tagRow} role="group" aria-label={cs("catalog.tags")}>
          {shownTags.map(({ tag, count }) => (
            <button
              key={tag}
              type="button"
              class={styles.tagChip}
              aria-pressed={tags.includes(tag)}
              onClick={() => toggleTag(tag)}
            >
              {tag} <span>{count}</span>
            </button>
          ))}
          {allTags.length > TOP_TAGS ? (
            <button
              type="button"
              class={styles.inlineLink}
              aria-expanded={moreTags}
              onClick={() => setMoreTags(!moreTags)}
            >
              {moreTags ? cs("catalog.tagsLess") : cs("catalog.tagsMore")}
            </button>
          ) : null}
        </div>
      ) : null}
      <p class={styles.resultCount} role="status" aria-live="polite">
        {data.loading && !data.data
          ? cs("catalog.loading")
          : view.total
            ? cs("catalog.results", { from: view.from, to: view.to, total: view.total })
            : catalog && !catalog.plugins.length
              ? cs("catalog.empty")
              : cs("catalog.resultsNone")}
      </p>
      {data.loading && !data.data ? <Skeletons /> : null}
      {(group ? groupByCategory(view.items) : [{ category: "", plugins: view.items }]).map(
        (section) => (
          <section key={section.category} aria-label={section.category || undefined}>
            {group ? <h4 class={styles.groupTitle}>{section.category}</h4> : null}
            <ul class={styles.catalogGrid} aria-label={cs("row.list")}>
              {section.plugins.map((plugin) => (
                <CatalogRow
                  key={plugin.slug}
                  plugin={plugin}
                  {...(data.data?.sdkVersion ? { sdkVersion: data.data.sdkVersion } : {})}
                  onOpen={(slug) => {
                    returnTo.current = slug;
                    dispatch({ type: "open", slug });
                  }}
                  onAsk={flow.ask}
                />
              ))}
            </ul>
          </section>
        ),
      )}
      {view.pages > 1 ? (
        <nav class={styles.pager} aria-label={cs("catalog.pagination")}>
          <button
            type="button"
            class={styles.ghostButton}
            disabled={view.page <= 1}
            onClick={() => dispatch({ type: "page", page: view.page - 1 })}
          >
            {cs("catalog.prev")}
          </button>
          {pageNumbers(view.page, view.pages).map((n, index) =>
            n === "…" ? (
              <span key={`gap-${index}`} class={styles.pagerGap} aria-hidden="true">
                …
              </span>
            ) : (
              <button
                key={n}
                type="button"
                class={styles.pageButton}
                aria-current={n === view.page ? "page" : undefined}
                aria-label={
                  n === view.page ? cs("catalog.pageCurrent", { n }) : cs("catalog.page", { n })
                }
                onClick={() => dispatch({ type: "page", page: n })}
              >
                {n}
              </button>
            ),
          )}
          <button
            type="button"
            class={styles.ghostButton}
            disabled={view.page >= view.pages}
            onClick={() => dispatch({ type: "page", page: view.page + 1 })}
          >
            {cs("catalog.next")}
          </button>
        </nav>
      ) : null}
      {flow.dialog}
      {removal.dialog}
    </div>
  );
}
