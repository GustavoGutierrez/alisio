/**
 * The Scratch tab of the dock (Forja spec §11.2, FJ-AC-35): the files the session's scripts saved
 * in its scratchpad, with the quota, a preview of text and code, a download per file and a
 * confirmed "Empty". Read only: nothing here edits a file. Names are relative; a host path is
 * never shown (the API does not send one).
 */
import type { ScratchFile } from "@alisio/sdk";
import { useEffect, useState } from "preact/hooks";
import { api, currentId, runEnded } from "../../store/app.ts";
import {
  clearScratch,
  loadScratch,
  resetScratch,
  type ScratchNotice,
  scratchState,
  selectScratchFile,
} from "../../store/scratch.ts";
import { formatSize } from "../../util/artifacts.ts";
import { newestFirst, previewOf, quotaLevel, scratchFileUrl } from "../../util/scratch.ts";
import { TextView } from "../artifacts/TextPreview.tsx";
import { Icon } from "../icons.tsx";
import styles from "./scratch.module.css";
import { sk } from "./scratch-strings.ts";

const noticeText = (notice: ScratchNotice): string => {
  switch (notice.kind) {
    case "cleared":
      return sk("cleared", { removed: notice.removed, size: formatSize(notice.freedBytes) });
    case "runsActive":
      return sk("runsActive");
    case "readOnly":
      return sk("readOnly");
    case "failed":
      return sk("failed", { error: notice.message });
  }
};

/** The selected file: its text with the existing viewer, or the reason it has no preview. */
function Preview(props: { sessionId: string; file: ScratchFile }) {
  const { sessionId, file } = props;
  const view = previewOf(file);
  const [text, setText] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setText(undefined);
    setFailed(false);
    if (!view) return;
    let alive = true;
    api.scratchText(sessionId, file.name).then(
      (value) => alive && setText(value),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [sessionId, file.name, file.mtime, file.size]);
  if (!view) return <p class={styles.note}>{sk("noPreview")}</p>;
  if (failed)
    return (
      <p class={styles.error} role="status">
        {sk("previewFailed")}
      </p>
    );
  if (text === undefined)
    return (
      <p class={styles.note} aria-busy="true">
        {sk("loading")}
      </p>
    );
  return <TextView text={text} as={view.as} entry={view.entry} />;
}

function Quota(props: { used: number; total: number }) {
  const { percent, level } = quotaLevel(props.used, props.total);
  const text = sk("quota", { used: formatSize(props.used), total: formatSize(props.total) });
  return (
    <div class={styles.quota}>
      <div
        class={styles.meter}
        role="meter"
        aria-label={sk("title")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={text}
        data-level={level}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <p class={styles.note}>{text}</p>
    </div>
  );
}

export function ScratchTab() {
  const session = currentId.value;
  const state = scratchState.value;
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    setConfirming(false);
    if (session) void loadScratch(session);
    else resetScratch();
  }, [session, runEnded.value]);
  if (!session) return null;
  const { listing } = state;
  const files = listing ? newestFirst(listing.files) : [];
  const selected = files.find((file) => file.name === state.selected);
  return (
    <div class={styles.tab}>
      <p class={styles.lead}>{sk("lead")}</p>
      <div class={styles.live} role="status" aria-live="polite">
        {state.notice ? noticeText(state.notice) : ""}
      </div>
      {state.status === "error" ? (
        <div role="alert">
          <p class={styles.error}>
            {sk("loadFailed")} {state.error}
          </p>
          <button type="button" class={styles.button} onClick={() => void loadScratch(session)}>
            {sk("retry")}
          </button>
        </div>
      ) : state.status !== "ready" || !listing ? (
        <p class={styles.note} aria-busy="true">
          {sk("loading")}
        </p>
      ) : !listing.available ? (
        <p class={styles.note}>{sk("unavailable")}</p>
      ) : (
        <>
          <Quota used={listing.usedBytes} total={listing.quotaBytes} />
          {listing.truncated ? (
            <p class={styles.note}>{sk("truncated", { count: listing.files.length })}</p>
          ) : null}
          {selected ? (
            <div class={styles.detail}>
              <div class={styles.detailHead}>
                <button
                  type="button"
                  class={styles.back}
                  onClick={() => selectScratchFile(undefined)}
                >
                  <span aria-hidden="true">←</span>
                  {sk("back")}
                </button>
                <a
                  class={styles.iconLink}
                  href={scratchFileUrl(session, selected.name)}
                  download=""
                  aria-label={sk("download", { name: selected.name })}
                  title={sk("download", { name: selected.name })}
                >
                  <Icon name="download" size={15} />
                </a>
              </div>
              <h4 class={styles.fileTitle} title={selected.name}>
                {selected.name}
              </h4>
              <Preview sessionId={session} file={selected} />
            </div>
          ) : files.length ? (
            <>
              <ul class={styles.list} aria-label={sk("files")}>
                {files.map((file) => (
                  <li key={file.name} class={styles.item}>
                    <button
                      type="button"
                      class={styles.file}
                      onClick={() => selectScratchFile(file.name)}
                    >
                      <span class={styles.name} title={file.name}>
                        {file.name}
                      </span>
                      <span class={styles.meta}>
                        <span>{formatSize(file.size)}</span>
                        <span>
                          {sk("modified", { time: new Date(file.mtime).toLocaleString() })}
                        </span>
                      </span>
                    </button>
                    <a
                      class={styles.iconLink}
                      href={scratchFileUrl(session, file.name)}
                      download=""
                      aria-label={sk("download", { name: file.name })}
                      title={sk("download", { name: file.name })}
                    >
                      <Icon name="download" size={15} />
                    </a>
                  </li>
                ))}
              </ul>
              {confirming ? (
                <div class={styles.confirm} role="alertdialog" aria-label={sk("confirmAction")}>
                  <p>{sk("confirm")}</p>
                  <div class={styles.row}>
                    <button
                      type="button"
                      class={styles.button}
                      ref={(element) => element?.focus()}
                      onClick={() => setConfirming(false)}
                    >
                      {sk("cancel")}
                    </button>
                    <button
                      type="button"
                      class={`${styles.button} ${styles.danger}`}
                      disabled={state.clearing}
                      onClick={() => {
                        setConfirming(false);
                        void clearScratch(session);
                      }}
                    >
                      {state.clearing ? sk("working") : sk("confirmAction")}
                    </button>
                  </div>
                </div>
              ) : (
                <div class={styles.row}>
                  <button
                    type="button"
                    class={`${styles.button} ${styles.danger}`}
                    disabled={state.clearing}
                    onClick={() => setConfirming(true)}
                  >
                    {sk("emptyAction")}
                  </button>
                </div>
              )}
            </>
          ) : (
            <p class={styles.note}>{sk("empty")}</p>
          )}
        </>
      )}
    </div>
  );
}
