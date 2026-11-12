/**
 * "Project settings" dialog (lazy chunk, loaded from a project's "…" menu): display name, folder
 * and full path, color, pinned, trust and archived. Name saves on "Save" or Enter; the rest
 * applies immediately, like the menu. Modal: focus trap, Escape, labelled title.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { patchWorkspace, setWorkspaceTrust, showToast, sidebar } from "../../store/app.ts";
import { useOverlayScrollbars } from "../../util/scrollbars.ts";
import { CopyButton } from "../CopyButton.tsx";
import { Icon } from "../icons.tsx";
import settings from "../settings/settings.module.css";
import { ColorPalette } from "./ColorPalette.tsx";
import styles from "./project-settings.module.css";
import { LABEL_MAX, labelPatch, labelProblem, projectSettingsFacts } from "./project-settings.ts";
import { ps } from "./project-strings.ts";

const FOCUSABLE = "button:not(:disabled), input:not(:disabled), [tabindex='0']";

function Switch(props: { label: string; checked: boolean; busy?: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      class={settings.switch}
      aria-checked={props.checked}
      aria-label={props.label}
      aria-busy={props.busy || undefined}
      disabled={props.busy}
      onClick={props.onChange}
    >
      <span class={settings.knob} />
    </button>
  );
}

export function ProjectSettings(props: { workspaceId: string; onClose: () => void }) {
  const workspace = sidebar.value.workspaces.find((w) => w.id === props.workspaceId);
  const [draft, setDraft] = useState(workspace?.label ?? "");
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<"pin" | "archive" | "trust" | undefined>();
  const dialog = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  useOverlayScrollbars(scroll);
  const name = useRef<HTMLInputElement>(null);

  useEffect(() => {
    name.current?.focus();
  }, []);
  // The project disappeared (for example a reload without it): nothing left to configure.
  useEffect(() => {
    if (!workspace) props.onClose();
  }, [workspace]);
  if (!workspace) return null;

  const facts = projectSettingsFacts(workspace);
  const problem = labelProblem(draft);
  const patch = labelPatch(draft, workspace);
  const save = async () => {
    if (!patch || saving) return;
    setSaving(true);
    const ok = await patchWorkspace(workspace.id, patch);
    setSaving(false);
    if (ok) showToast(ps("saved"));
  };
  const toggle = async (key: "pin" | "archive") => {
    setBusy(key);
    await patchWorkspace(workspace.id, key === "pin" ? facts.pinPatch : facts.archivePatch);
    setBusy(undefined);
  };
  const trust = async () => {
    setBusy("trust");
    await setWorkspaceTrust(workspace, !workspace.trusted);
    setBusy(undefined);
  };

  return (
    <div
      class={settings.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        ref={dialog}
        class={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-settings-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            props.onClose();
          }
          if (event.key === "Tab") {
            const items = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
            const first = items[0];
            const last = items.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header class={styles.head}>
          <h2 id="project-settings-title" class={styles.title}>
            {ps("title")}
          </h2>
          <button
            type="button"
            class="icon-btn"
            aria-label={ps("close")}
            title={ps("close")}
            onClick={props.onClose}
          >
            <Icon name="x" size={18} />
          </button>
        </header>
        <div ref={scroll} class={styles.body}>
          {facts.missing ? (
            <p class={styles.missing} role="status">
              {ps("missing")}
            </p>
          ) : null}

          <form
            class={styles.section}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label class={styles.label} for="project-name">
              {ps("nameLabel")}
            </label>
            <div class={styles.inline}>
              <input
                id="project-name"
                ref={name}
                class={styles.input}
                value={draft}
                placeholder={facts.folder}
                aria-invalid={problem ? true : undefined}
                aria-describedby="project-name-hint"
                maxLength={LABEL_MAX + 50}
                onInput={(event) => setDraft((event.target as HTMLInputElement).value)}
              />
              <button
                type="submit"
                class={settings.primary}
                disabled={!patch || saving}
                aria-busy={saving || undefined}
              >
                {saving ? ps("saving") : ps("save")}
              </button>
            </div>
            <p id="project-name-hint" class={styles.hint}>
              {ps("nameHint")}
            </p>
            {problem ? (
              <p class={settings.errorText} role="alert">
                {ps("tooLong")}
              </p>
            ) : null}
          </form>

          <section class={styles.section} aria-labelledby="project-folder">
            <h3 id="project-folder" class={styles.label}>
              {ps("folder")}
            </h3>
            <dl class={styles.facts}>
              <dt>{ps("folderName")}</dt>
              <dd>
                <code>{facts.folder}</code>
              </dd>
              <dt>{ps("path")}</dt>
              <dd class={styles.pathRow}>
                <code class={styles.path}>{facts.path}</code>
                <CopyButton text={() => facts.path} label={ps("copyPath")} />
              </dd>
            </dl>
          </section>

          <section class={styles.section} aria-labelledby="project-color">
            <h3 id="project-color" class={styles.label}>
              {ps("colorLabel")}
            </h3>
            <ColorPalette
              inline
              name={workspace.label ?? facts.folder}
              current={workspace.color}
              onPick={(color) => void patchWorkspace(workspace.id, { color })}
              onClose={() => {}}
            />
          </section>

          <ul class={styles.toggles}>
            <li class={styles.toggle}>
              <span class={styles.toggleText}>
                <strong>{ps("pinned")}</strong>
                <span class={styles.hint}>{ps("pinnedHint")}</span>
              </span>
              <Switch
                label={ps("pinned")}
                checked={workspace.pinned}
                busy={busy === "pin"}
                onChange={() => void toggle("pin")}
              />
            </li>
            {facts.missing ? null : (
              <li class={styles.toggle}>
                <span class={styles.toggleText}>
                  <strong>{ps("trusted")}</strong>
                  <span class={styles.hint}>{ps("trustedHint")}</span>
                </span>
                <Switch
                  label={`${ps("trusted")}: ${workspace.trusted ? ps("trustGranted") : ps("trustUntrusted")}`}
                  checked={workspace.trusted}
                  busy={busy === "trust"}
                  onChange={() => void trust()}
                />
              </li>
            )}
            <li class={styles.toggle}>
              <span class={styles.toggleText}>
                <strong>{ps("archived")}</strong>
                <span class={styles.hint}>{ps("archivedHint")}</span>
              </span>
              <Switch
                label={ps("archived")}
                checked={workspace.archived}
                busy={busy === "archive"}
                onChange={() => void toggle("archive")}
              />
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
