import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import styles from "./app.module.css";
import { ApprovalPanel } from "./components/approval/ApprovalPanel.tsx";
import { InteractionPanel } from "./components/approval/InteractionPanel.tsx";
import { Composer } from "./components/composer/Composer.tsx";
import { Dock } from "./components/dock/Dock.tsx";
import { Header } from "./components/header/Header.tsx";
import { Icon } from "./components/icons.tsx";
import { Resizer } from "./components/layout/Resizer.tsx";
import { Sidebar, searchRequest } from "./components/sidebar/Sidebar.tsx";
import { StatsLine } from "./components/stats/StatsLine.tsx";
import { Transcript } from "./components/transcript/Transcript.tsx";
import { t } from "./i18n/index.ts";
import {
  activeTab,
  agentPickerOpen,
  agentsOpen,
  announceAgent,
  announceAssertive,
  announcePolite,
  auth,
  btw,
  changelogRequest,
  currentId,
  focusComposer,
  mobileSidebar,
  newSession,
  reloadRequired,
  settingsOpen,
  streamStatus,
  toast,
  visible,
} from "./store/app.ts";
import {
  currentBounds,
  narrowScreen,
  panelExpanded,
  panelWidth,
  rightPanel,
  setPanelWidth,
  viewport,
} from "./store/layout.ts";
import { clampPanelWidth, defaultPanelWidth } from "./util/panel.ts";

function Centered(props: { title: string; body: string; action?: preact.ComponentChildren }) {
  return (
    <main class={styles.centered}>
      <div class={styles.card}>
        <h1>{props.title}</h1>
        <p>{props.body}</p>
        {props.action}
      </div>
    </main>
  );
}

const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * A component in its own chunk, imported the first time it renders (settings, agents, `/btw`,
 * changelog, artifact panel, Trajectory and Memory tabs). `load` runs once per mount; props are passed through.
 */
function Lazy<P extends object>(props: { load: () => Promise<ComponentType<P>> } & P) {
  const { load, ...rest } = props;
  const [View, setView] = useState<ComponentType<P> | undefined>();
  useEffect(() => {
    let alive = true;
    void load().then((view) => {
      if (alive) setView(() => view);
    });
    return () => {
      alive = false;
    };
  }, []);
  return View ? <View {...(rest as unknown as P)} /> : null;
}
const loadSettings = () =>
  import("./components/settings/SettingsModal.tsx").then((m) => m.SettingsModal);
const loadAgents = () => import("./components/agents/AgentsModal.tsx").then((m) => m.AgentsModal);
const loadPicker = () => import("./components/agents/AgentPicker.tsx").then((m) => m.AgentPicker);
const loadBtw = () => import("./components/btw/BtwPanel.tsx").then((m) => m.BtwPanel);
const loadChangelog = () =>
  import("./components/changelog/ChangelogDialog.tsx").then((m) => m.ChangelogDialog);
const loadTrajectory = () =>
  import("./components/trajectory/TrajectoryTab.tsx").then((m) => m.TrajectoryTab);
const loadMemory = () => import("./components/memory/MemoryTab.tsx").then((m) => m.MemoryTab);
const loadArtifacts = () =>
  import("./components/artifacts/ArtifactPanel.tsx").then((m) => m.ArtifactPanel);

type PanelProps = { width?: number; narrow: boolean; expanded: boolean; inert: boolean };

/**
 * The right slot (ADR-07): the Dock or the artifact panel, never both, behind one resize handle
 * whose width is shared and persisted. Narrow screens get a sheet (Dock) or a modal dialog
 * (artifact panel) without the handle.
 */
