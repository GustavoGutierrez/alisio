/**
 * Mermaid diagrams (spec §10.4). This small view ships as its own chunk; Mermaid itself loads
 * only when the block scrolls into view (never while it streams). Invalid diagrams show the
 * source and the error. Actions: source/diagram toggle, copy, SVG export, zoom and full screen.
 */
import type { UiBlock } from "@alisio/sdk";
import { useEffect, useRef, useState } from "preact/hooks";
import { CopyButton } from "../../components/CopyButton.tsx";
import { Icon } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import { resolvedTheme } from "../../store/prefs.ts";
import { whenVisible } from "../visible.ts";
import styles from "./mermaid.module.css";
import type { MermaidResult } from "./render.ts";

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

function exportSvg(svg: string, name: string) {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.svg`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function Diagram(props: { svg: string; zoom: number }) {
  return (
    <div
      class={styles.canvas}
      style={{ width: `${props.zoom * 100}%` }}
      // Safe: Mermaid SVG (securityLevel strict) sanitized by DOMPurify.
      dangerouslySetInnerHTML={{ __html: props.svg }}
    />
  );
}

export default function MermaidView(props: { block: UiBlock; live?: boolean }) {
  const source = props.block.kind === "mermaid" ? props.block.source : "";
  const title = props.block.kind === "mermaid" ? props.block.title : undefined;
  const ref = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<MermaidResult | undefined>();
  const [showSource, setShowSource] = useState(false);
  const [zoom, setZoom] = useState(2);
  const [full, setFull] = useState(false);
  const theme = resolvedTheme.value;
  useEffect(() => {
    setResult(undefined);
    if (props.live || !ref.current || !source.trim()) return;
    let cancelled = false;
    const stop = whenVisible(ref.current, () => {
      void import("./engine.ts")
        .then((engine) => engine.render(source, theme))
        .catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        }))
        .then((next) => {
          if (!cancelled) setResult(next);
        });
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [source, theme, props.live]);
  useEffect(() => {
    if (!full) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFull(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [full]);
  const svg = result && "svg" in result ? result.svg : undefined;
  const error = result && "error" in result ? result.error : undefined;
  const scale = ZOOM_STEPS[zoom] ?? 1;
  const sourceView = <pre class={styles.source}>{source}</pre>;
  return (
    <figure class={styles.block} ref={ref}>
      <figcaption class={styles.header}>
        <span class={styles.label}>{title ?? "mermaid"}</span>
        <span class={styles.actions}>
          {svg ? (
            <>
              <button
                type="button"
                class={styles.action}
                aria-pressed={showSource}
                onClick={() => setShowSource(!showSource)}
              >
                {showSource ? t("mermaid.diagram") : t("mermaid.source")}
              </button>
              <button
                type="button"
                class={styles.action}
                aria-label={t("mermaid.zoomOut")}
                title={t("mermaid.zoomOut")}
                disabled={zoom === 0}
                onClick={() => setZoom(Math.max(0, zoom - 1))}
              >
                −
              </button>
              <button
                type="button"
                class={styles.action}
                title={t("mermaid.zoomReset")}
                onClick={() => setZoom(2)}
              >
                {Math.round(scale * 100)}%
              </button>
              <button
                type="button"
                class={styles.action}
                aria-label={t("mermaid.zoomIn")}
                title={t("mermaid.zoomIn")}
                disabled={zoom === ZOOM_STEPS.length - 1}
                onClick={() => setZoom(Math.min(ZOOM_STEPS.length - 1, zoom + 1))}
              >
                +
              </button>
              <button
                type="button"
                class={styles.action}
                onClick={() => exportSvg(svg, title?.replace(/[^\w-]+/g, "-") || "diagram")}
              >
                {t("mermaid.export")}
              </button>
              <button
                type="button"
                class={styles.action}
                aria-label={t("mermaid.fullscreen")}
                title={t("mermaid.fullscreen")}
                onClick={() => setFull(true)}
              >
                <Icon name="expand" size={14} />
              </button>
            </>
          ) : null}
          <CopyButton text={() => source} class={styles.action} showText />
        </span>
      </figcaption>
      {error ? (
        <div role="note">
          <p class={styles.error}>{t("mermaid.error", { message: error })}</p>
          {sourceView}
        </div>
      ) : svg && !showSource ? (
        <div class={styles.viewport} tabIndex={0}>
          <Diagram svg={svg} zoom={scale} />
        </div>
      ) : (
        sourceView
      )}
      {full && svg ? (
        <div
          class={styles.overlay}
          role="dialog"
          aria-modal="true"
          aria-label={title ?? t("mermaid.diagram")}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setFull(false);
          }}
        >
          <button
            type="button"
            class={`icon-btn ${styles.overlayClose}`}
            aria-label={t("common.close")}
            onClick={() => setFull(false)}
            autoFocus
          >
            <Icon name="x" size={18} />
          </button>
          <div class={styles.overlayBody}>
            <Diagram svg={svg} zoom={1} />
          </div>
        </div>
      ) : null}
    </figure>
  );
}
