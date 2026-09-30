/** Building blocks shared by the settings pages: data loading, switches, pills and choices. */
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { type MessageKey, t } from "../../i18n/index.ts";
import { catalogTick, detail, sidebar } from "../../store/app.ts";
import styles from "./settings.module.css";

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The workspace the settings manage: the open session's, else the first known one. */
export function settingsWorkspace(): { id: string; path: string } | undefined {
  const session = detail.value;
  if (session) return { id: session.workspaceId, path: session.workspace };
  const first = sidebar.value.workspaces[0];
  return first ? { id: first.id, path: first.path } : undefined;
}

export interface Loaded<T> {
  data?: T;
  error?: string;
  loading: boolean;
  reload(): void;
  set(data: T): void;
}

/**
 * Loads `load()` and reloads it when `deps` change or a `catalog_changed` frame of one of
 * `scopes` arrives (another tab, the TUI's own changes stay local to its process).
 */
export function useLoad<T>(
  load: (() => Promise<T>) | undefined,
  deps: unknown[],
  scopes: string[] = [],
): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({
    loading: !!load,
  });
  const [nonce, setNonce] = useState(0);
  const ticks = scopes.map((scope) => catalogTick.value[scope] ?? 0).join(",");
  // The dependency list is the caller's keys plus the catalog ticks and manual reloads.
  useEffect(() => {
    if (!load) {
      setState({ loading: false });
      return;
    }
    let alive = true;
    setState((previous) => ({ ...previous, loading: true }));
    load().then(
      (data) => alive && setState({ data, loading: false }),
      (error: unknown) => alive && setState({ error: errorMessage(error), loading: false }),
    );
    return () => {
      alive = false;
    };
  }, [...deps, ticks, nonce]);
  return {
    ...state,
    reload: () => setNonce((n) => n + 1),
    set: (data) => setState({ data, loading: false }),
  };
}

export function Switch(props: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  busy?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      class={styles.switch}
      aria-checked={props.checked}
      aria-label={props.label}
      aria-busy={props.busy || undefined}
      disabled={props.disabled || props.busy}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class={styles.knob} />
    </button>
  );
}

export type PillTone = "ok" | "off" | "warn" | "danger";

export function Pill(props: { tone: PillTone; children: ComponentChildren }) {
  return (
    <span class={styles.pill} data-tone={props.tone}>
      {props.tone === "ok" ? <span class={styles.pillDot} aria-hidden="true" /> : null}
      {props.children}
    </span>
  );
}

export function Choice<T extends string>(props: {
  legend: string;
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset class={styles.fieldset}>
      <legend class={styles.legend}>{props.legend}</legend>
      <div class={styles.choices}>
        {props.options.map((option) => (
          <label key={option.id} class={styles.choice}>
            <input
              type="radio"
              name={props.legend}
              checked={props.value === option.id}
              onChange={() => props.onChange(option.id)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Loading, error and "no workspace" states around a page body. */
export function Status(props: { loading?: boolean; error?: string; empty?: MessageKey }) {
  if (props.error)
    return (
      <p class={styles.errorText} role="alert">
        {props.error}
      </p>
    );
  if (props.loading) return <p class={styles.note}>{t("common.loading")}</p>;
  if (props.empty) return <p class={styles.note}>{t(props.empty)}</p>;
  return null;
}

export function PageIntro(props: { title: string; body?: string; workspace?: string }) {
  return (
    <header class={styles.intro}>
      <h3 class={styles.pageTitle}>{props.title}</h3>
      {props.body ? <p class={styles.lead}>{props.body}</p> : null}
      {props.workspace ? (
        <p class={styles.scope} title={props.workspace}>
          {t("settings.workspace", { path: props.workspace })}
        </p>
      ) : null}
    </header>
  );
}

export function SearchBox(props: { value: string; label: string; onInput: (v: string) => void }) {
  return (
    <label class={styles.search}>
      <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        />
      </svg>
      <input
        type="search"
        placeholder={props.label}
        aria-label={props.label}
        value={props.value}
        onInput={(event) => props.onInput((event.target as HTMLInputElement).value)}
      />
    </label>
  );
}
