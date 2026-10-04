import { useComputed } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { Markdown } from "../../markdown/view.tsx";
import { loadOlder, retryEcho, transcript } from "../../store/app.ts";
import { type VisibleItem, visibleItems } from "../../store/transcript.ts";
import { ArtifactCards } from "../artifacts/ArtifactCard.tsx";
import { DatasetChips } from "../artifacts/DatasetChips.tsx";
import { CopyButton } from "../CopyButton.tsx";
import { Icon } from "../icons.tsx";
import { CompactingStatus, RunStatus } from "./RunStatus.tsx";
import { ThinkRow, ToolRow } from "./ToolRow.tsx";
import styles from "./transcript.module.css";

/** Turns rendered at first (older ones behind "Show earlier", spec §10.6). */
const WINDOW_TURNS = 30;

function Item({ item }: { item: VisibleItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div class={styles.userTurn}>
          <div class={styles.bubble}>
            {item.images?.length ? (
              <span class={styles.bubbleImages}>
                {item.images.map((image, i) => (
                  <img key={i} src={`data:${image.mimeType};base64,${image.data}`} alt="" />
                ))}
              </span>
            ) : item.attachments ? (
              <span class={styles.attachments}>
                {t("transcript.images", { count: item.attachments })}
              </span>
            ) : null}
            {item.text}
            {item.datasets?.length ? <DatasetChips datasets={item.datasets} /> : null}
          </div>
          <div class={styles.bubbleActions}>
            <CopyButton text={() => item.text} label={t("transcript.copyMessage")} />
          </div>
        </div>
      );
    case "echo":
      return (
        <div class={styles.userTurn}>
          <div class={`${styles.bubble} ${styles.pendingBubble}`}>
            {item.echo.thumbs?.length ? (
              <span class={styles.bubbleImages}>
                {item.echo.thumbs.map((url) => (
                  <img key={url} src={url} alt="" />
                ))}
              </span>
            ) : null}
            {item.echo.display ?? item.echo.text}
            {item.echo.datasets?.length ? <DatasetChips datasets={item.echo.datasets} /> : null}
          </div>
          <div class={styles.bubbleActions}>
            {item.echo.state === "failed" ? (
              <span class={styles.failedNote} role="alert">
                {t("transcript.notSent", { error: item.echo.error ?? "" })}
                <button
                  type="button"
                  class={styles.linkButton}
                  onClick={() => retryEcho(item.echo.localId)}
                >
                  {t("common.retry")}
                </button>
              </span>
            ) : (
              <span class={styles.hint}>{t("transcript.sending")}</span>
            )}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div class={styles.assistant}>
          {item.think ? <ThinkRow text={item.think} /> : null}
          {item.text ? (
            <div class={styles.answer}>
              <Markdown text={item.text} />
            </div>
          ) : null}
          {item.truncated ? (
            <p class={styles.notice} data-tone="warning">
              <Icon name="alert" size={14} />
              {t("notice.response_truncated", {
                maxOutputTokens: "—",
                source: t("limitSource.unknown"),
              })}
            </p>
          ) : null}
        </div>
      );
    case "streaming":
      return (
        <div class={`${styles.answer} ${styles.streaming}`}>
          <Markdown text={item.text} streaming />
        </div>
      );
    case "think":
      return <ThinkRow text={item.text} live />;
    case "tool":
      return <ToolRow tool={item.tool} />;
    case "artifacts":
      return <ArtifactCards artifacts={item.artifacts} />;
    case "context":
      return (
        <div class={styles.process}>
          <div class={styles.processHead} data-static="true">
            <span class={styles.processIcon}>
              <Icon name="layers" size={15} />
            </span>
            <span class={styles.processName}>{t("transcript.context")}</span>
            <span class={styles.dot} aria-hidden="true">
              ·
            </span>
            <span class={styles.summary}>{item.sources.join(", ")}</span>
          </div>
        </div>
      );
    case "notice":
      return (
        <p class={styles.notice} data-tone={item.tone}>
          <Icon name={item.tone === "info" ? "info" : "alert"} size={14} />
          {t(
            `notice.${item.code}` as Parameters<typeof t>[0],
            item.params.source
              ? {
                  ...item.params,
                  source: t(`limitSource.${item.params.source}` as Parameters<typeof t>[0]),
                }
              : item.params,
          )}
        </p>
      );
    case "note":
      return (
        <div class={styles.note}>
          <Markdown text={item.text} />
        </div>
      );
  }
}

/** The conversation column: windowed turns, follow-the-stream scrolling, jump-to-latest. */
export function Transcript() {
  const items = useComputed(() => visibleItems(transcript.value));
  const state = transcript.value;
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [turns, setTurns] = useState(WINDOW_TURNS);
  const all = items.value;
  // Window by user turns: keep the last `turns` user messages and everything after them.
  const userIndexes = all.flatMap((item, i) =>
    item.kind === "user" || item.kind === "echo" ? [i] : [],
  );
  const start = userIndexes.length > turns ? (userIndexes[userIndexes.length - turns] ?? 0) : 0;
  const shown = start ? all.slice(start) : all;
  const hidden = userIndexes.length - turns;

  useEffect(() => {
    setTurns(WINDOW_TURNS);
    setFollow(true);
  }, [state.sessionId]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [state.version, follow]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (atBottom !== follow) setFollow(atBottom);
  };

  const empty = state.ready && !all.length;
  return (
    <div class={styles.wrap}>
      <div
        ref={scroller}
        class={styles.scroller}
        onScroll={onScroll}
        id="conversation"
        tabIndex={-1}
      >
        <div class={styles.column} role="log" aria-label={t("transcript.label")} aria-live="off">
          {hidden > 0 ? (
            <button
              type="button"
              class={styles.older}
              onClick={() => setTurns(turns + WINDOW_TURNS)}
            >
              {t("transcript.showEarlier", { count: hidden })}
            </button>
          ) : state.hasMore ? (
            <button type="button" class={styles.older} onClick={() => void loadOlder()}>
              {t("transcript.loadOlder")}
            </button>
          ) : null}
          {empty ? (
            <div class={styles.empty}>
              <h2>{t("transcript.emptyTitle")}</h2>
              <p>{t("transcript.emptyBody")}</p>
            </div>
          ) : null}
          {shown.map((item) => (
            <Item key={item.key} item={item} />
          ))}
          {state.live ? <RunStatus /> : <CompactingStatus />}
        </div>
      </div>
      {!follow ? (
        <button
          type="button"
          class={styles.toBottom}
          aria-label={t("transcript.scrollToBottom")}
          title={t("transcript.scrollToBottom")}
          onClick={() => {
            const el = scroller.current;
            if (el) el.scrollTop = el.scrollHeight;
            setFollow(true);
          }}
        >
          <Icon name="arrowDown" size={16} />
        </button>
      ) : null}
    </div>
  );
}
