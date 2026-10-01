import type { DatasetRef } from "@alisio/sdk";
import { useEffect, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import styles from "./panel.module.css";

type Chunk = typeof import("./SpreadsheetPanel.tsx");

/** The table viewer, loaded on first use (its own chunk). */
export function LazySpreadsheet(
  props: { artifactId: string; name: string } | { dataset: DatasetRef },
) {
  const [chunk, setChunk] = useState<Chunk>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    import("./SpreadsheetPanel.tsx").then(
      (loaded) => {
        if (alive) setChunk(loaded);
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  if (failed)
    return (
      <div class={`${styles.state} ${styles.stateError}`} role="status">
        {t("sheet.error")}
      </div>
    );
  if (!chunk)
    return (
      <div class={styles.state} aria-busy="true">
        {t("artifact.loading")}
      </div>
    );
  return "dataset" in props ? (
    <chunk.DatasetSpreadsheet dataset={props.dataset} original />
  ) : (
    <chunk.ArtifactSpreadsheet artifactId={props.artifactId} name={props.name} />
  );
}
