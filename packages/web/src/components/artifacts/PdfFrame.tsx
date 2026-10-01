import type { ArtifactRef } from "@alisio/sdk";
import { useEffect, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { goneError, requestViewUrl, setOpenError } from "../../store/artifacts.ts";
import { DownloadFallback } from "./DownloadFallback.tsx";
import styles from "./panel.module.css";

/**
 * A PDF in the browser's own viewer (decision D9): an iframe WITHOUT `sandbox` (Chromium's viewer
 * does not load in sandboxed frames), served by the token route with a minimal CSP. Browsers
 * without an embedded PDF viewer get the download fallback.
 */
export function PdfFrame(props: { artifact: ArtifactRef }) {
  const { artifact } = props;
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const supported =
    typeof navigator === "undefined" ||
    (navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled !== false;
  useEffect(() => {
    if (!supported) return;
    let alive = true;
    setFailed(false);
    requestViewUrl(artifact.id).then(
      (link) => {
        if (alive) setUrl(link);
      },
      (error: unknown) => {
        if (!alive) return;
        setFailed(true);
        if (goneError(error))
          setOpenError(artifact.id, error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      alive = false;
    };
  }, [artifact.id, supported]);
  if (!supported) return <DownloadFallback artifact={artifact} reason="noPreview" />;
  if (failed)
    return (
      <div class={`${styles.state} ${styles.stateError}`} role="status">
        {t("artifactPanel.loadFailed")}
      </div>
    );
  return (
    <div class={styles.frameWrap}>
      {url ? (
        <iframe
          class={styles.frame}
          src={url}
          title={t("artifactPanel.frameTitle", { name: artifact.title })}
          referrerpolicy="no-referrer"
        />
      ) : (
        <div class={styles.skeleton} aria-busy="true">
          {t("artifact.loading")}
        </div>
      )}
    </div>
  );
}
