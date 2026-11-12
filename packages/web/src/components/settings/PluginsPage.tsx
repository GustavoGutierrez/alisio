/**
 * Settings → Plugins: "Plugin configuration" | "Installed plugins" | "Plugin catalog" | "Install
 * from file". Installed plugins list their state, offer updates (catalog versions) and uninstall;
 * the catalog and the file tab install. A banner asks for a restart when an update could not be
 * loaded into the running process. Plugins are not sandboxed.
 */
import type { PluginInfo } from "@alisio/sdk";
import { useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { api, settingsPluginsTab, showToast } from "../../store/app.ts";
import { Icon } from "../icons.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import {
  type InstalledPackageView,
  type InstallTarget,
  type ItemOutcome,
  installedUpdateState,
  needsRestart,
  type PluginCatalogView,
  resolvePluginIcon,
  runUpdateAll,
  uninstallInfo,
  updatablePackages,
} from "./catalog-model.ts";
import { PluginIcon } from "./catalog-parts.tsx";
import { cs } from "./catalog-strings.ts";
import { useInstallFlow } from "./InstallFlow.tsx";
import { LocalInstall } from "./LocalInstall.tsx";
import { PluginCatalog } from "./PluginCatalog.tsx";
import { PluginTabs } from "./PluginTabs.tsx";
import {
  failureText,
  sessionPrefs,
  uninstallPackage,
  updateAllPackages,
  working,
} from "./plugin-ops.ts";
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

type Tab = "configuration" | "list" | "catalog" | "file";

export function statusLabel(plugin: PluginInfo): string {
  if (plugin.status === "failed") return t("plugins.status.failed");
  if (plugin.status === "restart-required") return t("plugins.status.restart");
  return plugin.enabled ? t("plugins.status.enabled") : t("plugins.status.disabled");
}

