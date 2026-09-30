/**
 * In-app folder browser for "Open a workspace" (the fallback when the server has no native
 * dialog). Lists subdirectory names from `GET /api/fs/dirs`; breadcrumbs and parents come from the
 * server, so Windows drives and backslashes need no client-side path logic.
 */
import type { DirectoryListing } from "@alisio/sdk";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { addWorkspace, api } from "../../store/app.ts";
import { errorText } from "../../store/errors.ts";
import { Icon } from "../icons.tsx";
import styles from "./folder-browser.module.css";

export function FolderBrowser(props: { onClose: () => void; onTypePath: () => void }) {
  const [listing, setListing] = useState<DirectoryListing | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const request = useRef(0);

  const load = async (path?: string, showHidden = hidden) => {
    const mine = ++request.current;
    setBusy(true);
    try {
      const next = await api.listDirs(path, showHidden);
      if (mine !== request.current) return;
      setListing(next);
      setError(undefined);
    } catch (failure) {
      if (mine === request.current) setError(errorText(failure));
    } finally {
      if (mine === request.current) setBusy(false);
    }
  };

  useEffect(() => {
    void load();
    dialog.current?.focus();
  }, []);

  const windows = listing?.separator === "\\";
  const canOpen = !!listing && listing.path !== "";
  const open = async () => {
    if (!listing || !canOpen) return;
    setBusy(true);
    if (await addWorkspace(listing.path)) props.onClose();
    else setBusy(false);
  };

  return (
    <div
      class={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        ref={dialog}
        class={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-browser-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onClose();
        }}
      >
        <header class={styles.head}>
          <h2 id="folder-browser-title" class={styles.title}>
            {t("browser.title")}
          </h2>
          <button
            type="button"
            class="icon-btn"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={props.onClose}
          >
            <Icon name="x" />
          </button>
        </header>
        <div class={styles.toolbar}>
          <button
            type="button"
            class="icon-btn"
            aria-label={t("browser.up")}
            title={t("browser.up")}
            disabled={listing?.parent === undefined || busy}
            onClick={() => void load(listing?.parent)}
          >
            <Icon name="arrowUp" />
          </button>
          <button
            type="button"
            class="icon-btn"
            aria-label={t("browser.home")}
            title={t("browser.home")}
            disabled={busy}
            onClick={() => void load(listing?.home)}
          >
            <Icon name="home" />
          </button>
          <nav class={styles.crumbs} aria-label={t("browser.breadcrumbs")}>
            {windows ? (
              <button type="button" class={styles.crumb} onClick={() => void load("")}>
                {t("browser.drives")}
              </button>
            ) : null}
            {listing?.segments.map((segment, index) => (
              <span key={segment.path} class={styles.crumbItem}>
                {index > 0 || windows ? (
                  <Icon name="chevronRight" size={12} class={styles.crumbSep} />
                ) : null}
                <button
                  type="button"
                  class={styles.crumb}
                  aria-current={segment.path === listing.path ? "location" : undefined}
                  onClick={() => void load(segment.path)}
                >
                  {segment.name}
                </button>
              </span>
            ))}
          </nav>
        </div>
        <div class={styles.list} aria-busy={busy}>
          {error ? (
            <p class={styles.error} role="alert">
              {error}
            </p>
          ) : !listing ? (
            <p class={styles.note}>{t("common.loading")}</p>
          ) : listing.entries.length ? (
            <ul class={styles.entries}>
              {listing.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    class={styles.entry}
                    data-hidden={entry.hidden ? "true" : undefined}
                    onClick={() => void load(entry.path)}
                  >
                    <Icon name="folder" size={16} />
                    <span class={styles.entryName}>{entry.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p class={styles.note}>{t("browser.empty")}</p>
          )}
          {listing?.truncated ? (
            <p class={styles.note}>{t("browser.truncated", { count: listing.entries.length })}</p>
          ) : null}
        </div>
        <footer class={styles.foot}>
          <label class={styles.hidden}>
            <input
              type="checkbox"
              checked={hidden}
              onChange={(event) => {
                const next = (event.target as HTMLInputElement).checked;
                setHidden(next);
                void load(listing?.path, next);
              }}
            />
            {t("browser.hidden")}
          </label>
          <output class={styles.current} aria-label={t("browser.path")} title={listing?.path}>
            {listing?.path || t("browser.drives")}
          </output>
          <div class={styles.actions}>
            <button type="button" class={styles.link} onClick={props.onTypePath}>
              {t("sidebar.typePath")}
            </button>
            <button
              type="button"
              class={styles.primary}
              disabled={!canOpen || busy}
              onClick={() => void open()}
            >
              {t("browser.open")}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
