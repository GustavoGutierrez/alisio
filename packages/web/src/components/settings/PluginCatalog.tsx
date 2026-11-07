/**
 * Settings → Plugins → Plugin catalog: search, category and tag filters, optional grouping by
 * category, ten cards per page with lazy cover images, and one-click install/update.
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import { locale } from "../../i18n/index.ts";
import { Icon } from "../icons.tsx";
import {
  actionState,
  ageLabel,
  type CatalogPluginView,
  filterCatalog,
  groupByCategory,
  type InstallTarget,
  orderByCategory,
  type PluginCatalogView,
  pageNumbers,
  paginate,
  sortCatalog,
  tagCounts,
} from "./catalog-model.ts";
import { cs } from "./catalog-strings.ts";
import { useInstallFlow } from "./InstallFlow.tsx";
import { working } from "./plugin-ops.ts";
import styles from "./settings.module.css";
import { type Loaded, Pill, SearchBox } from "./shared.tsx";

const TOP_TAGS = 8;

function Cover(props: { plugin: CatalogPluginView }) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">(
    props.plugin.cover ? "loading" : "failed",
  );
  return (
    <div class={styles.cover} data-state={state}>
      {props.plugin.cover && state !== "failed" ? (
        <img
          src={props.plugin.cover}
          alt=""
          width={320}
          height={180}
          loading="lazy"
          decoding="async"
          onLoad={() => setState("loaded")}
          onError={() => setState("failed")}
        />
      ) : null}
      {state === "failed" ? (
        <span class={styles.coverFallback} aria-hidden="true">
          {props.plugin.name.slice(0, 1).toUpperCase()}
        </span>
      ) : null}
    </div>
  );
}

function ExternalLink(props: { href: string; children: string }) {
  return (
    <a href={props.href} target="_blank" rel="noopener noreferrer" class={styles.link}>
      {props.children}
      <span class={styles.srOnly}> ({cs("card.external")})</span>
    </a>
  );
}

/** `inert` keeps the hidden face out of the tab order and away from assistive tech. */
const inert = (on: boolean) => (on ? { inert: true } : {});

/**
 * A card that flips: the front is the cover with the name and a short description over it, the
 * back has the full text, links and the install/update action. The flip is a button (Enter, Space,
 * Escape to return); with reduced motion the faces swap without rotating.
 */