function PluginCard(props: {
  plugin: PluginInfo;
  pkg?: InstalledPackageView;
  onToggle: (enabled: boolean) => void;
  onUpdate: (pkg: InstalledPackageView) => void;
  onUpdateFromFile: (pkg: InstalledPackageView) => void;
  onUninstall: (pkg: InstalledPackageView) => void;
  busy: boolean;
}) {
  const { plugin, pkg } = props;
  const [open, setOpen] = useState(false);
  const id = `plugin-${plugin.id}`;
  const update = installedUpdateState(pkg);
  const removal = uninstallInfo(plugin, pkg ? [pkg] : undefined);
  const reasonId = `${id}-reason`;
  const busy = working.value !== undefined;
  const uninstalling = !!pkg && working.value === pkg.package;
  return (
    <li class={styles.card} data-open={open}>
      <button
        type="button"
        class={styles.cardHead}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <PluginIcon icon={pkg?.icon} size="small" />
        <span class={styles.cardName} title={plugin.name}>
          {plugin.name}
          {pkg ? <span class={styles.version}> v{pkg.version}</span> : null}
        </span>
        {pkg?.restartRequired ? <Pill tone="warn">{cs("restart.pill")}</Pill> : null}
        <Pill tone={TONE[plugin.status]}>{statusLabel(plugin)}</Pill>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={16} class={styles.chevron} />
      </button>
      {pkg && (update === "update" || update === "blocked" || update === "local") ? (
        <div class={styles.updateRow}>
          {update === "update" ? (
            <>
              <Pill tone="warn">
                {cs("update.pill", { from: pkg.version, to: pkg.latestVersion ?? "" })}
              </Pill>
              <button
                type="button"
                class={styles.primaryButton}
                disabled={busy}
                aria-label={cs("update.buttonNamed", {
                  name: plugin.name,
                  to: pkg.latestVersion ?? "",
                })}
                onClick={() => props.onUpdate(pkg)}
              >
                {cs("update.button")}
              </button>
            </>
          ) : null}
          {update === "blocked" ? (
            <>
              <Pill tone="danger">{cs("update.blocked")}</Pill>
              <span class={styles.srOnly} id={`${id}-blocked`}>
                {cs("update.blockedReason", { to: pkg.latestVersion ?? "" })}
              </span>
              <button
                type="button"
                class={styles.primaryButton}
                disabled
                aria-describedby={`${id}-blocked`}
              >
                {cs("update.button")}
              </button>
            </>
          ) : null}
          {update === "local" ? (
            <>
              <span class={styles.note}>{cs("update.local", { version: pkg.version })}</span>
              <button
                type="button"
                class={styles.ghostButton}
                disabled={busy}
                aria-label={cs("update.fromFileNamed", { name: plugin.name })}
                onClick={() => props.onUpdateFromFile(pkg)}
              >
                {cs("update.fromFile")}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
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
          <div class={styles.toggleRow}>
            <span>
              {removal.removable ? (
                pkg ? (
                  <code>{pkg.package}</code>
                ) : null
              ) : (
                <span id={reasonId} class={styles.note}>
                  {cs(
                    `uninstall.reason.${removal.reason ?? "notGlobal"}` as "uninstall.reason.builtin",
                  )}
                </span>
              )}
            </span>
            <button
              type="button"
              class={styles.dangerGhost}
              disabled={!removal.removable || busy}
              aria-describedby={removal.removable ? undefined : reasonId}
              aria-label={cs("uninstall.buttonNamed", { name: plugin.name })}
              title={
                removal.removable
                  ? undefined
                  : cs(
                      `uninstall.reason.${removal.reason ?? "notGlobal"}` as "uninstall.reason.builtin",
                    )
              }
              onClick={() => pkg && props.onUninstall(pkg)}
            >
              {uninstalling ? (
                <>
                  <span class={styles.spinner} aria-hidden="true" />
                  {cs("uninstall.working")}
                </>
              ) : (
                cs("uninstall.button")
              )}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function RestartBanner(props: { available: boolean }) {
  const [state, setState] = useState<"idle" | "restarting">("idle");
  const restart = async () => {
    setState("restarting");
    try {
      await api.request("POST", "/api/server/restart", { confirmed: true });
    } catch (error) {
      setState("idle");
      showToast(cs("restart.failed", { message: errorMessage(error) }));
    }
  };
  return (
    <div class={styles.restartBanner} role="status">
      <Icon name="alert" size={16} />
      <span>{props.available ? cs("restart.banner") : cs("restart.manual")}</span>
      {props.available ? (
        <button
          type="button"
          class={styles.primaryButton}
          disabled={state === "restarting"}
          onClick={() => void restart()}
        >
          {state === "restarting" ? cs("restart.working") : cs("restart.button")}
        </button>
      ) : null}
    </div>
  );
}

export function PluginsPage() {
  const workspace = settingsWorkspace();
  // The sidebar's "Find more plugins" opens this page on the catalog (read once, then cleared).
  const [initialTab] = useState<Tab>(() => {
    const requested = settingsPluginsTab.peek();
    settingsPluginsTab.value = undefined;
    return requested ?? "list";
  });
  const [tab, setTab] = useState<Tab>(initialTab);
  const [visited, setVisited] = useState(initialTab === "catalog");
  const [scope, setScope] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | undefined>();
  const [checking, setChecking] = useState(false);
  const [removing, setRemoving] = useState<
    { pkg: InstalledPackageView; name: string } | undefined
  >();
  const [batch, setBatch] = useState<
    { items: ItemOutcome[]; running: boolean; confirm?: boolean } | undefined
  >();
  const plugins = useLoad(
    workspace ? () => api.plugins(workspace.id) : undefined,
    [workspace?.id],
    ["plugins"],
  );
  const packages = useLoad(
    workspace
      ? () =>
          api.request<InstalledPackageView[]>(
            "GET",
            `/api/plugins/packages?workspace=${encodeURIComponent(workspace.id)}`,
          )
      : undefined,
    [workspace?.id],
    ["plugins"],
  );
  const catalog = useLoad(
    visited ? () => api.request<PluginCatalogView>("GET", "/api/plugin-catalog") : undefined,
    [visited],
    ["plugins"],
  );
  const restart = useLoad(
    () => api.request<{ available: boolean }>("GET", "/api/server/restart"),
    [],
  );
  const files = useLoad(
    workspace && tab === "configuration" ? () => api.settings(workspace.id) : undefined,
    [workspace?.id, tab],
  );

  const changed = () => {
    plugins.reload();
    packages.reload();
    if (visited) catalog.reload();
  };
  const flow = useInstallFlow(changed);

  const select = (next: Tab) => {
    if (next === "catalog" || next === "file") setVisited(true);
    if (next !== "file") setScope(undefined);
    setTab(next);
  };

  const check = async () => {
    setChecking(true);
    try {
      const fresh = await api.request<PluginCatalogView>("GET", "/api/plugin-catalog?refresh=1");
      setVisited(true);
      catalog.set(fresh);
      packages.reload();
      showToast(
        fresh.meta.offline
          ? cs("catalog.refreshOffline")
          : fresh.meta.fromCache
            ? cs("catalog.refreshed")
            : cs("catalog.refreshedNew"),
      );
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setChecking(false);
    }
  };

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

  const uninstall = async () => {
    const target = removing;
    if (!target) return;
    setRemoving(undefined);
    working.value = target.pkg.package;
    try {
      const result = await uninstallPackage(target.pkg.package);
      showToast(
        cs(result.restartPending ? "uninstall.deferred" : "uninstall.done", { name: target.name }),
      );
      changed();
    } catch (error) {
      showToast(failureText("uninstall.failed", target.name, error));
    } finally {
      working.value = undefined;
    }
  };

  const nameOf = (pkg: InstalledPackageView) =>
    plugins.data?.find((p) => pkg.pluginIds.includes(p.id))?.name ?? pkg.package;

  const updateOne = (pkg: InstalledPackageView) => {
    const target: InstallTarget = {
      package: pkg.package,
      name: nameOf(pkg),
      version: pkg.latestVersion ?? pkg.version,
      installedVersion: pkg.version,
      mode: "update",
      ...(pkg.icon ? { icon: pkg.icon } : {}),
    };
    flow.ask(target);
  };

  const pending = updatablePackages(packages.data);
  const runBatch = async () => {
    const list = pending;
    setBatch({
      items: list.map((p) => ({ package: p.package, status: "pending" })),
      running: true,
    });
    working.value = "batch";
    try {
      const summary = await runUpdateAll(
        list.map((p) => p.package),
        updateAllPackages,
        (items) => setBatch({ items, running: true }),
      );
      setBatch({ items: summary.items, running: false });
      showToast(cs("update.summary", { updated: summary.updated, failed: summary.failed }));
      changed();
    } finally {
      working.value = undefined;
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
  const tabs = [
    { id: "configuration" as const, label: t("plugins.tab.configuration") },
    { id: "list" as const, label: t("plugins.tab.list") },
    { id: "catalog" as const, label: cs("tab.catalog") },
    { id: "file" as const, label: cs("tab.file") },
  ];
  const panel = (id: Tab) => ({
    role: "tabpanel" as const,
    id: `plugins-panel-${id}`,
    "aria-labelledby": `plugins-tab-${id}`,
    hidden: tab !== id,
  });

  return (
    <>
      <PageIntro
        title={t("settings.plugins")}
        body={t("plugins.lead")}
        workspace={workspace?.path}
      />
      <PluginTabs tabs={tabs} active={tab} label={cs("tabs.label")} onSelect={select} />
      {needsRestart(packages.data) ? <RestartBanner available={!!restart.data?.available} /> : null}

      <div {...panel("configuration")}>
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
        ) : null}
      </div>

      <div {...panel("list")}>
        {tab === "list" ? (
          <>
            <SearchBox value={query} label={t("plugins.search")} onInput={setQuery} />
            <div class={styles.updateBar}>
              <p class={styles.statusLine} aria-live="polite">
                {pending.length
                  ? pending.length === 1
                    ? cs("update.countOne")
                    : cs("update.countMany", { n: pending.length })
                  : cs("update.none")}
              </p>
              <span class={styles.inlineActions}>
                {pending.length > 1 ? (
                  <button
                    type="button"
                    class={styles.primaryButton}
                    disabled={working.value !== undefined}
                    onClick={() => setBatch({ items: [], running: false, confirm: true })}
                  >
                    {cs("update.all", { n: pending.length })}
                  </button>
                ) : null}
                <button
                  type="button"
                  class={styles.ghostButton}
                  disabled={checking}
                  aria-busy={checking || undefined}
                  onClick={() => void check()}
                >
                  {checking ? (
                    <span class={styles.spinner} aria-hidden="true" />
                  ) : (
                    <Icon name="refresh" size={15} />
                  )}
                  {checking ? cs("catalog.checking") : cs("installed.check")}
                </button>
              </span>
            </div>
            {batch && !batch.confirm ? (
              <section class={styles.validation} aria-live="polite">
                <header class={styles.validationHead}>
                  <h4>
                    {batch.running
                      ? cs("update.allRunning", {
                          done: batch.items.filter(
                            (i) => i.status === "done" || i.status === "failed",
                          ).length,
                          total: batch.items.length,
                        })
                      : cs("update.summary", {
                          updated: batch.items.filter((i) => i.status === "done").length,
                          failed: batch.items.filter((i) => i.status === "failed").length,
                        })}
                  </h4>
                  {!batch.running ? (
                    <button
                      type="button"
                      class={styles.inlineLink}
                      onClick={() => setBatch(undefined)}
                    >
                      {cs("update.dismiss")}
                    </button>
                  ) : null}
                </header>
                <ul class={styles.stepper}>
                  {batch.items.map((item) => (
                    <li
                      key={item.package}
                      data-status={item.status === "pending" ? "pending" : item.status}
                    >
                      <span class={styles.stepIcon} aria-hidden="true">
                        {item.status === "done" ? (
                          <Icon name="check" size={14} />
                        ) : item.status === "running" ? (
                          <span class={styles.spinner} />
                        ) : item.status === "failed" ? (
                          <Icon name="x" size={14} />
                        ) : null}
                      </span>
                      <PluginIcon
                        icon={resolvePluginIcon(item.package, undefined, packages.data)}
                        size="small"
                      />
                      <span>
                        <code>{item.package}</code>{" "}
                        {item.status === "done"
                          ? cs("update.item.done", { version: item.version })
                          : item.status === "failed"
                            ? cs("update.item.failed", { error: item.error.split("\n")[0] ?? "" })
                            : cs(`update.item.${item.status}` as "update.item.pending")}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
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
              {list.map((plugin) => {
                const pkg = packages.data?.find((item) => item.pluginIds.includes(plugin.id));
                return (
                  <PluginCard
                    key={plugin.id}
                    plugin={plugin}
                    {...(pkg ? { pkg } : {})}
                    busy={busy === plugin.id}
                    onToggle={(enabled) => void toggle(plugin, enabled)}
                    onUpdate={updateOne}
                    onUpdateFromFile={(item) => {
                      setScope(item.package);
                      setVisited(true);
                      setTab("file");
                    }}
                    onUninstall={(item) => setRemoving({ pkg: item, name: plugin.name })}
                  />
                );
              })}
            </ul>
          </>
        ) : null}
      </div>

      <div {...panel("catalog")}>
        {tab === "catalog" ? (
          <PluginCatalog
            data={catalog}
            checking={checking}
            onCheck={() => void check()}
            onChanged={changed}
          />
        ) : null}
      </div>

      <div {...panel("file")}>
        {tab === "file" ? (
          <LocalInstall
            {...(scope ? { scope } : {})}
            iconFor={(name) =>
              resolvePluginIcon(name, catalog.data?.catalog.plugins, packages.data)
            }
            {...(catalog.data?.sdkVersion ? { sdkVersion: catalog.data.sdkVersion } : {})}
            onChanged={changed}
            onShowInstalled={() => select("list")}
          />
        ) : null}
      </div>

      {flow.dialog}
      {removing ? (
        <ConfirmDialog
          title={cs("uninstall.title", { name: removing.name })}
          icon={<PluginIcon icon={removing.pkg.icon} size="small" />}
          confirmLabel={cs("uninstall.confirm")}
          cancelLabel={cs("uninstall.cancel")}
          danger
          onCancel={() => setRemoving(undefined)}
          onConfirm={() => void uninstall()}
        >
          <p>{cs("uninstall.body", { package: removing.pkg.package })}</p>
        </ConfirmDialog>
      ) : null}
      {batch?.confirm ? (
        <ConfirmDialog
          title={cs("update.all", { n: pending.length })}
          confirmLabel={cs("install.confirm")}
          cancelLabel={cs("install.cancel")}
          checkbox={{
            label: cs("install.skip"),
            checked: sessionPrefs.skipInstallWarning,
            onChange: (checked) => {
              sessionPrefs.skipInstallWarning = checked;
            },
          }}
          onCancel={() => setBatch(undefined)}
          onConfirm={() => void runBatch()}
        >
          <p>{cs("install.warning")}</p>
          <ul>
            {pending.map((pkg) => (
              <li key={pkg.package} class={styles.iconItem}>
                <PluginIcon icon={pkg.icon} size="small" />
                <code>
                  {pkg.package} v{pkg.version} → v{pkg.latestVersion}
                </code>
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
