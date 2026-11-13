/**
 * The rows of "Connected" (Mis MCP, specs/030 phase 3): one MCP server per row with the two
 * separate dimensions of D13 (where it runs, where it is available) as text plus icon, the state of
 * the installation and of the last connection test, and the actions that apply: connect, switch,
 * check connection and a scope-aware removal. Hook-free so the web tests can walk it.
 */
import type { McpServerWire } from "@alisio/sdk";
import { useState } from "preact/hooks";
import { Icon } from "../../icons.tsx";
import { ConfirmDialog } from "../ConfirmDialog.tsx";
import styles from "../settings.module.css";
import { Pill, type PillTone, Switch } from "../shared.tsx";
import css from "./install.module.css";
import { badgesOf, removalOf } from "./model.ts";
import { checkedAgo, ms } from "./strings.ts";

const STATE_TONE: Record<string, PillTone> = {
  "state.connected": "ok",
  "state.installed": "off",
  "state.pending": "warn",
};

export interface MineRowProps {
  server: McpServerWire;
  workspaceName: string;
  granted: boolean;
  readOnly: boolean;
  busy: boolean;
  testing: boolean;
  /** Existing technical line (transport, counts) and the connect label come from the page. */
  meta: string;
  connectLabel: string;
  switchLabel: string;
  needsGrantHint: string;
  onConnect: () => void;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onRemove: () => void;
}

export function MineRow(props: MineRowProps) {
  const { server } = props;
  const badges = badgesOf(server, props.workspaceName);
  const removal = removalOf(server, props.workspaceName);
  const diagnostic = server.diagnostic ?? server.binding?.lastTest?.diagnostic;
  return (
    <li class={styles.row}>
      <div class={styles.rowMain}>
        <div class={styles.rowTitle}>
          <span class={styles.cardName}>{server.displayName}</span>
          <Pill tone={STATE_TONE[badges.install] ?? "off"}>{ms(badges.install)}</Pill>
        </div>
        <div class={css.badges}>
          <span class={css.badge}>
            <Icon name={badges.execution.icon === "cloud" ? "globe" : "terminal"} size={13} />
            {ms(badges.execution.key)}
          </span>
          <span class={css.badge}>
            <Icon
              name={
                server.binding?.scope === "project" || server.source === "project"
                  ? "folder"
                  : "layers"
              }
              size={13}
            />
            {ms(badges.scope.key, badges.scope.params)}
          </span>
          <span
            class={css.badge}
            data-tone={
              badges.test === "test.ready"
                ? "ok"
                : badges.test === "test.attention"
                  ? "warn"
                  : undefined
            }
          >
            {props.testing ? ms("test.checking") : ms(badges.test)}
          </span>
        </div>
        {badges.testedAt && !props.testing ? (
          <p class={css.checked}>{checkedAgo(badges.testedAt)}</p>
        ) : null}
        <p class={styles.meta}>{props.meta}</p>
        {diagnostic ? <p class={styles.diagnostic}>{diagnostic}</p> : null}
        {!removal && server.editable ? <p class={css.checked}>{ms("mine.manual")}</p> : null}
      </div>
      <div class={styles.rowActions}>
        {server.enabled && server.status !== "connected" ? (
          <button
            type="button"
            class={styles.secondary}
            disabled={!props.granted || props.busy}
            title={props.granted ? undefined : props.needsGrantHint}
            onClick={props.onConnect}
          >
            {props.connectLabel}
          </button>
        ) : null}
        {server.binding ? (
          <button
            type="button"
            class={styles.secondary}
            disabled={!props.granted || props.testing || props.readOnly}
            title={props.granted ? undefined : props.needsGrantHint}
            onClick={props.onTest}
          >
            {ms("action.test")}
          </button>
        ) : null}
        {removal ? (
          <button
            type="button"
            class={styles.secondary}
            disabled={props.readOnly || props.busy}
            onClick={props.onRemove}
          >
            {ms(removal.buttonKey)}
          </button>
        ) : null}
        <Switch
          checked={server.enabled}
          label={props.switchLabel}
          disabled={props.readOnly}
          busy={props.busy}
          onChange={props.onToggle}
        />
      </div>
    </li>
  );
}

/** A short, contextual confirmation: it says what is removed, where, and what stays. */
export function RemoveDialog(props: {
  server: McpServerWire;
  workspaceName: string;
  onConfirm: (removeSecrets: boolean) => void;
  onCancel: () => void;
}) {
  const removal = removalOf(props.server, props.workspaceName);
  const [secrets, setSecrets] = useState(true);
  if (!removal) return null;
  return (
    <ConfirmDialog
      title={ms(removal.titleKey, { name: props.server.displayName })}
      confirmLabel={ms(removal.confirmKey)}
      cancelLabel={ms("remove.cancel")}
      danger
      {...(removal.secretsOption
        ? { checkbox: { label: ms("remove.secrets"), checked: secrets, onChange: setSecrets } }
        : {})}
      onConfirm={() => props.onConfirm(removal.secretsOption && secrets)}
      onCancel={props.onCancel}
    >
      <p>{ms(removal.bodyKey, removal.params)}</p>
      {removal.revealsGlobal ? <p>{ms("remove.reveals")}</p> : null}
      {removal.scope === "global" || !removal.remote ? <p>{ms("remove.shared")}</p> : null}
      {removal.remote ? <p>{ms("remove.account")}</p> : null}
    </ConfirmDialog>
  );
}
