/**
 * The Memory tab: what the memory plugin holds for the open chat (saved memories, the session
 * summary and the context loaded at the start), read-only through the plugin's data views. Its own
 * lazy chunk (see `app.tsx`): the controller, texts and styles load the first time the tab opens.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { Markdown } from "../../markdown/view.tsx";
import { api, currentId } from "../../store/app.ts";
import {
  createMemoryController,
  type MemoryEntry,
  memoryViewUrl,
  type RecordsState,
  type SectionState,
} from "../../store/memory.ts";
import { Icon } from "../icons.tsx";
import styles from "./memory.module.css";
import { type MemoryStringKey, tm } from "./strings.ts";

const memory = createMemoryController((sessionId, view, params, signal) =>
  api.request("GET", memoryViewUrl(sessionId, view, params), undefined, { signal }),
);
const TYPES = [
  "decision",
  "bugfix",
  "discovery",
  "pattern",
  "architecture",
  "config",
  "preference",
  "learning",
] as const;
const KNOWN_TYPES = new Set<string>(TYPES);
const SEARCH_DELAY_MS = 300;
/** Text longer than this (characters or lines) starts collapsed behind a "Show more" button. */
const CLAMP_CHARS = 320;
const CLAMP_LINES = 6;

const when = (ms: number) => (ms ? new Date(ms).toLocaleString() : "—");
const isLong = (text: string) => text.length > CLAMP_CHARS || text.split("\n").length > CLAMP_LINES;

function Skeleton() {
  return (
    <div class={styles.skeleton} role="status" aria-label={tm("loading")}>
      <span />
      <span />
      <span />
    </div>
  );
}

function Failed(props: { message?: string | undefined; label: string; onRetry: () => void }) {
  return (
    <div class={styles.error} role="alert">
      <p>
        {props.label}
        {props.message ? <span class={styles.errorDetail}> {props.message}</span> : null}
      </p>
      <button type="button" class={styles.button} onClick={props.onRetry}>
        {tm("retry")}
      </button>
    </div>
  );
}

/** Markdown clamped to a few lines with a Show more / Show less button. */
function Expandable(props: { id: string; text: string }) {
  const [open, setOpen] = useState(false);
  const long = isLong(props.text);
  return (
    <>
      <div id={props.id} class={styles.body} data-clamped={long && !open ? "true" : undefined}>
        <Markdown text={props.text} />
      </div>
      {long ? (
        <button
          type="button"
          class={styles.link}
          aria-expanded={open}
          aria-controls={props.id}
          onClick={() => setOpen(!open)}
        >
          {open ? tm("collapse") : tm("expand")}
        </button>
      ) : null}
    </>
  );
}

function Entry({ entry }: { entry: MemoryEntry }) {
  const [details, setDetails] = useState(false);
  const typeLabel = KNOWN_TYPES.has(entry.type)
    ? tm(`type.${entry.type}` as MemoryStringKey)
    : entry.type;
  return (
    <li class={styles.entry} data-pinned={entry.pinned ? "true" : undefined}>
      <div class={styles.entryHead}>
        <span class={styles.kind}>{typeLabel}</span>
        {entry.pinned ? (
          <span class={styles.pin}>
            <Icon name="pin" size={13} />
            {tm("pinned")}
          </span>
        ) : null}
        <h4 class={styles.entryTitle}>{entry.title}</h4>
      </div>
      <Expandable id={`memory-entry-${entry.id}`} text={entry.content} />
      {entry.contentTruncated ? <p class={styles.note}>{tm("shortened")}</p> : null}
      <p class={styles.meta}>
        <span>
          {entry.updatedAt
            ? tm("updated", { time: when(entry.updatedAt) })
            : tm("created", { time: when(entry.createdAt) })}
        </span>
        {entry.source ? <span>{tm("source", { source: entry.source })}</span> : null}
        <span>{entry.scope === "personal" ? tm("scopePersonal") : tm("scopeProject")}</span>
        {entry.topicKey ? <code>{entry.topicKey}</code> : null}
      </p>
      <button
        type="button"
        class={styles.link}
        aria-expanded={details}
        aria-controls={`memory-json-${entry.id}`}
        onClick={() => setDetails(!details)}
      >
        {details ? tm("hideDetails") : tm("details")}
      </button>
      {details ? (
        <pre id={`memory-json-${entry.id}`} class={styles.json}>
          {JSON.stringify(entry, null, 2)}
        </pre>
      ) : null}
    </li>
  );
}

