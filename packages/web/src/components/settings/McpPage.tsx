/**
 * Settings → MCP: the workspace's MCP servers with status, enable switch and Connect. Granting
 * MCP access needs an explicit confirmation (P-07, source `interactive-web`): MCP servers run
 * with the user's privileges. Commands, arguments and URLs are never shown (they may hold
 * tokens); the server does not send them.
 */
import type { McpServerWire } from "@alisio/sdk";
import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { api, showToast } from "../../store/app.ts";
import { Icon } from "../icons.tsx";
import { nextTab } from "./catalog-model.ts";
import css from "./mcp-explore/explore.module.css";
import { xs } from "./mcp-explore/strings.ts";
import styles from "./settings.module.css";
import {
  errorMessage,
  PageIntro,
  Pill,
  type PillTone,
  Status,
  Switch,
  settingsWorkspace,
  useLoad,
} from "./shared.tsx";

const TONE: Record<string, PillTone> = {
  connected: "ok",
  connecting: "warn",
  failed: "danger",
  "needs-authentication": "warn",
  "restart-required": "warn",
};

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

function ConnectedServers() {
  const workspace = settingsWorkspace();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<string | undefined>();
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
          <li key={server.name} class={styles.row}>
            <div class={styles.rowMain}>
              <div class={styles.rowTitle}>
                <span class={styles.cardName}>{server.displayName}</span>
                <Pill tone={TONE[server.status] ?? "off"}>
                  {t("mcp.status", { status: server.status })}
                </Pill>
              </div>
              <p class={styles.meta}>
                {t("mcp.meta", {
                  transport: server.transport,
                  source: server.source,
                  tools: server.counts.tools,
                  resources: server.counts.resources,
                  prompts: server.counts.prompts,
                })}
              </p>
              {server.diagnostic ? <p class={styles.diagnostic}>{server.diagnostic}</p> : null}
            </div>
            <div class={styles.rowActions}>
              {server.enabled && server.status !== "connected" ? (
                <button
                  type="button"
                  class={styles.secondary}
                  disabled={!granted || busy === server.name}
                  title={granted ? undefined : t("mcp.needsGrant")}
                  onClick={() => void change(server, true, true)}
                >
                  {t("mcp.connect")}
                </button>
              ) : null}
              <Switch
                checked={server.enabled}
                label={t("plugins.enableNamed", { name: server.displayName })}
                disabled={data?.permission === "read-only"}
                busy={busy === server.name}
                onChange={(enabled) => void change(server, enabled, false)}
              />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
