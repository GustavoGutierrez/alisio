import type { ArtifactRef } from "@alisio/sdk";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import type { ArtifactDetail } from "../../net/api.ts";
import { api, currentId, toast } from "../../store/app.ts";
import {
  artifactPanel,
  artifactsBySession,
  closeArtifactPanel,
  deleteArtifact,
  exportArtifact,
  goneError,
  loadArtifacts,
  openArtifact,
  requestViewUrl,
  rerunArtifact,
  setOpenError,
  unseen,
} from "../../store/artifacts.ts";
import { setPanelExpanded } from "../../store/layout.ts";
import { ARTIFACT_ICONS, downloadUrl } from "../../util/artifacts.ts";
import { rendererFor } from "../../util/panel.ts";
import { Icon, type IconName } from "../icons.tsx";
import { ArtifactDetails } from "./ArtifactDetails.tsx";
import { ArtifactMenu, type MenuAction } from "./ArtifactMenu.tsx";
import { DownloadFallback } from "./DownloadFallback.tsx";
import { HtmlFrame } from "./HtmlFrame.tsx";
import { ImageView } from "./ImageView.tsx";
import { LazySpreadsheet } from "./LazySpreadsheet.tsx";
import { PdfFrame } from "./PdfFrame.tsx";
import styles from "./panel.module.css";
import { TextPreview } from "./TextPreview.tsx";

/** The id the cards' `aria-controls` point to. */
export const PANEL_ID = "artifact-panel";
const TITLE_ID = "artifact-panel-title";

type Loaded =
  | { status: "loading" }
  | { status: "ready"; detail: ArtifactDetail }
  | { status: "gone"; detail?: ArtifactDetail }
  | { status: "error"; message: string };

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

function Preview(props: { detail: ArtifactDetail }) {
  const { detail } = props;
  const entry = detail.entry ?? detail.fileName;
  const choice = rendererFor(detail);
  switch (choice.kind) {
    case "html":
      return <HtmlFrame artifact={detail} />;
    case "pdf":
      return <PdfFrame artifact={detail} />;
    case "image":
      return <ImageView artifact={detail} entry={entry} />;
    case "spreadsheet":
      return <LazySpreadsheet key={detail.id} artifactId={detail.id} name={detail.fileName} />;
    case "markdown":
    case "json":
    case "code":
      return <TextPreview key={detail.id} artifact={detail} entry={entry} as={choice.kind} />;
    default:
      return <DownloadFallback artifact={detail} reason={choice.reason} />;
  }
}

/** "Copy to workspace…": a folder relative to the workspace, then the write gate asks. */
function ExportForm(props: { artifact: ArtifactRef; onDone: () => void }) {
  const [target, setTarget] = useState(".");
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <form
      class={styles.sheet}
      aria-label={t("artifactPanel.exportTitle")}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        const ok = await exportArtifact(props.artifact.id, target, overwrite);
        setBusy(false);
        if (ok) {
          toast.value = t("artifactPanel.exportStarted", { name: props.artifact.fileName });
          props.onDone();
        }
      }}
    >
      <h3>{t("artifactPanel.exportTitle")}</h3>
      <label>
        {t("artifactPanel.exportTarget")}
        <input
          ref={input}
          type="text"
          value={target}
          spellcheck={false}
          autocomplete="off"
          onInput={(event) => setTarget((event.currentTarget as HTMLInputElement).value)}
        />
      </label>
      <p class={styles.hint}>{t("artifactPanel.exportHint")}</p>
      <label class={styles.check}>
        <input
          type="checkbox"
          checked={overwrite}
          onChange={(event) => setOverwrite((event.currentTarget as HTMLInputElement).checked)}
        />
        {t("artifactPanel.overwrite")}
      </label>
      <div class={styles.row}>
        <button type="button" class={styles.button} onClick={props.onDone}>
          {t("common.cancel")}
        </button>
        <button type="submit" class={`${styles.button} ${styles.primary}`} disabled={busy}>
          {t("artifactPanel.exportSubmit")}
        </button>
      </div>
    </form>
  );
}

