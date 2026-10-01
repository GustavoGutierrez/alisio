import type { ArtifactRef } from "@alisio/sdk";
import { useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { api } from "../../store/app.ts";
import styles from "./panel.module.css";

/** An image (SVG included: scripts never run in `<img>`), fitted or at 100 %. */
export function ImageView(props: { artifact: ArtifactRef; entry: string }) {
  const { artifact } = props;
  const [fit, setFit] = useState(true);
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <div class={`${styles.state} ${styles.stateError}`} role="status">
        {t("artifactPanel.loadFailed")}
      </div>
    );
  return (
    <div>
      <div class={styles.imageBar}>
        <button
          type="button"
          class={`${styles.button} ${styles.toggle}`}
          aria-pressed={fit}
          onClick={() => setFit(true)}
        >
          {t("artifactPanel.fit")}
        </button>
        <button
          type="button"
          class={`${styles.button} ${styles.toggle}`}
          aria-pressed={!fit}
          onClick={() => setFit(false)}
        >
          {t("artifactPanel.actualSize")}
        </button>
      </div>
      <div class={styles.imageWrap}>
        <img
          class={styles.image}
          data-fit={fit ? "true" : "false"}
          src={api.artifactFileUrl(artifact.id, props.entry)}
          alt={artifact.title}
          onError={() => setFailed(true)}
        />
      </div>
    </div>
  );
}