function CatalogCard(props: {
  plugin: CatalogPluginView;
  sdkVersion?: string;
  onAsk: (target: InstallTarget) => void;
}) {
  const { plugin } = props;
  const [flipped, setFlipped] = useState(false);
  const state = actionState(plugin, working.value);
  const target = (mode: InstallTarget["mode"]): InstallTarget => ({
    package: plugin.package,
    name: plugin.name,
    version: plugin.version,
    ...(plugin.installedVersion ? { installedVersion: plugin.installedVersion } : {}),
    mode,
  });
  const reason =
    state.kind === "incompatible"
      ? cs("action.incompatibleReason", { range: plugin.sdk ?? "?", sdk: props.sdkVersion ?? "?" })
      : state.busy && !state.reinstall
        ? cs("action.busy")
        : undefined;
  const reasonId = `reason-${plugin.slug}`;
  const backId = `back-${plugin.slug}`;
  const installed = plugin.installedVersion ?? "";
  const badge =
    state.kind === "installed"
      ? { tone: "ok" as const, text: cs("action.installed"), icon: true }
      : state.kind === "update"
        ? { tone: "warn" as const, text: cs("update.button"), icon: false }
        : state.kind === "incompatible"
          ? { tone: "danger" as const, text: cs("action.incompatible"), icon: false }
          : state.kind === "installing"
            ? { tone: "off" as const, text: cs("action.installing"), icon: false }
            : undefined;
  return (
    <li
      class={styles.flipCard}
      data-flipped={flipped}
      aria-busy={state.kind === "installing" || undefined}
    >
      <div class={styles.flipInner}>
        <div class={styles.faceFront} {...inert(flipped)} aria-hidden={flipped || undefined}>
          <Cover plugin={plugin} />
          <div class={styles.frontShade} />
          {badge ? (
            <span class={styles.frontBadge} data-tone={badge.tone}>
              {badge.icon ? <Icon name="check" size={13} /> : null}
              {badge.text}
            </span>
          ) : null}
          <div class={styles.frontText}>
            <h5 class={styles.frontName}>{plugin.name}</h5>
            <p class={styles.frontDesc}>{plugin.description}</p>
          </div>
          <button
            type="button"
            class={styles.flipHit}
            aria-expanded={flipped}
            aria-controls={backId}
            aria-label={cs("card.details", { name: plugin.name })}
            onClick={() => setFlipped(true)}
          />
        </div>
        <div
          id={backId}
          class={styles.faceBack}
          {...inert(!flipped)}
          aria-hidden={!flipped || undefined}
          onKeyDown={(event) => {
            if (event.key === "Escape" && flipped) {
              event.stopPropagation();
              setFlipped(false);
            }
          }}
        >
          <div class={styles.backHead}>
            <div>
              <h5 class={styles.catalogName}>{plugin.name}</h5>
              <span class={styles.version}>{cs("card.version", { version: plugin.version })}</span>
            </div>
            <button
              type="button"
              class={styles.iconButton}
              aria-label={cs("card.back")}
              title={cs("card.back")}
              onClick={() => setFlipped(false)}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
          <div class={styles.backScroll}>
            <p class={styles.catalogText}>{plugin.description}</p>
            <ul class={styles.chips} aria-label={cs("card.categories")}>
              {plugin.categories.map((category) => (
                <li key={category}>
                  <Pill tone="off">{category}</Pill>
                </li>
              ))}
            </ul>
            <ul class={styles.tagList} aria-label={cs("card.tagsLabel")}>
              {plugin.tags.slice(0, 5).map((tag) => (
                <li key={tag}>#{tag}</li>
              ))}
            </ul>
            <p class={styles.catalogMeta}>
              {[
                plugin.author ? cs("card.by", { author: plugin.author }) : "",
                plugin.license ?? "",
                plugin.sdk ? `sdk ${plugin.sdk}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <span class={styles.links}>
              {plugin.npmUrl ? (
                <ExternalLink href={plugin.npmUrl}>{cs("card.npm")}</ExternalLink>
              ) : null}
              {plugin.repository ? (
                <ExternalLink href={plugin.repository}>{cs("card.repository")}</ExternalLink>
              ) : null}
              {plugin.homepage && plugin.homepage !== plugin.repository ? (
                <ExternalLink href={plugin.homepage}>{cs("card.homepage")}</ExternalLink>
              ) : null}
            </span>
            {reason ? (
              <p id={reasonId} class={styles.diagnostic}>
                {reason}
              </p>
            ) : null}
          </div>
          <div class={styles.backFoot}>
            {state.kind === "installed" ? (
              <span
                class={styles.installedMark}
                title={cs("action.installedNamed", { name: plugin.name, version: installed })}
              >
                <Icon name="check" size={15} />
                {cs("action.installed")}
              </span>
            ) : null}
            {state.reinstall ? (
              <button
                type="button"
                class={styles.ghostButton}
                disabled={state.busy}
                aria-label={cs("action.reinstallNamed", { name: plugin.name })}
                onClick={() => props.onAsk(target("reinstall"))}
              >
                {cs("action.reinstall")}
              </button>
            ) : null}
            {state.kind !== "installed" ? (
              <button
                type="button"
                class={state.kind === "downgrade" ? styles.ghostButton : styles.primaryButton}
                disabled={state.disabled}
                aria-describedby={reason ? reasonId : undefined}
                aria-label={
                  state.kind === "installing"
                    ? cs("action.installingNamed", { name: plugin.name })
                    : state.kind === "update"
                      ? cs("action.updateFromNamed", {
                          name: plugin.name,
                          from: installed,
                          to: plugin.version,
                        })
                      : state.kind === "downgrade"
                        ? cs("action.downgradeNamed", {
                            name: plugin.name,
                            from: installed,
                            to: plugin.version,
                          })
                        : state.kind === "incompatible"
                          ? cs("action.incompatible")
                          : cs("action.installNamed", { name: plugin.name })
                }
                onClick={() =>
                  props.onAsk(
                    target(
                      state.kind === "update"
                        ? "update"
                        : state.kind === "downgrade"
                          ? "downgrade"
                          : "install",
                    ),
                  )
                }
              >
                {state.kind === "installing" ? (
                  <>
                    <span class={styles.spinner} aria-hidden="true" />
                    {cs("action.installing")}
                  </>
                ) : state.kind === "update" ? (
                  cs("action.updateFrom", { from: installed, to: plugin.version })
                ) : state.kind === "downgrade" ? (
                  cs("action.downgrade", { from: installed, to: plugin.version })
                ) : state.kind === "incompatible" ? (
                  cs("action.incompatible")
                ) : (
                  cs("action.install")
                )}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}

function Skeletons() {
  return (
    <ul class={styles.catalogGrid} aria-hidden="true">
      {Array.from({ length: 4 }, (_, index) => (
        <li key={index} class={styles.flipCard} data-skeleton="true">
          <div
            class={styles.cover}
            data-state="loading"
            style={{ position: "absolute", inset: 0 }}
          />
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
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | undefined>();
  const [tags, setTags] = useState<string[]>([]);
  const [moreTags, setMoreTags] = useState(false);
  const [group, setGroup] = useState(false);
  const [page, setPage] = useState(1);
  const flow = useInstallFlow(props.onChanged);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text), 200);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => setPage(1), [query, category, tags.join("|"), group]);

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
    setTags((current) =>
      current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag],
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
    <div class={styles.catalogPage}>
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
              setCategory((event.target as HTMLSelectElement).value || undefined)
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
            onChange={(event) => setGroup((event.target as HTMLInputElement).checked)}
          />
          <span>{cs("catalog.group")}</span>
        </label>
        {filtering ? (
          <button
            type="button"
            class={styles.inlineLink}
            onClick={() => {
              setText("");
              setQuery("");
              setCategory(undefined);
              setTags([]);
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
            <ul class={styles.catalogGrid}>
              {section.plugins.map((plugin) => (
                <CatalogCard
                  key={plugin.slug}
                  plugin={plugin}
                  {...(data.data?.sdkVersion ? { sdkVersion: data.data.sdkVersion } : {})}
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
            onClick={() => setPage(view.page - 1)}
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
                onClick={() => setPage(n)}
              >
                {n}
              </button>
            ),
          )}
          <button
            type="button"
            class={styles.ghostButton}
            disabled={view.page >= view.pages}
            onClick={() => setPage(view.page + 1)}
          >
            {cs("catalog.next")}
          </button>
        </nav>
      ) : null}
      {flow.dialog}
    </div>
  );
}
