/**
 * The Agents window (opened from the sidebar, above Settings). It reuses the Settings modal
 * shell: the list of your project/global agents plus templates, and the agent editor. Loaded
 * lazily on first open.
 */
import type { AgentDefinitionInfo, AgentModelOption, AgentTemplateInfo } from "@alisio/sdk";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import {
  type AgentForm,
  emptyForm,
  formFromDefinition,
  formFromTemplate,
} from "../../store/agents.ts";
import { agentsOpen, api, showToast } from "../../store/app.ts";
import { errorText } from "../../store/errors.ts";
import { Icon } from "../icons.tsx";
import settings from "../settings/settings.module.css";
import { Pill, Status, settingsWorkspace, useLoad } from "../settings/shared.tsx";
import { AgentEditor } from "./AgentEditor.tsx";
import styles from "./agents.module.css";

const FOCUSABLE =
  "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex='0']";

type View =
  | { kind: "list" }
  | { kind: "editor"; key: string; form: AgentForm; saved?: AgentForm; assist: boolean };

export function ScopePill(props: { agent: AgentDefinitionInfo }) {
  const { agent } = props;
  return (
    <>
      <Pill tone={agent.scope === "project" ? "ok" : "off"}>
        {t(`agentsWin.scope.${agent.scope}`)}
      </Pill>
      {agent.overridesGlobal ? <Pill tone="warn">{t("agentsWin.overrides")}</Pill> : null}
      {agent.overriddenByProject ? <Pill tone="off">{t("agentsWin.overridden")}</Pill> : null}
    </>
  );
}

