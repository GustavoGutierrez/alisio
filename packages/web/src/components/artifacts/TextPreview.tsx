import type { ArtifactRef } from "@alisio/sdk";
import { useEffect, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { Markdown, MarkdownScope } from "../../markdown/view.tsx";
import CodeView from "../../renderers/code/view.tsx";
import JsonView from "../../renderers/json/view.tsx";
import { api } from "../../store/app.ts";
import { goneError, setOpenError } from "../../store/artifacts.ts";
import { artifactImageUrl, codeLanguage } from "../../util/panel.ts";
import styles from "./panel.module.css";

/**
 * Text artifacts (≤ 2 MB, decided by `previewable`): Markdown with the transcript's renderer
 * (relative images resolved inside the artifact), JSON with the JSON renderer, everything else
 * (CSV/TSV in phases 1–2, code, logs) with the code renderer.
 */
export function TextPreview(props: {
  artifact: ArtifactRef;
  entry: string;
  as: "markdown" | "json" | "code";
}) {
  const { artifact, entry } = props;
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setText(undefined);
    setError(undefined);
    api.artifactText(artifact.id, entry).then(
      (value) => {
        if (alive) setText(value);
      },
      (failure: unknown) => {
        if (!alive) return;
        const message = failure instanceof Error ? failure.message : String(failure);
        setError(message);
        if (goneError(failure)) setOpenError(artifact.id, message);
      },
    );
    return () => {
      alive = false;
    };
  }, [artifact.id, entry, attempt]);
  if (error)
    return (
      <div class={`${styles.state} ${styles.stateError}`} role="status">
        <p>{t("artifactPanel.loadFailed")}</p>
        <button type="button" class={styles.button} onClick={() => setAttempt((n) => n + 1)}>
          {t("artifact.retry")}
        </button>
      </div>
    );
  if (text === undefined)
    return (
      <div class={styles.state} aria-busy="true">
        {t("artifact.loading")}
      </div>
    );
  return (
    <TextView
      text={text}
      as={props.as}
      entry={entry}
      image={(href) => artifactImageUrl(href, artifact.id, entry)}
    />
  );
}

/**
 * The text of a file with the viewer its type needs: Markdown with the transcript's renderer
 * (`image` resolves relative images), JSON with the JSON renderer, anything else with the code
 * renderer. The Scratch tab reuses it for the session scratchpad.
 */
export function TextView(props: {
  text: string;
  as: "markdown" | "json" | "code";
  entry: string;
  image?: (href: string) => string | undefined;
}) {
  const { text, entry } = props;
  if (props.as === "markdown")
    return (
      <div class={styles.document}>
        <MarkdownScope.Provider
          value={{
            image: props.image ?? (() => undefined),
            workspaceLinks: false,
          }}
        >
          <Markdown text={text} />
        </MarkdownScope.Provider>
      </div>
    );
  if (props.as === "json") {
    try {
      return (
        <div class={styles.document}>
          <JsonView block={{ kind: "json", value: JSON.parse(text), collapsedDepth: 2 }} />
        </div>
      );
    } catch {
      /* Not valid JSON: show it as text. */
    }
  }
  const lang = codeLanguage(entry);
  return (
    <div class={styles.document}>
      <CodeView block={{ kind: "code", code: text, ...(lang ? { lang } : {}) }} />
    </div>
  );
}