/**
 * The artifact panel (spec §15.3–15.4) in the right slot: a title that switches artifacts, then
 * Download, Full screen and Close; one preview per kind; Details, Copy to workspace, analysis
 * sources and Delete from the title's menu. Below 900 px it is a full-screen modal dialog.
 */
export function ArtifactPanel(props: {
  width?: number;
  narrow: boolean;
  expanded: boolean;
  /** A modal (Settings, Agents) covers the app: the panel stays mounted but inert. */
  inert: boolean;
}) {
  const state = artifactPanel.value;
  const session = currentId.value;
  const list = (session ? artifactsBySession.value[session] : undefined) ?? [];
  const id = state?.id;
  const dataset = state?.dataset;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [listOpen, setListOpen] = useState(!!state?.listOpen || (!id && !dataset));
  const [sheet, setSheet] = useState<"export" | "details" | "delete" | undefined>();
  const [fullscreen, setFullscreen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const ref = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setListOpen(!!state?.listOpen || (!state?.id && !state?.dataset));
  }, [state]);
  useEffect(() => {
    setSheet(undefined);
    if (!id) return;
    let alive = true;
    setLoaded({ status: "loading" });
    api.artifact(id).then(
      (detail) => {
        if (!alive) return;
        if (detail.status !== "ready") {
          setLoaded({ status: "gone", detail });
          setListOpen(true);
        } else setLoaded({ status: "ready", detail });
      },
      (error: unknown) => {
        if (!alive) return;
        const message = error instanceof Error ? error.message : String(error);
        if (goneError(error)) {
          setOpenError(id, message);
          setLoaded({ status: "gone" });
          setListOpen(true);
        } else setLoaded({ status: "error", message });
      },
    );
    return () => {
      alive = false;
    };
  }, [id, attempt]);
  useEffect(() => {
    // Opening (or switching) moves focus into the panel, on its title, unless the switcher
    // opened with it (`/artifacts`): then its filter or list keeps the focus.
    if (!artifactPanel.peek()?.listOpen) titleRef.current?.focus();
  }, [id]);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === ref.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const detail = loaded.status === "ready" ? loaded.detail : undefined;
  const fromList = list.find((artifact) => artifact.id === id);
  const shown: ArtifactRef | undefined = detail ?? fromList;
  const kind = shown ? t(`artifact.kind.${shown.kind}` as Parameters<typeof t>[0]) : "";
  const viewable =
    !!detail && (detail.kind === "dashboard" || detail.mimeType === "application/pdf");

  const close = () => {
    if (document.fullscreenElement === ref.current) void document.exitFullscreen?.();
    closeArtifactPanel();
  };
  const toggleFullscreen = () => {
    const panel = ref.current;
    if (!panel) return;
    if (document.fullscreenElement === panel) {
      void document.exitFullscreen();
      return;
    }
    if (typeof panel.requestFullscreen !== "function" || document.fullscreenEnabled === false) {
      // No Fullscreen API: behave like "Expand panel".
      setPanelExpanded(!props.expanded);
      return;
    }
    panel.requestFullscreen().catch(() => setPanelExpanded(!props.expanded));
  };
  const closeList = () => {
    setListOpen(false);
    titleRef.current?.focus();
  };
  const goneDetail = loaded.status === "gone" ? loaded.detail : undefined;
  const hasScript = (candidate?: ArtifactDetail) =>
    typeof candidate?.provenance.executionId === "string";
  const rerunAction = (candidate: ArtifactDetail): MenuAction => ({
    key: "rerun",
    label: t("artifactPanel.rerun"),
    icon: "refresh" as IconName,
    onSelect: () => {
      setListOpen(false);
      void rerunArtifact(candidate.id, candidate.fileName);
    },
  });
  const detailsAction = (): MenuAction => ({
    key: "details",
    label: t("artifactPanel.details"),
    icon: "info",
    onSelect: () => {
      setSheet(sheet === "details" ? undefined : "details");
      setListOpen(false);
    },
  });
  // An expired artifact (retention removed its files) keeps Details and Run again.
  const actions: MenuAction[] = !detail
    ? goneDetail?.status === "expired"
      ? [detailsAction(), ...(hasScript(goneDetail) ? [rerunAction(goneDetail)] : [])]
      : []
    : [
        ...(viewable
          ? [
              {
                key: "tab",
                label: t("artifactPanel.openNewTab"),
                icon: "globe" as IconName,
                onSelect: () => {
                  // Opened synchronously (popup blockers), navigated once the link is ready.
                  const tab = window.open("about:blank", "_blank");
                  setListOpen(false);
                  requestViewUrl(detail.id).then(
                    (url) => {
                      if (tab) {
                        tab.opener = null;
                        tab.location.href = url;
                      }
                    },
                    () => tab?.close(),
                  );
                },
              },
            ]
          : []),
        ...(!props.narrow
          ? [
              {
                key: "expand",
                label: t(props.expanded ? "artifactPanel.restore" : "artifactPanel.expand"),
                icon: (props.expanded ? "shrink" : "expand") as IconName,
                onSelect: () => {
                  setPanelExpanded(!props.expanded);
                  setListOpen(false);
                },
              },
            ]
          : []),
        ...(typeof detail.provenance.executionId === "string"
          ? [
              {
                key: "sources",
                label: t("artifactPanel.sources"),
                icon: "terminal" as IconName,
                href: api.artifactSourcesUrl(detail.id),
                download: true,
              },
            ]
          : []),
        {
          key: "export",
          label: t("artifactPanel.export"),
          icon: "folder",
          onSelect: () => {
            setSheet("export");
            setListOpen(false);
          },
        },
        detailsAction(),
        ...(hasScript(detail) ? [rerunAction(detail)] : []),
        {
          key: "delete",
          label: t("artifactPanel.delete"),
          icon: "x",
          danger: true,
          onSelect: () => {
            setSheet("delete");
            setListOpen(false);
          },
        },
      ];

  return (
    <aside
      ref={ref}
      id={PANEL_ID}
      class={styles.panel}
      style={
        props.width && !props.expanded && !props.narrow ? { width: `${props.width}px` } : undefined
      }
      data-expanded={props.expanded ? "true" : undefined}
      data-narrow={props.narrow ? "true" : undefined}
      role={props.narrow ? "dialog" : "complementary"}
      aria-modal={props.narrow ? "true" : undefined}
      aria-labelledby={TITLE_ID}
      inert={props.inert}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          // The open menu first, then an inline sheet, then the panel itself.
          event.preventDefault();
          if (listOpen && id) closeList();
          else if (sheet) setSheet(undefined);
          else close();
          return;
        }
        if (event.key === "Tab" && props.narrow && ref.current) {
          // Modal on narrow screens: focus stays inside the dialog.
          const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
            (element) => element.offsetParent !== null || element === document.activeElement,
          );
          const first = items[0];
          const last = items.at(-1);
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }}
    >
      {props.narrow ? (
        // Focus trap sentinels: they also catch Tab leaving the iframe (its keys never reach us).
        <span
          tabIndex={0}
          class="sr-only"
          onFocus={() => {
            const items = ref.current?.querySelectorAll<HTMLElement>(
              "header button, header a[href]",
            );
            items?.[items.length - 1]?.focus();
          }}
        />
      ) : null}
      <header class={styles.head}>
        <button
          ref={titleRef}
          id={TITLE_ID}
          type="button"
          class={styles.titleButton}
          aria-haspopup="listbox"
          aria-expanded={listOpen}
          title={dataset?.name ?? shown?.fileName ?? t("artifactPanel.label")}
          onClick={() => (listOpen ? closeList() : setListOpen(true))}
        >
          {shown || dataset ? (
            <span class={styles.kindIcon}>
              <Icon
                name={
                  (dataset ? "fileTable" : ARTIFACT_ICONS[(shown as ArtifactRef).kind]) as IconName
                }
                size={17}
              />
            </span>
          ) : null}
          <span class={styles.titleText}>
            {dataset ? dataset.name : shown ? shown.title : t("artifactPanel.label")}
            <span class="sr-only">
              {shown ? `, ${kind}. ` : ". "}
              {t("artifactPanel.switch")}
            </span>
          </span>
          <Icon name="chevronDown" size={14} />
        </button>
        <div class={styles.actions}>
          {detail ? (
            <a
              class={styles.iconButton}
              href={downloadUrl(detail.id)}
              download=""
              aria-label={t("artifact.downloadNamed", { name: detail.fileName })}
              title={t("artifact.download")}
            >
              <Icon name="download" size={16} />
            </a>
          ) : null}
          <button
            type="button"
            class={styles.iconButton}
            aria-pressed={fullscreen}
            aria-label={t(fullscreen ? "artifactPanel.exitFullscreen" : "artifactPanel.fullscreen")}
            title={t(fullscreen ? "artifactPanel.exitFullscreen" : "artifactPanel.fullscreen")}
            onClick={toggleFullscreen}
          >
            <Icon name={fullscreen ? "shrink" : "expand"} size={16} />
          </button>
          <button
            type="button"
            class={styles.iconButton}
            aria-label={t("artifactPanel.close")}
            title={t("artifactPanel.close")}
            onClick={close}
          >
            <Icon name="x" size={16} />
          </button>
        </div>
        {listOpen ? (
          <ArtifactMenu
            id={`${PANEL_ID}-switcher`}
            list={list}
            {...(id ? { current: id } : {})}
            unseen={unseen.value}
            {...(state?.filter ? { initialFilter: state.filter } : {})}
            actions={actions}
            onPick={(next) => {
              setListOpen(false);
              if (next === id) titleRef.current?.focus();
              else openArtifact(next);
            }}
            onClose={closeList}
          />
        ) : null}
      </header>
      {sheet === "export" && detail ? (
        <ExportForm artifact={detail} onDone={() => setSheet(undefined)} />
      ) : null}
      {sheet === "details" && (detail ?? goneDetail) ? (
        <ArtifactDetails detail={(detail ?? goneDetail) as ArtifactDetail} />
      ) : null}
      {sheet === "delete" && detail ? (
        <div class={styles.sheet} role="alertdialog" aria-label={t("artifactPanel.delete")}>
          <p>{t("artifactPanel.deleteConfirm", { name: detail.fileName })}</p>
          <div class={styles.row}>
            <button
              type="button"
              class={styles.button}
              onClick={() => setSheet(undefined)}
              ref={(element) => element?.focus()}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              class={`${styles.button} ${styles.danger}`}
              onClick={async () => {
                try {
                  await deleteArtifact(detail.id);
                  setSheet(undefined);
                  setLoaded({ status: "gone" });
                  setListOpen(true);
                } catch (error) {
                  toast.value = error instanceof Error ? error.message : String(error);
                }
              }}
            >
              {t("artifactPanel.delete")}
            </button>
          </div>
        </div>
      ) : null}
      <div class={styles.body}>
        {dataset ? (
          <LazySpreadsheet key={dataset.id} dataset={dataset} />
        ) : !id ? (
          list.some((artifact) => artifact.status === "ready") ? null : (
            <div class={styles.state}>{t("artifactPanel.empty")}</div>
          )
        ) : loaded.status === "loading" ? (
          <div class={styles.state} aria-busy="true">
            {t("artifact.loading")}
          </div>
        ) : loaded.status === "error" ? (
          <div class={`${styles.state} ${styles.stateError}`} role="status">
            <p>{t("artifactPanel.loadFailed")}</p>
            <p>{loaded.message}</p>
            <button
              type="button"
              class={styles.button}
              onClick={() => {
                setAttempt((n) => n + 1);
                if (session) void loadArtifacts(session);
              }}
            >
              {t("artifact.retry")}
            </button>
          </div>
        ) : loaded.status === "gone" ? (
          <div class={styles.state} role="status">
            <p>
              {loaded.detail?.status === "expired" ? t("artifact.expired") : t("artifact.deleted")}
            </p>
            <p>
              {loaded.detail?.status === "expired"
                ? t("artifactPanel.expiredHint")
                : t("artifactPanel.gone")}
            </p>
          </div>
        ) : (
          <Preview detail={loaded.detail} />
        )}
      </div>
      {props.narrow ? (
        <span tabIndex={0} class="sr-only" onFocus={() => titleRef.current?.focus()} />
      ) : null}
    </aside>
  );
}
