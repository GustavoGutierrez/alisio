/**
 * Settings → Agent presets: the selectable main-session agents (built-ins `build`/`plan`, user
 * and main-capable plugin definitions). The open session can switch to one; editing definitions
 * stays out of scope in v1.
 */
import { useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { api, detail, patchCurrent } from "../../store/app.ts";
import { Icon } from "../icons.tsx";
import styles from "./settings.module.css";
import { PageIntro, Pill, Status, settingsWorkspace, useLoad } from "./shared.tsx";

export function AgentsPage() {
  const workspace = settingsWorkspace();
  const [expanded, setExpanded] = useState<string | undefined>();
  const agents = useLoad(
    workspace ? () => api.agents(workspace.id) : undefined,
    [workspace?.id],
    ["agents", "plugins"],
  );
  const session = detail.value;
  const current = session?.agent ?? agents.data?.find((a) => a.default)?.id;
  return (
    <>
      <PageIntro title={t("settings.agents")} body={t("agents.lead")} workspace={workspace?.path} />
      <Status
        loading={agents.loading && !agents.data}
        error={agents.error}
        empty={!workspace ? "settings.noWorkspace" : undefined}
      />
      <ul class={styles.rows}>
        {(agents.data ?? []).map((agent) => (
          <li key={agent.id} class={styles.row} data-current={agent.id === current}>
            <div class={styles.rowMain}>
              <div class={styles.rowTitle}>
                <span class={styles.cardName}>{agent.name}</span>
                <Pill tone="off">{t(`agents.source.${agent.source}`)}</Pill>
                {agent.readOnly ? <Pill tone="warn">{t("agents.readOnly")}</Pill> : null}
                {agent.default ? <Pill tone="ok">{t("agents.default")}</Pill> : null}
              </div>
              <p class={styles.cardText}>{agent.description}</p>
              {agent.model ? (
                <p class={styles.meta}>{t("agents.model", { model: agent.model })}</p>
              ) : null}
              {agent.instructions ? (
                <>
                  <button
                    type="button"
                    class={styles.linkButton}
                    aria-expanded={expanded === agent.id}
                    onClick={() => setExpanded(expanded === agent.id ? undefined : agent.id)}
                  >
                    <Icon name={expanded === agent.id ? "chevronDown" : "chevronRight"} size={14} />
                    {t("agents.instructions")}
                  </button>
                  {expanded === agent.id ? (
                    <pre class={styles.instructions}>{agent.instructions}</pre>
                  ) : null}
                </>
              ) : null}
            </div>
            <div class={styles.rowActions}>
              {session && !session.parentId ? (
                agent.id === current ? (
                  <span class={styles.meta}>{t("agents.inUse")}</span>
                ) : (
                  <button
                    type="button"
                    class={styles.secondary}
                    onClick={() => void patchCurrent({ agent: agent.id })}
                  >
                    {t("agents.use")}
                  </button>
                )
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
