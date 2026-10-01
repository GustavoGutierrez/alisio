import type { ArtifactRef } from "@alisio/sdk";
import { t } from "../../i18n/index.ts";
import { currentId } from "../../store/app.ts";
import {
  artifactPanel,
  artifactsBySession,
  downloadArtifact,
  openArtifact,
  openErrors,
} from "../../store/artifacts.ts";
import {
  ARTIFACT_ICONS,
  downloadUrl,
  formatSize,
  primaryAction,
  reconcile,
} from "../../util/artifacts.ts";
import { cardSubtitle } from "../../util/panel.ts";
import { Icon, type IconName } from "../icons.tsx";
import styles from "./artifacts.module.css";

/**
 * A published artifact in the transcript (spec §15.2): icon, file name and kind label at rest;
 * on hover or visible focus "Open file" replaces the label, only for previewable artifacts (pure
 * CSS, same grid cell, no layout shift). The main button opens the panel (or downloads what
 * cannot be previewed); the download button is always visible and never opens the panel.
 */
export function ArtifactCard(props: { artifact: ArtifactRef; compact?: boolean }) {
  const list = artifactsBySession.value[currentId.value ?? ""];
  const { artifact, state } = reconcile(props.artifact, list);
  const kind = t(`artifact.kind.${artifact.kind}` as Parameters<typeof t>[0]);
  const gone = state === "deleted" || state === "expired";
  const error = openErrors.value[artifact.id];
  const subtitle = cardSubtitle(artifact, state, error);
  const open = primaryAction(artifact) === "open";
  const active = artifactPanel.value?.id === artifact.id;
  const metaId = `artifact-meta-${artifact.id}${props.compact ? "-c" : ""}`;
  return (
    <div
      role="group"
      aria-label={artifact.fileName}
      class={styles.card}
      data-state={state}
      data-compact={props.compact ? "true" : undefined}
    >
      <button
        type="button"
        class={styles.main}
        disabled={state === "loading"}
        aria-disabled={gone ? "true" : undefined}
        aria-label={t(open ? "artifact.openNamed" : "artifact.downloadNamedKind", {
          name: artifact.fileName,
          kind,
        })}
        aria-describedby={metaId}
        {...(open ? { "aria-controls": "artifact-panel", "aria-expanded": active } : {})}
        onClick={(event) => {
          if (gone || state === "loading") return;
          if (open) openArtifact(artifact.id, event.currentTarget as HTMLElement);
          else downloadArtifact(artifact.id);
        }}
      >
        <span class={styles.icon}>
          <Icon name={ARTIFACT_ICONS[artifact.kind] as IconName} size={20} />
        </span>
        <span class={styles.name} title={artifact.fileName}>
          {artifact.fileName}
        </span>
        <span class={styles.subtitle}>
          {subtitle.rest === "loading" ? (
            <span class={styles.skeleton} aria-hidden="true" />
          ) : subtitle.rest === "deleted" || subtitle.rest === "expired" ? (
            <span class={styles.rest}>
              {t(subtitle.rest === "deleted" ? "artifact.deleted" : "artifact.expired")}
            </span>
          ) : subtitle.rest === "error" ? (
            <span class={`${styles.rest} ${styles.error}`}>{t("artifact.unavailable")}</span>
          ) : (
            <>
              <span class={styles.rest}>
                {kind}
                {subtitle.partial ? ` · ${t("artifact.partial")}` : ""}
              </span>
              {subtitle.hover ? <span class={styles.hover}>{t("artifact.open")}</span> : null}
            </>
          )}
        </span>
      </button>
      <span id={metaId} class="sr-only">
        {t("artifact.meta", {
          size: formatSize(artifact.bytes),
          date: new Date(artifact.createdAt).toLocaleString(),
        })}
      </span>
      {error && !gone ? (
        <span class={styles.errorRow} role="status">
          <span class="sr-only">{error}</span>
          <button
            type="button"
            class={styles.retry}
            onClick={(event) => openArtifact(artifact.id, event.currentTarget as HTMLElement)}
          >
            {t("artifact.retry")}
          </button>
        </span>
      ) : null}
      {gone ? null : (
        <a
          class={styles.download}
          href={downloadUrl(artifact.id)}
          download=""
          aria-label={t("artifact.downloadNamed", { name: artifact.fileName })}
          title={t("artifact.download")}
          onClick={(event) => event.stopPropagation()}
        >
          <Icon name="download" size={16} />
        </a>
      )}
    </div>
  );
}

/** The artifacts of one turn, under its tool rows (outside the foldable rows). */
export function ArtifactCards(props: { artifacts: ArtifactRef[] }) {
  return (
    <div class={styles.list}>
      {props.artifacts.map((artifact) => (
        <ArtifactCard key={artifact.id} artifact={artifact} />
      ))}
    </div>
  );
}
