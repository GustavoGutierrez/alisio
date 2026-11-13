/**
 * Settings → MCP: the workspace's MCP servers with status, enable switch and Connect. Granting
 * MCP access needs an explicit confirmation (P-07, source `interactive-web`): MCP servers run
 * with the user's privileges. Commands, arguments and URLs are never shown (they may hold
 * tokens); the server does not send them.
 */
import type { McpServerWire } from "@alisio/sdk";
import type { ComponentType } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { api, showToast } from "../../store/app.ts";
import { Icon } from "../icons.tsx";
import { nextTab } from "./catalog-model.ts";
import css from "./mcp-explore/explore.module.css";
import { xs } from "./mcp-explore/strings.ts";
import { MineRow, RemoveDialog } from "./mcp-install/MineRows.tsx";
import { ms } from "./mcp-install/strings.ts";
import type * as ManagePanels from "./mcp-manage/ManagePanels.tsx";
import { mgs } from "./mcp-manage/strings.ts";
import styles from "./settings.module.css";
import { errorMessage, PageIntro, Status, settingsWorkspace, useLoad } from "./shared.tsx";

function ConsentDialog(props: { onCancel: () => void; onGrant: (remember: boolean) => void }) {
  const [remember, setRemember] = useState(false);
  return (
    <div class={styles.confirm} role="alertdialog" aria-labelledby="mcp-consent-title">
      <h4 id="mcp-consent-title" class={styles.confirmTitle}>
        <Icon name="alert" size={17} />
        {t("mcp.consentTitle")}
      </h4>
      <p class={styles.cardText}>{t("mcp.consentBody")}</p>
      <label class={styles.checkRow}>
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => setRemember((event.target as HTMLInputElement).checked)}
        />
        <span>{t("mcp.remember")}</span>
      </label>
      <div class={styles.actions}>
        <button type="button" class={styles.secondary} onClick={props.onCancel}>
          {t("common.cancel")}
        </button>
        <button type="button" class={styles.primary} onClick={() => props.onGrant(remember)}>
          {t("mcp.grant")}
        </button>
      </div>
    </div>
  );
}

type McpTab = "mine" | "explore";
const MCP_TABS: readonly McpTab[] = ["mine", "explore"];

