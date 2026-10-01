/**
 * SpreadsheetView (spec §17.5): a virtualized, keyboard-navigable table over a dataset. Fixed
 * 28 px rows and absolutely placed cells, so only the visible rows and columns exist in the DOM;
 * pages of 200 rows come from the keyset-paginated rows API through a 20-page LRU cache (no
 * duplicates or gaps while sorting). Sorting by header, a column filter, resizable columns
 * (pointer and keyboard), cell and row copy, and the sheet selector. The pure logic is in
 * `util/spreadsheet.ts`.
 */
import type { DatasetDetailWire, DatasetRowsPage } from "@alisio/sdk";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { api, showToast } from "../../store/app.ts";
import { copyText } from "../../util/clipboard.ts";
import {
  ariaSort,
  type Cell,
  cellValueText,
  clampColumnWidth,
  columnWidthStep,
  DEFAULT_COLUMN_WIDTH,
  type GridView,
  LruCache,
  MAX_OFFSET,
  moveCell,
  nextSort,
  PAGE_SIZE,
  pagesFor,
  planPage,
  ROW_HEIGHT,
  rowsLabel,
  rowText,
  scrollToRow,
  viewKey,
  visibleRange,
} from "../../util/spreadsheet.ts";
import { Icon } from "../icons.tsx";
import styles from "./spreadsheet.module.css";

/** Width of the sticky row-number column (px). */
const ROW_NUMBER_WIDTH = 64;

interface Loaded {
  page: DatasetRowsPage;
}

