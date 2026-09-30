/**
 * Settings → Plugins (image2.png): tabs "Plugin configuration" | "Plugin list", search, count and
 * a two-column grid of cards with a status pill and a chevron that reveals details and the
 * enable switch. Installing plugins from the web is out of scope; they are not sandboxed.
 */
import type { PluginInfo } from "@alisio/sdk";
import { useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { api, showToast } from "../../store/app.ts";
import { Icon } from "../icons.tsx";
import styles from "./settings.module.css";
import {
  errorMessage,
  PageIntro,
  Pill,
  type PillTone,
  SearchBox,
  Status,
  Switch,
  settingsWorkspace,
  useLoad,
} from "./shared.tsx";

const TONE: Record<PluginInfo["status"], PillTone> = {
  active: "ok",
  inactive: "off",
  failed: "danger",
  "restart-required": "warn",
};

export function statusLabel(plugin: PluginInfo): string {
  if (plugin.status === "failed") return t("plugins.status.failed");
  if (plugin.status === "restart-required") return t("plugins.status.restart");
  return plugin.enabled ? t("plugins.status.enabled") : t("plugins.status.disabled");
}

function PluginCard(props: {
  plugin: PluginInfo;
  onToggle: (enabled: boolean) => void;
  busy: boolean;
}) {
  const { plugin } = props;
  const [open, setOpen] = useState(false);
  const id = `plugin-${plugin.id}`;
  return (
    <li class={styles.card} data-open={open}>
      <button
        type="button"
        class={styles.cardHead}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <span class={styles.cardName} title={plugin.name}>
          {plugin.name}
        </span>
        <Pill tone={TONE[plugin.status]}>{statusLabel(plugin)}</Pill>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={16} class={styles.chevron} />
      </button>
      {open ? (
        <div id={id} class={styles.cardBody}>
          {plugin.description ? <p class={styles.cardText}>{plugin.description}</p> : null}
          <dl class={styles.facts}>
            <dt>{t("plugins.id")}</dt>
            <dd>
              <code>{plugin.id}</code>
            </dd>
            {plugin.version ? (
              <>
                <dt>{t("plugins.version")}</dt>
                <dd>{plugin.version}</dd>
              </>
            ) : null}
            <dt>{t("plugins.source")}</dt>
            <dd>{plugin.builtin ? t("plugins.builtin") : plugin.source}</dd>
            {plugin.categories.length ? (
              <>
                <dt>{t("plugins.categories")}</dt>
                <dd>{plugin.categories.join(", ")}</dd>
              </>
            ) : null}
            <dt>{t("plugins.tools")}</dt>
            <dd>{plugin.tools.length ? plugin.tools.join(", ") : "—"}</dd>
            <dt>{t("plugins.commands")}</dt>
            <dd>{plugin.commands.length ? plugin.commands.map((c) => `/${c}`).join(", ") : "—"}</dd>
          </dl>
          {plugin.diagnostic ? <p class={styles.diagnostic}>{plugin.diagnostic}</p> : null}
          <div class={styles.toggleRow}>
            <span>{t("plugins.enable")}</span>
            <Switch
              checked={plugin.enabled}
              label={t("plugins.enableNamed", { name: plugin.name })}
              disabled={!plugin.manageable}
              busy={props.busy}
              onChange={props.onToggle}
            />
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function PluginsPage() {
  const workspace = settingsWorkspace();
  const [tab, setTab] = useState<"configuration" | "list">("list");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | undefined>();
  const plugins = useLoad(
    workspace ? () => api.plugins(workspace.id) : undefined,
    [workspace?.id],
    ["plugins"],
  );
  const files = useLoad(
    workspace && tab === "configuration" ? () => api.settings(workspace.id) : undefined,
    [workspace?.id, tab],
  );
  const toggle = async (plugin: PluginInfo, enabled: boolean) => {
    if (!workspace) return;
    setBusy(plugin.id);
    try {
      const updated = await api.setPlugin(workspace.id, plugin.id, enabled);
      plugins.set((plugins.data ?? []).map((p) => (p.id === updated.id ? updated : p)));
      if (updated.status === "restart-required") showToast(t("plugins.deferred"));
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  };
  const q = query.trim().toLowerCase();
  const list = (plugins.data ?? []).filter(
    (p) =>
      !q ||
      p.name.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q),
  );
  return (
    <>
      <PageIntro
        title={t("settings.plugins")}
        body={t("plugins.lead")}
        workspace={workspace?.path}
      />
      <div class={styles.tabs} role="tablist">
        {(["configuration", "list"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            class={styles.tab}
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {t(id === "list" ? "plugins.tab.list" : "plugins.tab.configuration")}
          </button>
        ))}
      </div>
      {tab === "configuration" ? (
        <div class={styles.stack}>
          <p class={styles.callout}>
            <Icon name="shield" size={16} />
            <span>{t("plugins.notSandboxed")}</span>
          </p>
          <p class={styles.note}>{t("plugins.howToInstall")}</p>
          <p class={styles.note}>{t("plugins.applyNote")}</p>
          {files.data ? (
            <p class={styles.note}>
              {t("plugins.projectFile")} <code>{files.data.configPath}</code>
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <SearchBox value={query} label={t("plugins.search")} onInput={setQuery} />
          <h4 class={styles.listTitle}>
            {t("plugins.tab.list")} <span class={styles.count}>{list.length}</span>
          </h4>
          <Status
            loading={plugins.loading && !plugins.data}
            error={plugins.error}
            empty={
              !workspace
                ? "settings.noWorkspace"
                : plugins.data && !list.length
                  ? "plugins.none"
                  : undefined
            }
          />
          <ul class={styles.grid}>
            {list.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                busy={busy === plugin.id}
                onToggle={(enabled) => void toggle(plugin, enabled)}
              />
            ))}
          </ul>
        </>
      )}
    </>
  );
}
