import type { UiBlock } from "@alisio/sdk";
import { useMemo, useState } from "preact/hooks";
import { CopyButton } from "../../components/CopyButton.tsx";
import { t } from "../../i18n/index.ts";
import styles from "./diff.module.css";
import { type DiffFile, type DiffHunk, type DiffLine, filesOf, splitRows } from "./model.ts";

type DiffBlock = Extract<UiBlock, { kind: "diff" }>;

const SIGN = { add: "+", del: "−", ctx: " ", note: "" } as const;

function Unified({ hunk }: { hunk: DiffHunk }) {
  return (
    <>
      {hunk.lines.map((line, i) => (
        <tr key={i} class={styles[line.type]}>
          <td class={styles.no}>{line.oldNo ?? ""}</td>
          <td class={styles.no}>{line.newNo ?? ""}</td>
          <td class={styles.sign}>{SIGN[line.type]}</td>
          <td class={styles.code}>{line.text}</td>
        </tr>
      ))}
    </>
  );
}

const Half = ({ line, side }: { line?: DiffLine; side: "left" | "right" }) => (
  <>
    <td class={`${styles.no} ${line ? styles[line.type] : styles.empty}`}>
      {(side === "left" ? line?.oldNo : line?.newNo) ?? ""}
    </td>
    <td class={`${styles.code} ${line ? styles[line.type] : styles.empty}`}>{line?.text ?? ""}</td>
  </>
);

function Split({ hunk }: { hunk: DiffHunk }) {
  return (
    <>
      {splitRows(hunk).map((row, i) => (
        <tr key={i}>
          <Half line={row.left} side="left" />
          <Half line={row.right} side="right" />
        </tr>
      ))}
    </>
  );
}

function FileDiff(props: { file: DiffFile; split: boolean; index: number }) {
  const { file } = props;
  const [folded, setFolded] = useState<Set<number>>(() => new Set());
  const toggle = (i: number) => {
    const next = new Set(folded);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setFolded(next);
  };
  return (
    <section class={styles.file} id={`diff-file-${props.index}`}>
      <header class={styles.fileHead}>
        <span class={styles.status} data-status={file.status}>
          {t(`diff.status.${file.status}`)}
        </span>
        <span class={styles.path}>{file.path || t("diff.untitled")}</span>
        <span class={styles.stat}>
          <span class={styles.plus}>+{file.added}</span>
          <span class={styles.minus}>−{file.removed}</span>
        </span>
      </header>
      {file.binary ? <p class={styles.note}>{t("diff.binary")}</p> : null}
      {!file.hunks.length && !file.binary ? <p class={styles.note}>{t("diff.noChanges")}</p> : null}
      {file.hunks.length ? (
        <div class={styles.scroll}>
          <table class={styles.table}>
            {file.hunks.map((hunk, i) => (
              <tbody key={i}>
                <tr class={styles.hunkRow}>
                  <td colSpan={4}>
                    <button
                      type="button"
                      class={styles.hunkToggle}
                      aria-expanded={!folded.has(i)}
                      onClick={() => toggle(i)}
                    >
                      {folded.has(i) ? "▸" : "▾"} {hunk.header}
                    </button>
                  </td>
                </tr>
                {folded.has(i) ? null : props.split ? (
                  <Split hunk={hunk} />
                ) : (
                  <Unified hunk={hunk} />
                )}
              </tbody>
            ))}
          </table>
        </div>
      ) : null}
    </section>
  );
}

/** Unified (default) or side-by-side diff with foldable hunks and per-file navigation. */
export default function DiffView({ block }: { block: DiffBlock }) {
  const files = useMemo(() => filesOf(block), [block]);
  const [split, setSplit] = useState(false);
  const plain = files.every((f) => !f.hunks.length && !f.binary) && block.patch;
  return (
    <figure class={styles.block}>
      <figcaption class={styles.bar}>
        <span class={styles.title}>
          {block.caption ??
            (files.length > 1 ? t("diff.files", { count: files.length }) : t("diff.title"))}
        </span>
        <span class={styles.actions}>
          <button
            type="button"
            class={styles.action}
            aria-pressed={split}
            onClick={() => setSplit(!split)}
          >
            {split ? t("diff.unified") : t("diff.split")}
          </button>
          {block.patch ? (
            <CopyButton text={() => block.patch ?? ""} class={styles.action} showText />
          ) : null}
        </span>
      </figcaption>
      {files.length > 1 ? (
        <nav class={styles.nav} aria-label={t("diff.files", { count: files.length })}>
          {files.map((file, i) => (
            <a
              key={i}
              href={`#diff-file-${i}`}
              onClick={(event) => {
                event.preventDefault();
                document.getElementById(`diff-file-${i}`)?.scrollIntoView({ block: "nearest" });
              }}
            >
              {file.path}
              <span class={styles.plus}> +{file.added}</span>
              <span class={styles.minus}> −{file.removed}</span>
            </a>
          ))}
        </nav>
      ) : null}
      {plain ? (
        <pre class={styles.plainText}>{block.patch}</pre>
      ) : (
        files.map((file, i) => <FileDiff key={i} file={file} split={split} index={i} />)
      )}
    </figure>
  );
}
