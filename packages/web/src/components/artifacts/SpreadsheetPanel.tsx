/**
 * The deferred chunk of the table viewer: `SpreadsheetView` plus the two ways the panel reaches a
 * dataset. A spreadsheet artifact (CSV, TSV, XLSX) is ingested on its first preview (the server
 * answers `pending` until the file is read); a dataset attached to a prompt is already there.
 */
import type { DatasetRef } from "@alisio/sdk";
import { useEffect, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { api } from "../../store/app.ts";
import { downloadUrl } from "../../util/artifacts.ts";
import { SpreadsheetView } from "./SpreadsheetView.tsx";
import styles from "./spreadsheet.module.css";

export { SpreadsheetView };

/** An artifact opened as a table. */
export function ArtifactSpreadsheet(props: { artifactId: string; name: string }) {
  const [dataset, setDataset] = useState<DatasetRef>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setDataset(undefined);
    setError(undefined);
    const ask = () =>
      api.artifactDataset(props.artifactId).then(
        (answer) => {
          if (!alive) return;
          if (answer.dataset) setDataset(answer.dataset);
          else timer = setTimeout(ask, 2000);
        },
        (failure: unknown) => {
          if (alive) setError(failure instanceof Error ? failure.message : String(failure));
        },
      );
    void ask();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [props.artifactId, attempt]);
  if (error)
    return (
      <div class={styles.state} role="status">
        <p>{t("sheet.error")}</p>
        <p class={styles.muted}>{error}</p>
        <button type="button" class={styles.button} onClick={() => setAttempt((n) => n + 1)}>
          {t("artifact.retry")}
        </button>
      </div>
    );
  if (!dataset)
    return (
      <div class={styles.state} aria-busy="true">
        {t("sheet.preparing")}
      </div>
    );
  return (
    <SpreadsheetView
      datasetId={dataset.id}
      name={props.name}
      downloadHref={downloadUrl(props.artifactId)}
    />
  );
}

/** A dataset attached to a prompt. */
export function DatasetSpreadsheet(props: { dataset: DatasetRef; original: boolean }) {
  return (
    <SpreadsheetView
      datasetId={props.dataset.id}
      name={props.dataset.name}
      {...(props.original ? { downloadHref: api.datasetDownloadUrl(props.dataset.id) } : {})}
    />
  );
}