export function AgentsModal() {
  const workspace = settingsWorkspace();
  const [view, setView] = useState<View>({ kind: "list" });
  const [dirty, setDirty] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const overview = useLoad(() => api.agentDefinitions(workspace?.id), [workspace?.id], ["agents"]);
  const templates = useLoad(() => api.agentTemplates(), []);
  const models = useLoad<AgentModelOption[]>(
    workspace ? () => api.agentModels(workspace.id) : undefined,
    [workspace?.id],
  );
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
    return () => previous?.focus();
  }, []);

  const defaultScope = overview.data?.defaultScope ?? (workspace ? "project" : "global");
  const activeModel = () => models.data?.find((m) => m.active)?.reference ?? "";
  const leaveEditor = () => {
    if (view.kind === "editor" && dirty && !window.confirm(t("agentsWin.unsavedLeave")))
      return false;
    setDirty(false);
    setView({ kind: "list" });
    return true;
  };
  const close = () => {
    if (view.kind === "editor" && dirty && !window.confirm(t("agentsWin.unsavedLeave"))) return;
    agentsOpen.value = false;
  };
  const openTemplate = (template: AgentTemplateInfo) =>
    setView({
      kind: "editor",
      key: `template:${template.id}:${Date.now()}`,
      form: formFromTemplate(template, defaultScope, activeModel()),
      assist: true,
    });
  const remove = async (agent: AgentDefinitionInfo) => {
    if (!window.confirm(t("agentsWin.deleteConfirm", { path: agent.path }))) return;
    try {
      const result = await api.deleteAgent(agent.id, agent.scope, workspace?.id);
      showToast(t(result.live ? "agentsWin.deleted" : "agentsWin.deletedRestart"));
      overview.reload();
    } catch (error) {
      showToast(errorText(error));
    }
  };
  const agents = overview.data?.agents ?? [];
  return (
    <div
      class={settings.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialog}
        class={`${settings.dialog} ${styles.shell}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agents-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            if (view.kind === "editor") leaveEditor();
            else close();
          }
          if (event.key === "Tab") {
            const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
            const first = focusable[0];
            const last = focusable.at(-1);
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
        <div class={settings.content}>
          <div class={settings.topBar}>
            <nav class={styles.breadcrumb} aria-label={t("agentsWin.title")}>
              {view.kind === "editor" ? (
                <>
                  <button type="button" class={styles.crumbLink} onClick={leaveEditor}>
                    {t("agentsWin.back")}
                  </button>
                  <Icon name="chevronRight" size={14} />
                  <span class={styles.crumbCurrent} id="agents-title" aria-current="page">
                    {view.form.id ? view.form.name : t("agentsWin.newAgent")}
                  </span>
                </>
              ) : (
                <span class={styles.crumbCurrent} id="agents-title">
                  {t("agentsWin.title")}
                </span>
              )}
            </nav>
            <button type="button" class="icon-btn" aria-label={t("common.close")} onClick={close}>
              <Icon name="x" size={18} />
            </button>
          </div>
          {view.kind === "editor" ? (
            <AgentEditor
              key={view.key}
              initial={view.form}
              {...(view.saved ? { saved: view.saved } : {})}
              assist={view.assist}
              workspace={workspace}
              overview={overview.data}
              models={models.data}
              modelsError={models.error}
              onDirty={setDirty}
              onTrusted={() => {
                overview.reload();
                models.reload();
              }}
              onSaved={(form) => {
                overview.reload();
                // Same key: the editor keeps its state (e.g. the "created" prompt).
                setView((current) =>
                  current.kind === "editor" ? { ...current, form, saved: form } : current,
                );
              }}
            />
          ) : (
            <>
              <header class={`${settings.intro} ${styles.listHead}`}>
                <div>
                  <h3 class={settings.pageTitle}>{t("agentsWin.title")}</h3>
                  <p class={settings.lead}>{t("agentsWin.lead")}</p>
                  {!workspace ? <p class={settings.note}>{t("agentsWin.noWorkspace")}</p> : null}
                </div>
                <button
                  type="button"
                  class={settings.primary}
                  onClick={() =>
                    setView({
                      kind: "editor",
                      key: `new:${Date.now()}`,
                      form: emptyForm(defaultScope, activeModel()),
                      assist: true,
                    })
                  }
                >
                  {t("agentsWin.create")}
                </button>
              </header>
              <h4 class={settings.listTitle}>
                {t("agentsWin.yours")}
                <span class={settings.count}>{agents.length}</span>
              </h4>
              <Status loading={overview.loading && !overview.data} error={overview.error} />
              {overview.data && !agents.length ? (
                <p class={settings.note}>{t("agentsWin.none")}</p>
              ) : null}
              <ul class={settings.rows}>
                {agents.map((agent) => (
                  <li
                    key={`${agent.scope}:${agent.id}`}
                    class={settings.row}
                    data-muted={agent.overriddenByProject ? "true" : undefined}
                  >
                    <button
                      type="button"
                      class={styles.rowButton}
                      onClick={() => {
                        const form = formFromDefinition(agent);
                        setView({
                          kind: "editor",
                          key: `${agent.scope}:${agent.id}`,
                          form,
                          saved: form,
                          assist: false,
                        });
                      }}
                    >
                      <span class={settings.rowTitle}>
                        <span class={settings.cardName}>{agent.name}</span>
                        <ScopePill agent={agent} />
                      </span>
                      <p class={settings.cardText}>{agent.description}</p>
                      <p class={settings.meta}>
                        {agent.model || "—"} · <code>{agent.id}</code>
                      </p>
                    </button>
                    <div class={settings.rowActions}>
                      <button
                        type="button"
                        class="icon-btn"
                        aria-label={`${t("agentsWin.delete")} ${agent.name}`}
                        title={t("agentsWin.delete")}
                        onClick={() => void remove(agent)}
                      >
                        <Icon name="archive" size={16} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <h4 class={settings.listTitle}>{t("agentsWin.templates")}</h4>
              <Status loading={templates.loading && !templates.data} error={templates.error} />
              <ul class={settings.grid}>
                {(templates.data ?? []).map((template) => (
                  <li key={template.id}>
                    <button
                      type="button"
                      class={styles.templateCard}
                      onClick={() => openTemplate(template)}
                    >
                      <span class={styles.templateName}>{template.name}</span>
                      <span class={styles.templateText}>{template.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
