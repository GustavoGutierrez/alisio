import type { ArtifactRef } from "@alisio/sdk";
import { t } from "../../i18n/index.ts";
import { ARTIFACT_ICONS, downloadUrl, formatSize } from "../../util/artifacts.ts";
import { Icon, type IconName } from "../icons.tsx";
import styles from "./panel.module.css";

/** Download-only view (spec §7): icon, name, size, why there is no preview, and Download. */
export function DownloadFallback(props: {
  artifact: ArtifactRef;
  reason: "noPreview" | "tooLarge";
}) {
  const { artifact } = props;
  return (
    <div class={styles.state}>
      <span class={styles.fallbackIcon}>
        <Icon name={ARTIFACT_ICONS[artifact.kind] as IconName} size={26} />
      </span>
      <span class={styles.fallbackName} title={artifact.fileName}>
        {artifact.fileName}
      </span>
      <span>{formatSize(artifact.bytes)}</span>
      <p>
        {props.reason === "tooLarge"
          ? t("artifact.tooLarge", { size: formatSize(artifact.bytes) })
          : t("artifact.noPreview")}
      </p>
      <a class={`${styles.button} ${styles.primary}`} href={downloadUrl(artifact.id)} download="">
        {t("artifact.download")}
      </a>
    </div>
  );
}
