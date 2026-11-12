/**
 * "Share your plugin": a short step-by-step for sharing the .tgz privately or publishing on npm,
 * with copy buttons on every command and the project folder, and how to reach the Alisio catalog.
 * A modal dialog: focus moves in and is trapped, Escape closes, focus returns to the opener.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { copyText } from "../../util/clipboard.ts";
import { Icon } from "../icons.tsx";
import styles from "./creator.module.css";
import { shareCommands } from "./model.ts";
import { cr } from "./strings.ts";

const FOCUSABLE = "button:not(:disabled), a[href], input, textarea, select, [tabindex='0']";

/** A modal shell with the page's styles (focus trap, Escape, backdrop click). */
export function Dialog(props: {
  title: string;
  icon?: ComponentChildren;
  children: ComponentChildren;
  footer?: ComponentChildren;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => previous?.focus();
  }, []);
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...(root.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };
  return (
    <div
      class={styles.scrim}
      onKeyDown={keys}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        ref={root}
        class={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="creator-dialog-title"
      >
        <div class={styles.dialogHead}>
          {props.icon}
          <h2 id="creator-dialog-title">{props.title}</h2>
          <button
            type="button"
            class="icon-btn"
            aria-label={cr("close")}
            title={cr("close")}
            onClick={props.onClose}
          >
            <Icon name="x" size={16} />
          </button>
        </div>
        <div class={styles.dialogBody}>{props.children}</div>
        {props.footer ? <div class={styles.dialogFoot}>{props.footer}</div> : null}
      </div>
    </div>
  );
}

function Command({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div class={styles.cmd}>
      <code>{text}</code>
      <button
        type="button"
        class={styles.ghost}
        onClick={async () => {
          if (await copyText(text)) {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          }
        }}
      >
        <Icon name={done ? "check" : "copy"} size={14} />
        <span aria-live="polite">{done ? cr("copied") : cr("copy")}</span>
      </button>
    </div>
  );
}

export function ShareDialog(props: {
  dir: string | undefined;
  onDownload: () => void;
  onClose: () => void;
}) {
  const cmds = shareCommands(props.dir ?? ".");
  return (
    <Dialog
      title={cr("shareTitle")}
      icon={<Icon name="share" size={18} />}
      onClose={props.onClose}
      footer={
        <button type="button" class={styles.primary} onClick={props.onClose}>
          {cr("close")}
        </button>
      }
    >
      <p class={styles.lead}>{cr("shareLead")}</p>

      <h3>
        <Icon name="download" size={16} />
        {cr("sharePrivateTitle")}
      </h3>
      <ol class={styles.ol}>
        <li>
          {cr("sharePrivate1")}{" "}
          <button type="button" class={styles.linkButton} onClick={props.onDownload}>
            {cr("download")}
          </button>
        </li>
        <li>{cr("sharePrivate2")}</li>
        <li>{cr("sharePrivate3")}</li>
      </ol>

      <h3>
        <Icon name="globe" size={16} />
        {cr("shareNpmTitle")}
      </h3>
      <p class={styles.muted}>{cr("shareNpmLead")}</p>
      <ol class={styles.ol}>
        <li>
          {cr("shareNpm1")}{" "}
          <a href="https://www.npmjs.com/signup" target="_blank" rel="noopener noreferrer">
            npmjs.com
          </a>
        </li>
        <li>
          {cr("shareNpm2")}
          <Command text={cmds.login} />
        </li>
        <li>
          {cr("shareNpm3")}
          {props.dir ? (
            <>
              <span class={`${styles.muted} ${styles.small}`}> ({cr("shareFolder")})</span>
              <Command text={props.dir} />
            </>
          ) : null}
          <Command text={cmds.cd} />
        </li>
        <li>
          {cr("shareNpm4")}
          <Command text={cmds.publish} />
        </li>
        <li>
          {cr("shareNpm5")}
          <Command text={cmds.bump} />
          <Command text={cmds.publish} />
        </li>
      </ol>

      <h3>
        <Icon name="sparkle" size={16} />
        {cr("shareCatalogTitle")}
      </h3>
      <p>{cr("shareCatalog")}</p>
      <p class={styles.links}>
        <a href="https://github.com/GustavoGutierrez" target="_blank" rel="noopener noreferrer">
          <Icon name="github" size={14} /> GitHub
        </a>
        <a
          href="https://www.linkedin.com/in/gustavo-gutierrez-mercado"
          target="_blank"
          rel="noopener noreferrer"
        >
          LinkedIn
        </a>
      </p>
      <p class={styles.callout} data-tone="ok">
        <Icon name="sparkle" size={16} />
        <span>{cr("shareEncourage")}</span>
      </p>
    </Dialog>
  );
}
