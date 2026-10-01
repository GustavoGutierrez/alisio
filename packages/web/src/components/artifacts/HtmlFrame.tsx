import type { ArtifactRef } from "@alisio/sdk";
import { useEffect, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { goneError, requestViewUrl, setOpenError } from "../../store/artifacts.ts";
import styles from "./panel.module.css";

const LOAD_TIMEOUT_MS = 15_000;

/**
 * An HTML dashboard in the isolated viewer (spec §14.2): a signed link, an iframe sandboxed with
 * `allow-scripts allow-downloads` only (never `allow-same-origin`), no referrer, no features.
 * A skeleton shows until `load`; after 15 s without it, an error with Reload.
 */
export function HtmlFrame(props: { artifact: ArtifactRef }) {
  const { artifact } = props;
  const [url, setUrl] = useState<string>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setState("loading");
    setUrl(undefined);
    requestViewUrl(artifact.id).then(
      (link) => {
        if (alive) setUrl(link);
      },
      (error: unknown) => {
        if (!alive) return;
        setState("error");
        if (goneError(error))
          setOpenError(artifact.id, error instanceof Error ? error.message : String(error));
      },
    );
    const timer = setTimeout(() => {
      if (alive) setState((current) => (current === "loading" ? "error" : current));
    }, LOAD_TIMEOUT_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [artifact.id, attempt]);
  if (state === "error")
    return (
      <div class={`${styles.state} ${styles.stateError}`} role="status">
        <p>{t("artifactPanel.loadFailed")}</p>
        <button type="button" class={styles.button} onClick={() => setAttempt((n) => n + 1)}>
          {t("artifactPanel.reload")}
        </button>
      </div>
    );
  return (
    <div class={styles.frameWrap}>
      {url ? (
        <iframe
          key={`${url}#${attempt}`}
          class={styles.frame}
          src={url}
          title={t("artifactPanel.frameTitle", { name: artifact.title })}
          sandbox="allow-scripts allow-downloads"
          referrerpolicy="no-referrer"
          allow=""
          loading="lazy"
          onLoad={() => setState("ready")}
        />
      ) : null}
      {state === "loading" ? (
        <div class={styles.skeleton} aria-busy="true">
          {t("artifact.loading")}
        </div>
      ) : null}
    </div>
  );
}