/** Settings → MCP: the connected servers and, in a lazily loaded chunk, the catalog to explore. */
export function McpPage() {
  const workspace = settingsWorkspace();
  const [tab, setTab] = useState<McpTab>("mine");
  const [Explore, setExplore] = useState<ComponentType | undefined>();
  useEffect(() => {
    if (tab !== "explore" || Explore) return;
    void import("./mcp-explore/ExploreView.tsx").then((m) => setExplore(() => m.ExploreView));
  }, [tab, Explore]);
  const select = (next: McpTab) => {
    setTab(next);
    queueMicrotask(() => document.getElementById(`mcp-tab-${next}`)?.focus());
  };
  return (
    <>
      <PageIntro title={t("settings.mcp")} body={t("mcp.lead")} workspace={workspace?.path} />
      <div class={css.tabs} role="tablist" aria-label={xs("tab.label")}>
        {MCP_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`mcp-tab-${id}`}
            class={css.tab}
            aria-selected={tab === id}
            aria-controls={`mcp-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={(event) => {
              const next = nextTab(MCP_TABS, tab, event.key);
              if (next) {
                event.preventDefault();
                select(next);
              }
            }}
          >
            {xs(id === "mine" ? "tab.mine" : "tab.explore")}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="mcp-panel-mine"
        aria-labelledby="mcp-tab-mine"
        hidden={tab !== "mine"}
      >
        <ConnectedServers />
      </div>
      {tab === "explore" ? (
        <div role="tabpanel" id="mcp-panel-explore" aria-labelledby="mcp-tab-explore">
          {Explore ? <Explore /> : <p class={styles.note}>{xs("state.loading")}</p>}
        </div>
      ) : null}
    </>
  );
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

type PanelKind = "test" | "configure" | "signin" | "update";
type PanelState = { kind: PanelKind; name: string; autoRun?: boolean };

function ConnectedServers() {
  const workspace = settingsWorkspace();
  const workspaceName = workspace ? baseName(workspace.path) : "";
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<string | undefined>();
  const [panel, setPanel] = useState<PanelState | undefined>();
  const [Panels, setPanels] = useState<typeof ManagePanels | undefined>();
  const returnFocus = useRef<HTMLElement | null>(null);
  const [removing, setRemoving] = useState<McpServerWire | undefined>();
  const overview = useLoad(
    workspace ? () => api.mcp(workspace.id) : undefined,
    [workspace?.id],
    ["mcp"],
  );
  const data = overview.data;
  const replace = (server: McpServerWire) => {
    if (data)
      overview.set({
        ...data,
        servers: data.servers.map((s) => (s.name === server.name ? server : s)),
      });
  };
  const change = async (server: McpServerWire, enabled: boolean, connect: boolean) => {
    if (!workspace) return;
    setBusy(server.name);
    try {
      const updated = await api.setMcp(workspace.id, server.name, enabled, connect);
      replace(updated);
      if (connect && updated.status !== "connected" && updated.diagnostic)
        showToast(updated.diagnostic);
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  };
  // The check, settings, sign-in and update panels are a lazy chunk: nothing here loads before use.
  const openPanel = (kind: PanelKind, server: McpServerWire, autoRun = false) => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    setPanel({ kind, name: server.name, ...(autoRun ? { autoRun: true } : {}) });
    if (!Panels) void import("./mcp-manage/ManagePanels.tsx").then((m) => setPanels(() => m));
  };
  const closePanel = () => {
    setPanel(undefined);
    // Focus goes back to where the user was (UX-10).
    queueMicrotask(() => returnFocus.current?.focus());
  };
  const signOut = async (server: McpServerWire) => {
    if (!workspace || !server.binding) return;
    setBusy(server.name);
    try {
      replace(
        await api.request<McpServerWire>(
          "DELETE",
          `/api/mcp/bindings/${server.binding.id}/auth?workspace=${encodeURIComponent(workspace.id)}`,
        ),
      );
      showToast(mgs("signin.signOutDone"));
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  };
  const recover = (server: McpServerWire, action: string) => {
    if (action === "sign-in") openPanel("signin", server);
    else if (action === "change-key" || action === "configure") openPanel("configure", server);
    else if (action === "turn-on") void change(server, true, false);
  };
  const panelFor = (server: McpServerWire) => {
    if (!panel || panel.name !== server.name || !Panels || !workspace || !server.binding)
      return undefined;
    const binding = server.binding;
    const common = { workspaceId: workspace.id };
    if (panel.kind === "test")
      return (
        <Panels.TestPanel
          {...common}
          bindingId={binding.id}
          name={server.displayName}
          {...(panel.autoRun ? { autoRun: true } : {})}
          onWire={replace}
          onAction={(action) => recover(server, action)}
          onClose={closePanel}
        />
      );
    if (panel.kind === "configure")
      return (
        <Panels.ConfigurePanel
          {...common}
          bindingId={binding.id}
          name={server.displayName}
          onClose={closePanel}
          onSaved={() => {
            overview.reload();
            openPanel("test", server, true);
          }}
        />
      );
    if (panel.kind === "signin")
      return (
        <Panels.SignInPanel
          {...common}
          bindingId={binding.id}
          name={server.displayName}
          autoStart
          onClose={closePanel}
          onFinished={() => overview.reload()}
        />
      );
    return (
      <Panels.UpdatePanel
        {...common}
        binding={binding}
        name={server.displayName}
        granted={granted}
        onClose={closePanel}
        onDone={() => overview.reload()}
      />
    );
  };
  const remove = async (server: McpServerWire, removeSecrets: boolean) => {
    if (!workspace || !server.binding) return;
    setRemoving(undefined);
    setBusy(server.name);
    try {
      await api.request(
        "DELETE",
        `/api/mcp/bindings/${server.binding.id}?workspace=${encodeURIComponent(workspace.id)}&scope=${server.binding.scope}&removeSecrets=${removeSecrets}`,
      );
      showToast(ms("removed.toast", { name: server.displayName }));
      overview.reload();
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  };
  const grant = async (remember: boolean) => {
    if (!workspace) return;
    setAsking(false);
    try {
      overview.set(await api.mcpConsent(workspace.id, remember));
    } catch (error) {
      showToast(errorMessage(error));
    }
  };
  const granted = data?.permission === "granted";
  return (
    <>
      {data ? (
        <div class={styles.banner} data-tone={granted ? "ok" : "warn"}>
          <span>
            {data.permission === "read-only"
              ? t("mcp.readOnly")
              : granted
                ? data.persisted
                  ? t("mcp.grantedPersisted")
                  : t("mcp.granted")
                : t("mcp.notGranted")}
          </span>
          {data.permission === "not-granted" && !asking ? (
            <button type="button" class={styles.primary} onClick={() => setAsking(true)}>
              {t("mcp.grant")}
            </button>
          ) : null}
        </div>
      ) : null}
      {asking ? (
        <ConsentDialog onCancel={() => setAsking(false)} onGrant={(r) => void grant(r)} />
      ) : null}
      <Status
        loading={overview.loading && !data}
        error={overview.error}
        empty={
          !workspace
            ? "settings.noWorkspace"
            : data && !data.servers.length
              ? "mcp.none"
              : undefined
        }
      />
      <ul class={styles.rows}>
        {(data?.servers ?? []).map((server) => (
          <MineRow
            key={server.name}
            server={server}
            workspaceName={workspaceName}
            granted={granted}
            readOnly={data?.permission === "read-only"}
            busy={busy === server.name}
            testing={false}
            hostWording={data?.localBrowser ? undefined : "server"}
            panelId={`mcp-panel-${server.name}`}
            panel={panelFor(server)}
            onConfigure={() => openPanel("configure", server)}
            onUpdate={() => openPanel("update", server)}
            onSignIn={() => openPanel("signin", server)}
            onSignOut={() => void signOut(server)}
            meta={t("mcp.meta", {
              transport: server.transport,
              source: server.source,
              tools: server.counts.tools,
              resources: server.counts.resources,
              prompts: server.counts.prompts,
            })}
            connectLabel={t("mcp.connect")}
            switchLabel={t("plugins.enableNamed", { name: server.displayName })}
            needsGrantHint={t("mcp.needsGrant")}
            onConnect={() => void change(server, true, true)}
            onToggle={(enabled) => void change(server, enabled, false)}
            onTest={() => openPanel("test", server, true)}
            onRemove={() => setRemoving(server)}
          />
        ))}
      </ul>
      {removing ? (
        <RemoveDialog
          server={removing}
          workspaceName={workspaceName}
          onConfirm={(secrets) => void remove(removing, secrets)}
          onCancel={() => setRemoving(undefined)}
        />
      ) : null}
    </>
  );
}