export function SpreadsheetView(props: {
  datasetId: string;
  /** Name shown in accessible labels. */
  name: string;
  /** Link of the original file, when there is one. */
  downloadHref?: string;
}) {
  const { datasetId } = props;
  const [detail, setDetail] = useState<DatasetDetailWire>();
  const [failure, setFailure] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<GridView>({ sheet: "" });
  const [filterText, setFilterText] = useState("");
  const [filterColumn, setFilterColumn] = useState<string>();
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [scroll, setScroll] = useState({ top: 0, left: 0, width: 600, height: 400 });
  const [active, setActive] = useState<Cell>({ row: 0, col: 0 });
  const [version, setVersion] = useState(0);
  const [counts, setCounts] = useState<{ matched?: number; interactive: boolean }>({
    interactive: true,
  });
  const [pageError, setPageError] = useState<string>();
  const scroller = useRef<HTMLDivElement>(null);
  const cache = useRef(new LruCache<Loaded>());
  const inflight = useRef(new Map<number, Promise<void>>());
  const generation = useRef(0);
  const pendingFocus = useRef<Cell | undefined>(undefined);
  const raf = useRef(0);

  // The dataset's schema and statistics.
  useEffect(() => {
    let alive = true;
    setDetail(undefined);
    setFailure(undefined);
    api.dataset(datasetId).then(
      (loaded) => {
        if (!alive) return;
        setDetail(loaded);
        setView({ sheet: loaded.sheetDetails[0]?.name ?? "" });
      },
      (error: unknown) => {
        if (alive) setFailure(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      alive = false;
    };
  }, [datasetId, attempt]);

  const sheet = detail?.sheetDetails.find((s) => s.name === view.sheet);
  const columns = sheet?.columns ?? [];
  const interactive = !!sheet && sheet.rows <= (detail?.maxInteractiveRows ?? 0);
  const needColumn = !!sheet && sheet.rows > 100_000;
  const filtering = interactive && !!view.filter?.text;
  const rowCount = filtering ? (counts.matched ?? 0) : (sheet?.rows ?? 0);
  const key = viewKey(datasetId, view);

  // A new view starts a new cache; stale answers are dropped by the generation.
  useEffect(() => {
    generation.current++;
    cache.current.clear();
    inflight.current.clear();
    setPageError(undefined);
    setCounts({ interactive: true });
    setActive({ row: 0, col: 0 });
    if (scroller.current) scroller.current.scrollTop = 0;
    setScroll((s) => ({ ...s, top: 0 }));
    setVersion((n) => n + 1);
  }, [key]);

  // Column offsets (the row-number column comes first).
  const offsets = useMemo(() => {
    const out: number[] = [];
    let at = ROW_NUMBER_WIDTH;
    for (const column of columns) {
      out.push(at);
      at += widths[column.name] ?? DEFAULT_COLUMN_WIDTH;
    }
    return { starts: out, total: at };
  }, [columns, widths]);

  const loadPage = useCallback(
    (index: number): Promise<void> => {
      const existing = inflight.current.get(index);
      if (existing) return existing;
      if (cache.current.has(index) || !sheet) return Promise.resolve();
      const mine = generation.current;
      const run = async () => {
        let plan = planPage(index, view, interactive, cache.current);
        if ("need" in plan) {
          await loadPage(plan.need);
          if (mine !== generation.current) return;
          plan = planPage(index, view, interactive, cache.current);
          if ("need" in plan) return;
        }
        const page = await api.datasetRows(datasetId, { sheet: sheet.name, ...plan.request });
        if (mine !== generation.current) return;
        cache.current.set(index, { page });
        if (index === 0)
          setCounts({
            ...(page.matched !== undefined ? { matched: page.matched } : {}),
            interactive: page.interactive,
          });
        setVersion((n) => n + 1);
      };
      const promise = run()
        .catch((error: unknown) => {
          if (mine === generation.current)
            setPageError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (inflight.current.get(index) === promise) inflight.current.delete(index);
        });
      inflight.current.set(index, promise);
      return promise;
    },
    [datasetId, sheet, view, interactive],
  );

  const range = visibleRange(scroll.top, scroll.height - ROW_HEIGHT, rowCount);
  const needed = pagesFor(range.first, range.last);
  const neededKey = needed.join(",");
  // The first page always loads (it carries the filter's match count).
  useEffect(() => {
    if (!sheet) return;
    const wanted = new Set([0, ...needed]);
    // Visible pages first, then the next one ahead of a downward scroll.
    for (const page of [...wanted].sort((a, b) => a - b)) void loadPage(page);
  }, [neededKey, loadPage, sheet]);

  // Keep the active cell's element focused after keyboard moves (it may need to be rendered first).
  useLayoutEffect(() => {
    const want = pendingFocus.current;
    if (!want || !scroller.current) return;
    const element = scroller.current.querySelector<HTMLElement>(
      `[data-r="${want.row}"][data-c="${want.col}"]`,
    );
    if (element) {
      element.focus({ preventScroll: true });
      pendingFocus.current = undefined;
    }
  });

  // Viewport size.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () =>
      setScroll((s) => ({ ...s, width: element.clientWidth, height: element.clientHeight }));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [sheet]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element || raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      setScroll((s) => ({
        ...s,
        top: element.scrollTop,
        left: element.scrollLeft,
        width: element.clientWidth,
        height: element.clientHeight,
      }));
    });
  };

  const rowAt = (index: number): Array<string | number | null> | undefined => {
    const loaded = cache.current.peek(Math.floor(index / PAGE_SIZE));
    return loaded?.page.rows[index % PAGE_SIZE];
  };
  const rowIdAt = (index: number): number | undefined =>
    cache.current.peek(Math.floor(index / PAGE_SIZE))?.page.rowids[index % PAGE_SIZE];

  const moveTo = (cell: Cell) => {
    setActive(cell);
    pendingFocus.current = cell;
    const element = scroller.current;
    if (element && cell.row >= 0) {
      const top = scrollToRow(cell.row, element.scrollTop, element.clientHeight);
      if (top !== element.scrollTop) element.scrollTop = top;
      const start = offsets.starts[cell.col] ?? 0;
      const end = start + (widths[columns[cell.col]?.name ?? ""] ?? DEFAULT_COLUMN_WIDTH);
      if (start - ROW_NUMBER_WIDTH < element.scrollLeft)
        element.scrollLeft = Math.max(0, start - ROW_NUMBER_WIDTH);
      else if (end > element.scrollLeft + element.clientWidth)
        element.scrollLeft = end - element.clientWidth;
    }
  };

  const toggleSort = (column: string) => {
    if (!interactive) return;
    const next = nextSort(view.sort, column);
    setView({ ...view, ...(next ? { sort: next } : { sort: undefined }) });
  };

  const copy = async (text: string) => {
    if (await copyText(text)) showToast(t("sheet.copied"));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!sheet || !columns.length) return;
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.key.toLowerCase() === "c" && !window.getSelection()?.toString()) {
      event.preventDefault();
      if (active.row < 0) void copy(columns[active.col]?.label ?? "");
      else {
        const row = rowAt(active.row);
        if (row) void copy(event.shiftKey ? rowText(row) : cellValueText(row[active.col]));
      }
      return;
    }
    if (active.row < 0 && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      const column = columns[active.col];
      if (column) toggleSort(column.name);
      return;
    }
    if (
      event.altKey &&
      active.row < 0 &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      event.preventDefault();
      const column = columns[active.col];
      if (!column) return;
      const current = widths[column.name] ?? DEFAULT_COLUMN_WIDTH;
      const next = columnWidthStep(event.key, event.shiftKey, current);
      if (next !== undefined) setWidths({ ...widths, [column.name]: next });
      return;
    }
    const next = moveCell(
      event.key,
      ctrl,
      active,
      { rows: rowCount, cols: columns.length },
      Math.floor((scroll.height - ROW_HEIGHT) / ROW_HEIGHT),
    );
    if (!next) return;
    event.preventDefault();
    // Row -1 is the header: ArrowUp from the first row reaches it.
    if (event.key === "ArrowUp" && active.row === 0) return moveTo({ row: -1, col: active.col });
    if (event.key === "ArrowDown" && active.row === -1)
      return moveTo({ row: rowCount ? 0 : -1, col: active.col });
    moveTo(next);
  };

  // Debounced filter.
  useEffect(() => {
    if (!sheet) return;
    const timer = setTimeout(() => {
      const text = filterText.trim();
      const column = filterColumn ?? (needColumn ? columns[0]?.name : undefined);
      setView((current) => {
        const same = (current.filter?.text ?? "") === text && current.filter?.column === column;
        if (same) return current;
        const { filter: _drop, ...rest } = current;
        return text
          ? { ...rest, filter: { text, ...(column !== undefined ? { column } : {}) } }
          : rest;
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [filterText, filterColumn, sheet, needColumn]);

  const startResize = (event: PointerEvent, column: string) => {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = widths[column] ?? DEFAULT_COLUMN_WIDTH;
    const move = (e: PointerEvent) =>
      setWidths((w) => ({ ...w, [column]: clampColumnWidth(startWidth + e.clientX - startX) }));
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  if (failure)
    return (
      <div class={styles.state} role="status">
        <p>{t("sheet.error")}</p>
        <p class={styles.muted}>{failure}</p>
        <button type="button" class={styles.button} onClick={() => setAttempt((n) => n + 1)}>
          {t("artifact.retry")}
        </button>
      </div>
    );
  if (!detail || !sheet)
    return (
      <div class={styles.state} aria-busy="true">
        {t("sheet.loading")}
      </div>
    );

  const first = range.first;
  const rows: number[] = [];
  for (let i = range.first; i <= range.last; i++) rows.push(i);
  // Visible columns (with overscan), from the horizontal scroll position.
  let colFirst = 0;
  while (
    colFirst < columns.length - 1 &&
    (offsets.starts[colFirst + 1] ?? offsets.total) - ROW_NUMBER_WIDTH < scroll.left
  )
    colFirst++;
  let colLast = colFirst;
  while (
    colLast < columns.length - 1 &&
    (offsets.starts[colLast + 1] ?? offsets.total) < scroll.left + scroll.width
  )
    colLast++;
  colFirst = Math.max(0, colFirst - 3);
  colLast = Math.min(columns.length - 1, colLast + 3);
  const visibleColumns: number[] = [];
  for (let c = colFirst; c <= colLast; c++) visibleColumns.push(c);
  const widthOf = (c: number) => widths[columns[c]?.name ?? ""] ?? DEFAULT_COLUMN_WIDTH;

  return (
    <div class={styles.root}>
      <div class={styles.toolbar}>
        {detail.sheetDetails.length > 1 ? (
          <label class={styles.field}>
            <span class="sr-only">{t("sheet.sheet")}</span>
            <select
              value={view.sheet}
              aria-label={t("sheet.sheet")}
              onChange={(event) => {
                setFilterText("");
                setView({ sheet: (event.target as HTMLSelectElement).value });
              }}
            >
              {detail.sheetDetails.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label class={styles.field}>
          <span class="sr-only">{t("sheet.filterColumn")}</span>
          <select
            disabled={!interactive}
            aria-label={t("sheet.filterColumn")}
            value={filterColumn ?? (needColumn ? (columns[0]?.name ?? "") : "")}
            onChange={(event) => {
              const value = (event.target as HTMLSelectElement).value;
              setFilterColumn(value === "" ? undefined : value);
            }}
          >
            {needColumn ? null : <option value="">{t("sheet.allColumns")}</option>}
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <input
          type="search"
          class={styles.filter}
          disabled={!interactive}
          placeholder={t("sheet.filter")}
          aria-label={t("sheet.filter")}
          value={filterText}
          onInput={(event) => setFilterText((event.target as HTMLInputElement).value)}
        />
        <span class={styles.count} aria-live="polite">
          {filtering && counts.matched !== undefined
            ? t("sheet.matches", {
                matched: rowsLabel(counts.matched),
                total: rowsLabel(sheet.rows),
              })
            : t("sheet.rows", { total: rowsLabel(sheet.rows) })}
        </span>
        <button
          type="button"
          class={styles.iconButton}
          disabled={active.row < 0 || !rowAt(active.row)}
          aria-label={t("sheet.copyRow")}
          title={t("sheet.copyRow")}
          onClick={() => {
            const row = rowAt(active.row);
            if (row) void copy(rowText(row));
          }}
        >
          <Icon name="copy" size={15} />
        </button>
        {props.downloadHref ? (
          <a
            class={styles.iconButton}
            href={props.downloadHref}
            download=""
            aria-label={t("sheet.downloadOriginal")}
            title={t("sheet.downloadOriginal")}
          >
            <Icon name="download" size={15} />
          </a>
        ) : null}
      </div>
      {!interactive ? (
        <p class={styles.notice} role="status">
          {t("sheet.notInteractive", { limit: rowsLabel(detail.maxInteractiveRows) })}
        </p>
      ) : needColumn ? (
        <p class={styles.notice}>{t("sheet.needColumn")}</p>
      ) : (view.sort || filtering) && rowCount > MAX_OFFSET ? (
        <p class={styles.notice}>{t("sheet.jumpLimited", { limit: rowsLabel(MAX_OFFSET) })}</p>
      ) : null}
      {pageError ? (
        <p class={`${styles.notice} ${styles.error}`} role="alert">
          {t("sheet.error")} {pageError}{" "}
          <button
            type="button"
            class={styles.linkButton}
            onClick={() => {
              generation.current++;
              cache.current.clear();
              inflight.current.clear();
              setPageError(undefined);
              setVersion((n) => n + 1);
            }}
          >
            {t("artifact.retry")}
          </button>
        </p>
      ) : null}
      <div
        ref={scroller}
        class={styles.scroller}
        role="grid"
        aria-label={t("sheet.label")}
        aria-rowcount={rowCount + 1}
        aria-colcount={columns.length + 1}
        data-version={version}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
      >
        <div
          class={styles.sizer}
          style={{ width: `${offsets.total}px`, height: `${(rowCount + 1) * ROW_HEIGHT}px` }}
        >
          <div
            class={styles.header}
            role="row"
            aria-rowindex={1}
            style={{ width: `${offsets.total}px` }}
          >
            <div
              class={`${styles.rowNumber} ${styles.headerCell}`}
              role="columnheader"
              aria-colindex={1}
            >
              {t("sheet.rowNumber")}
            </div>
            {visibleColumns.map((c) => {
              const column = columns[c];
              if (!column) return null;
              const isActive = active.row === -1 && active.col === c;
              const sorted = ariaSort(view.sort, column.name);
              return (
                <div
                  key={column.name}
                  class={styles.headerCell}
                  role="columnheader"
                  aria-colindex={c + 2}
                  aria-sort={sorted}
                  data-r={-1}
                  data-c={c}
                  tabIndex={isActive ? 0 : -1}
                  style={{ left: `${offsets.starts[c]}px`, width: `${widthOf(c)}px` }}
                  title={`${column.label} · ${column.type}`}
                  onFocus={() => setActive({ row: -1, col: c })}
                  onClick={() => {
                    setActive({ row: -1, col: c });
                    toggleSort(column.name);
                  }}
                >
                  <span class={styles.headerText}>{column.label}</span>
                  <span class={styles.type}>{column.type}</span>
                  {sorted !== "none" ? (
                    <Icon name={sorted === "ascending" ? "arrowUp" : "arrowDown"} size={13} />
                  ) : null}
                  <span class="sr-only">
                    {interactive ? t("sheet.sortBy", { column: column.label }) : ""}
                  </span>
                  <span
                    class={styles.handle}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={t("sheet.resizeColumn", { column: column.label })}
                    aria-valuenow={widthOf(c)}
                    onPointerDown={(event) => startResize(event, column.name)}
                    onClick={(event) => event.stopPropagation()}
                    onDblClick={(event) => {
                      event.stopPropagation();
                      setWidths({ ...widths, [column.name]: DEFAULT_COLUMN_WIDTH });
                    }}
                  />
                </div>
              );
            })}
          </div>
          {rowCount === 0 && counts.matched === 0 && filtering ? (
            <p class={styles.empty}>{t("sheet.noMatches")}</p>
          ) : rowCount === 0 && sheet.rows === 0 ? (
            <p class={styles.empty}>{t("sheet.empty")}</p>
          ) : null}
          <div class={styles.rows} style={{ top: `${(first + 1) * ROW_HEIGHT}px` }}>
            {rows.map((index) => {
              const row = rowAt(index);
              const rowId = rowIdAt(index);
              return (
                <div
                  key={index}
                  class={styles.row}
                  role="row"
                  aria-rowindex={index + 2}
                  data-odd={index % 2 === 1 ? "true" : undefined}
                  data-loading={row ? undefined : "true"}
                  style={{ width: `${offsets.total}px` }}
                >
                  <div
                    class={styles.rowNumber}
                    role="rowheader"
                    aria-colindex={1}
                    title={rowId !== undefined ? String(rowId) : undefined}
                  >
                    {rowId ?? ""}
                  </div>
                  {visibleColumns.map((c) => {
                    const isActive = active.row === index && active.col === c;
                    const value = row?.[c];
                    return (
                      <div
                        key={c}
                        class={styles.cell}
                        role="gridcell"
                        aria-colindex={c + 2}
                        data-r={index}
                        data-c={c}
                        data-null={row && value === null ? "true" : undefined}
                        data-number={typeof value === "number" ? "true" : undefined}
                        data-active={isActive ? "true" : undefined}
                        tabIndex={isActive ? 0 : -1}
                        style={{ left: `${offsets.starts[c]}px`, width: `${widthOf(c)}px` }}
                        onFocus={() => setActive({ row: index, col: c })}
                        onMouseDown={() => setActive({ row: index, col: c })}
                        title={row ? cellValueText(value) : undefined}
                      >
                        {row ? cellValueText(value) : ""}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {filtering || view.sort ? (
        <span class="sr-only" aria-live="polite">
          {(view.sort ? view.sort.column : "") + (filtering ? ` ${view.filter?.text}` : "")}
        </span>
      ) : null}
    </div>
  );
}