function Filters(props: { type: string; query: string }) {
  const [text, setText] = useState(props.query);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => memory.setQuery(text), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <div class={styles.filters}>
      <label class={styles.field}>
        <span>{tm("filterType")}</span>
        <select
          value={props.type}
          onChange={(event) => memory.setType((event.target as HTMLSelectElement).value)}
        >
          <option value="">{tm("allTypes")}</option>
          {TYPES.map((type) => (
            <option key={type} value={type}>
              {tm(`type.${type}` as MemoryStringKey)}
            </option>
          ))}
        </select>
      </label>
      <label class={`${styles.field} ${styles.grow}`}>
        <span>{tm("search")}</span>
        <input
          type="search"
          value={text}
          maxLength={200}
          placeholder={tm("searchPlaceholder")}
          onInput={(event) => setText((event.target as HTMLInputElement).value)}
        />
      </label>
    </div>
  );
}

function Saved(props: { records: RecordsState; type: string; query: string }) {
  const { records } = props;
  const filtered = !!props.type || !!props.query;
  return (
    <section class={styles.section} aria-labelledby="memory-saved">
      <h3 id="memory-saved" class={styles.heading}>
        {tm("savedTitle")}
        {records.status === "ready" && records.total !== undefined ? (
          <span class={styles.count}>
            {tm("count", { shown: records.items.length, total: records.total })}
          </span>
        ) : null}
      </h3>
      <p class={styles.hint}>{tm("savedHint")}</p>
      {records.status === "error" ? (
        <Failed
          label={tm("error")}
          message={records.error}
          onRetry={() => memory.retry("records")}
        />
      ) : records.status === "loading" ? (
        <Skeleton />
      ) : (
        <>
          {records.items.length || filtered ? (
            <Filters type={props.type} query={props.query} />
          ) : null}
          {records.items.length ? (
            <ul class={styles.list}>
              {records.items.map((entry) => (
                <Entry key={entry.id} entry={entry} />
              ))}
            </ul>
          ) : (
            <p class={styles.muted}>{filtered ? tm("noResults") : tm("savedEmpty")}</p>
          )}
          {records.loadMoreError ? (
            <Failed
              label={tm("loadMoreError")}
              message={records.loadMoreError}
              onRetry={memory.loadMore}
            />
          ) : null}
          {records.next ? (
            <button
              type="button"
              class={styles.button}
              disabled={records.loadingMore}
              onClick={memory.loadMore}
            >
              {records.loadingMore ? tm("loading") : tm("loadMore")}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function TextSection(props: {
  id: string;
  title: string;
  hint?: string;
  empty: string;
  stamp: "updated" | "loadedAt";
  state: SectionState;
  onRetry: () => void;
}) {
  const { state } = props;
  return (
    <section class={styles.section} aria-labelledby={props.id}>
      <h3 id={props.id} class={styles.heading}>
        {props.title}
      </h3>
      {props.hint ? <p class={styles.hint}>{props.hint}</p> : null}
      {state.status === "loading" ? (
        <Skeleton />
      ) : state.status === "error" ? (
        <Failed label={tm("error")} message={state.error} onRetry={props.onRetry} />
      ) : state.value ? (
        <>
          <Expandable id={`${props.id}-body`} text={state.value.content} />
          {state.value.truncated ? <p class={styles.note}>{tm("shortened")}</p> : null}
          <p class={styles.meta}>
            <span>{tm(props.stamp, { time: when(state.value.at) })}</span>
          </p>
        </>
      ) : (
        <p class={styles.muted}>{props.empty}</p>
      )}
    </section>
  );
}

function Body(props: { id: string }) {
  useEffect(() => {
    memory.open(props.id);
    return () => memory.close();
  }, [props.id]);
  const state = memory.state.value;
  // Never paint another chat's data for a frame while the controller switches over.
  if (state.sessionId !== props.id) return <Skeleton />;
  const { records, summary, context } = state;
  const allReady =
    records.status === "ready" && summary.status === "ready" && context.status === "ready";
  const nothing =
    allReady &&
    !records.items.length &&
    !state.type &&
    !state.query &&
    !summary.value &&
    !context.value;
  return (
    <>
      <div class={styles.top}>
        <p class={styles.lead}>{tm("lead")}</p>
        <button type="button" class={styles.button} onClick={memory.refresh}>
          <Icon name="refresh" size={14} />
          {tm("refresh")}
        </button>
      </div>
      {nothing ? (
        <p class={styles.empty}>{tm("empty")}</p>
      ) : (
        <>
          <Saved records={records} type={state.type} query={state.query} />
          <TextSection
            id="memory-summary"
            title={tm("summaryTitle")}
            empty={tm("summaryEmpty")}
            stamp="updated"
            state={summary}
            onRetry={() => memory.retry("summary")}
          />
          <TextSection
            id="memory-context"
            title={tm("contextTitle")}
            hint={tm("contextHint")}
            empty={tm("contextEmpty")}
            stamp="loadedAt"
            state={context}
            onRetry={() => memory.retry("context")}
          />
        </>
      )}
    </>
  );
}

export function MemoryTab() {
  const id = currentId.value;
  return (
    <section class={styles.tab} aria-label={tm("title")}>
      {id ? <Body key={id} id={id} /> : null}
    </section>
  );
}
