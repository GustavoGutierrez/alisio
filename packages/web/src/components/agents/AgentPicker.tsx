/**
 * `/agents` in the chat (and the header badge): a searchable list of the loaded agents with their
 * Project/Global badge and the current one marked. Selecting one activates it in this chat from
 * its next prompt; `build` returns to the default Alisio agent.
 */
import type { AgentInfo } from "@alisio/sdk";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { filterAgents, presetScope } from "../../store/agents.ts";
import { activateAgent, agentPickerOpen, agentsOpen, api, detail } from "../../store/app.ts";
import { Icon } from "../icons.tsx";
import settings from "../settings/settings.module.css";
import { Pill, SearchBox, Status, settingsWorkspace, useLoad } from "../settings/shared.tsx";
import styles from "./agents.module.css";

export function AgentPicker() {
  const workspace = settingsWorkspace();
  const presets = useLoad(
    workspace ? () => api.agents(workspace.id) : undefined,
    [workspace?.id],
    ["agents"],
  );
  const definitions = useLoad(
    () => api.agentDefinitions(workspace?.id),
    [workspace?.id],
    ["agents"],
  );
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => previous?.focus();
  }, []);
  const close = () => {
    agentPickerOpen.value = false;
  };
  const session = detail.value;
  const current = session?.agent ?? presets.data?.find((a) => a.default)?.id;
  const visible = filterAgents(presets.data ?? [], query);
  const choose = (agent: AgentInfo) => {
    close();
    void activateAgent(agent.id);
  };
  const badge = (agent: AgentInfo) => {
    const scope = presetScope(agent, definitions.data?.agents ?? []);
    if (scope)
      return <Pill tone={scope === "project" ? "ok" : "off"}>{t(`agentsWin.scope.${scope}`)}</Pill>;
    return (
      <Pill tone="off">
        {agent.source === "builtin" ? t("agentsWin.builtin") : t("agentsWin.plugin")}
      </Pill>
    );
  };
  return (
    <div
      class={settings.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={root}
        class={`${settings.dialog} ${styles.picker}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-picker-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setIndex((i) => (visible.length ? (i + step + visible.length) % visible.length : 0));
          } else if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT") {
            event.preventDefault();
            const agent = visible[Math.min(index, visible.length - 1)];
            if (agent) choose(agent);
          }
        }}
      >
        <div class={styles.pickerHead}>
          <div class={styles.listHead}>
            <div>
              <h3 class={settings.pageTitle} id="agent-picker-title">
                {t("agentsWin.picker")}
              </h3>
              <p class={settings.note}>{t("agentsWin.pickerLead")}</p>
            </div>
            <button type="button" class="icon-btn" aria-label={t("common.close")} onClick={close}>
              <Icon name="x" size={18} />
            </button>
          </div>
          <SearchBox
            value={query}
            label={t("agentsWin.pickerSearch")}
            onInput={(value) => {
              setQuery(value);
              setIndex(0);
            }}
          />
        </div>
        <div style={{ padding: "0 18px" }}>
          <Status
            loading={presets.loading && !presets.data}
            error={presets.error}
            empty={!workspace ? "settings.noWorkspace" : undefined}
          />
        </div>
        <ul class={styles.pickerList} aria-label={t("agentsWin.picker")}>
          {presets.data && !visible.length ? (
            <li class={settings.note}>{t("agentsWin.pickerEmpty", { query })}</li>
          ) : null}
          {visible.map((agent, i) => (
            <li key={agent.id}>
              <button
                type="button"
                class={styles.pickerItem}
                data-selected={i === index}
                aria-current={agent.id === current ? "true" : undefined}
                onMouseEnter={() => setIndex(i)}
                onClick={() => choose(agent)}
              >
                <span class={styles.pickerTitle}>
                  {agent.name}
                  {badge(agent)}
                  {agent.id === current ? <Pill tone="ok">{t("agentsWin.current")}</Pill> : null}
                  {agent.id === "build" ? (
                    <Pill tone="off">{t("agentsWin.defaultAgent")}</Pill>
                  ) : null}
                  {agent.readOnly ? <Pill tone="warn">{t("agents.readOnly")}</Pill> : null}
                </span>
                <span class={settings.cardText}>{agent.description}</span>
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              class={styles.pickerItem}
              onClick={() => {
                close();
                agentsOpen.value = true;
              }}
            >
              <span class={styles.pickerTitle}>
                <Icon name="users" size={15} />
                {t("agentsWin.manage")}
              </span>
            </button>
          </li>
        </ul>
      </div>
    </div>
  );
}
