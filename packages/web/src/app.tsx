import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import styles from "./app.module.css";
import { ApprovalPanel } from "./components/approval/ApprovalPanel.tsx";
import { InteractionPanel } from "./components/approval/InteractionPanel.tsx";
import { Composer } from "./components/composer/Composer.tsx";
import { Dock } from "./components/dock/Dock.tsx";
import { Header } from "./components/header/Header.tsx";
import { Icon } from "./components/icons.tsx";
import { Sidebar, searchRequest } from "./components/sidebar/Sidebar.tsx";
import { StatsLine } from "./components/stats/StatsLine.tsx";
import { TrajectoryTab } from "./components/trajectory/TrajectoryTab.tsx";
import { Transcript } from "./components/transcript/Transcript.tsx";
import { t } from "./i18n/index.ts";
import {
  agentPickerOpen,
  agentsOpen,
  announceAssertive,
  announcePolite,
  auth,
  btw,
  currentId,
  focusComposer,
  mobileSidebar,
  newSession,
  reloadRequired,
  sessionTab,
  settingsOpen,
  streamStatus,
  toast,
  visible,
} from "./store/app.ts";
import { dockOpen } from "./store/dock.ts";

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

/** The settings modal is its own chunk, loaded the first time it opens. */
function LazySettings() {
  const [View, setView] = useState<ComponentType | undefined>();
  useEffect(() => {
    let alive = true;
    void import("./components/settings/SettingsModal.tsx").then((m) => {
      if (alive) setView(() => m.SettingsModal);
    });
    return () => {
      alive = false;
    };
  }, []);
  return View ? <View /> : null;
}

/** The Agents window and the `/agents` picker are their own chunks, loaded on first open. */
function LazyAgents(props: { picker?: boolean }) {
  const [View, setView] = useState<ComponentType | undefined>();
  useEffect(() => {
    let alive = true;
    const load = props.picker
      ? import("./components/agents/AgentPicker.tsx").then((m) => m.AgentPicker)
      : import("./components/agents/AgentsModal.tsx").then((m) => m.AgentsModal);
    void load.then((view) => {
      if (alive) setView(() => view);
    });
    return () => {
      alive = false;
    };
  }, [props.picker]);
  return View ? <View /> : null;
}

/** The `/btw` side panel is its own chunk, loaded the first time a side question opens. */
function LazyBtw() {
  const [View, setView] = useState<ComponentType | undefined>();
  useEffect(() => {
    let alive = true;
    void import("./components/btw/BtwPanel.tsx").then((m) => {
      if (alive) setView(() => m.BtwPanel);
    });
    return () => {
      alive = false;
    };
  }, []);
  return View ? <View /> : null;
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
  return (
    <div class={styles.app}>
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
            {sessionTab.value === "trajectory" ? <TrajectoryTab /> : <Transcript />}
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
      {dockOpen.value && id ? <Dock /> : null}
      {btw.value && id ? <LazyBtw /> : null}
      {settingsOpen.value ? <LazySettings /> : null}
      {agentsOpen.value ? <LazyAgents /> : null}
      {agentPickerOpen.value ? <LazyAgents picker /> : null}
      {toast.value ? (
        <div class={styles.toast} role="status">
          {toast.value}
        </div>
      ) : null}
      <div class="sr-only" aria-live="polite">
        {announcePolite.value ? t("transcript.turnDone") : ""}
      </div>
      <div class="sr-only" aria-live="assertive">
        {announceAssertive.value ? t("approval.announce", { tool: announceAssertive.value }) : ""}
      </div>
    </div>
  );
}
