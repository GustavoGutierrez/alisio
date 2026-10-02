/**
 * `/changelog [version]`: the shipped changelog (offline) in a dialog. The newest entries by
 * default, or the one version asked for. Esc and a click outside close it and the focus returns
 * to where it was (the composer).
 */
import type { ChangelogView } from "@alisio/sdk";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { api, changelogRequest, focusComposer } from "../../store/app.ts";
import { Icon } from "../icons.tsx";
import settings from "../settings/settings.module.css";
import styles from "./changelog.module.css";

/** Renders `code` spans of a changelog item (the only Markdown the changelog uses). */
const inlineCode = (text: string) =>
  text
    .split(/(`[^`]+`)/)
    .map((part, index) =>
      part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
        <code key={index}>{part.slice(1, -1)}</code>
      ) : (
        part
      ),
    );

export function ChangelogDialog(props: { version: string }) {
  const root = useRef<HTMLDivElement>(null);
  const version = props.version;
  const [state, setState] = useState<{ view?: ChangelogView; error?: boolean }>({});
  useEffect(() => {
    let alive = true;
    setState({});
    api.changelog(version ? { version } : {}).then(
      (view) => alive && setState({ view }),
      () => alive && setState({ error: true }),
    );
    return () => {
      alive = false;
    };
  }, [version]);
  useEffect(() => {
    root.current?.focus();
    return () => {
      focusComposer.value++;
    };
  }, []);
  const close = () => {
    changelogRequest.value = undefined;
  };
  const view = state.view;
  return (
    <div
      class={settings.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={root}
        class={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="changelog-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
      >
        <div class={styles.head}>
          <div>
            <h3 class={styles.title} id="changelog-title">
              {t("changelog.title")}
            </h3>
            {view ? <p class={styles.lead}>{view.current}</p> : null}
          </div>
          <button type="button" class="icon-btn" aria-label={t("common.close")} onClick={close}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div class={styles.body}>
          {state.error ? (
            <p class={styles.note} role="alert">
              {t("changelog.loadFailed")}
            </p>
          ) : !view ? (
            <p class={styles.note}>{t("common.loading")}</p>
          ) : !view.found ? (
            <p class={styles.note}>{t("changelog.notFound", { version })}</p>
          ) : (
            view.entries.map((entry) => (
              <section key={entry.version} class={styles.entry}>
                <h4 class={styles.version}>
                  {entry.date ? `${entry.version} · ${entry.date}` : entry.version}
                  {entry.unreleased ? (
                    <span class={styles.badge}>{t("changelog.unreleased")}</span>
                  ) : null}
                </h4>
                {entry.sections.map((section) => (
                  <div key={section.title}>
                    <p class={styles.section}>{section.title}</p>
                    <ul class={styles.items}>
                      {section.items.map((item) => (
                        <li key={item}>{inlineCode(item)}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