function RightSlot(props: { expanded: boolean }) {
  const right = rightPanel.value;
  if (!right) return null;
  void viewport.value;
  const bounds = currentBounds();
  const narrow = narrowScreen.value || !bounds.fits;
  const reset = defaultPanelWidth(viewport.value);
  const width = clampPanelWidth(panelWidth.value ?? reset, bounds);
  const modal = settingsOpen.value || agentsOpen.value || agentPickerOpen.value;
  return (
    <>
      {!narrow && !props.expanded ? (
        <Resizer
          width={width}
          bounds={bounds}
          reset={reset}
          controls={right === "artifact" ? "artifact-panel" : "dock-panel"}
          onChange={setPanelWidth}
        />
      ) : null}
      {right === "dock" ? (
        <Dock {...(narrow ? {} : { width })} />
      ) : (
        <Lazy<PanelProps>
          load={loadArtifacts}
          {...(narrow ? {} : { width })}
          narrow={narrow}
          expanded={props.expanded && !narrow}
          inert={modal}
        />
      )}
    </>
  );
}

export function App() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRequest.focus();
      } else if (event.key === "/" && !editable(event.target) && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        focusComposer.value++;
      } else if (event.key === "Escape" && mobileSidebar.value) mobileSidebar.value = false;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (auth.value === "unauthorized")
    return <Centered title={t("auth.title")} body={t("auth.body")} />;

  const { approvals, interactions } = visible.value;
  const id = currentId.value;
  // "Expand panel" hides the chat column, except while an approval or a question waits there.
  const expanded =
    rightPanel.value === "artifact" &&
    panelExpanded.value &&
    !narrowScreen.value &&
    !approvals.length &&
    !interactions.length;
  return (
    <div class={styles.app} data-artifact-expanded={expanded ? "true" : undefined}>
      <a class="skip" href="#composer-input">
        {t("app.skip")}
      </a>
      <Sidebar />
      {mobileSidebar.value ? (
        <div
          class={styles.backdrop}
          aria-hidden="true"
          onClick={() => {
            mobileSidebar.value = false;
          }}
        />
      ) : null}
      <main class={styles.main}>
        {reloadRequired.value ? (
          <div class={styles.banner} role="alert">
            <strong>{t("reload.title")}</strong> {t("reload.body")}
            <button type="button" onClick={() => location.reload()}>
              {t("reload.action")}
            </button>
          </div>
        ) : streamStatus.value === "reconnecting" ? (
          <div class={styles.banner} role="status">
            <span class={`${styles.pulse}`} aria-hidden="true" />
            {t("stream.reconnecting")}
          </div>
        ) : null}
        <Header />
        {id ? (
          <>
            {activeTab() === "trajectory" ? (
              <Lazy key="trajectory" load={loadTrajectory} />
            ) : activeTab() === "memory" ? (
              <Lazy key="memory" load={loadMemory} />
            ) : (
              <Transcript />
            )}
            {approvals.length ? (
              <ApprovalPanel approvals={approvals} />
            ) : interactions[0] ? (
              <InteractionPanel interaction={interactions[0]} />
            ) : (
              <Composer />
            )}
            <StatsLine />
          </>
        ) : (
          <div class={styles.none}>
            <h2>{t("transcript.noSessionTitle")}</h2>
            <p>{t("transcript.noSessionBody")}</p>
            <button type="button" class={styles.primary} onClick={() => void newSession()}>
              <Icon name="plusCircle" size={17} />
              {t("sidebar.newSession")}
            </button>
          </div>
        )}
      </main>
      {id ? <RightSlot expanded={expanded} /> : null}
      {btw.value && id ? <Lazy load={loadBtw} /> : null}
      {settingsOpen.value ? <Lazy load={loadSettings} /> : null}
      {agentsOpen.value ? <Lazy load={loadAgents} /> : null}
      {agentPickerOpen.value ? <Lazy load={loadPicker} /> : null}
      {changelogRequest.value ? (
        <Lazy load={loadChangelog} version={changelogRequest.value.version} />
      ) : null}
      {toast.value ? (
        <div class={styles.toast} role="status">
          {toast.value}
        </div>
      ) : null}
      <div class="sr-only" aria-live="polite">
        {announcePolite.value ? t("transcript.turnDone") : ""}
      </div>
      <div class="sr-only" aria-live="polite">
        {announceAgent.value}
      </div>
      <div class="sr-only" aria-live="assertive">
        {announceAssertive.value ? t("approval.announce", { tool: announceAssertive.value }) : ""}
      </div>
    </div>
  );
}
