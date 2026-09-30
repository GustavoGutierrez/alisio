/** Settings → Skills: discovered skills with their scope and an enable switch (RF-14). */
import type { SkillInfo } from "@alisio/sdk";
import { useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { api, showToast } from "../../store/app.ts";
import styles from "./settings.module.css";
import {
  errorMessage,
  PageIntro,
  Pill,
  SearchBox,
  Status,
  Switch,
  settingsWorkspace,
  useLoad,
} from "./shared.tsx";

export function SkillsPage() {
  const workspace = settingsWorkspace();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | undefined>();
  const skills = useLoad(
    workspace ? () => api.skills(workspace.id) : undefined,
    [workspace?.id],
    ["skills"],
  );
  const toggle = async (skill: SkillInfo, enabled: boolean) => {
    if (!workspace) return;
    setBusy(skill.id);
    try {
      const updated = await api.setSkill(workspace.id, skill.id, enabled);
      skills.set(
        (skills.data ?? []).map((s) => (s.id === updated.id && s.effective ? updated : s)),
      );
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  };
  const q = query.trim().toLowerCase();
  const list = (skills.data ?? []).filter(
    (s) => !q || s.displayId.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
  );
  return (
    <>
      <PageIntro title={t("settings.skills")} body={t("skills.lead")} workspace={workspace?.path} />
      <SearchBox value={query} label={t("skills.search")} onInput={setQuery} />
      <Status
        loading={skills.loading && !skills.data}
        error={skills.error}
        empty={
          !workspace
            ? "settings.noWorkspace"
            : skills.data && !list.length
              ? "skills.none"
              : undefined
        }
      />
      <ul class={styles.rows}>
        {list.map((skill) => (
          <li key={`${skill.id}:${skill.source}`} class={styles.row} data-muted={!skill.effective}>
            <div class={styles.rowMain}>
              <div class={styles.rowTitle}>
                <span class={styles.cardName}>{skill.displayId}</span>
                <Pill tone={skill.enabled && skill.effective ? "ok" : "off"}>
                  {skill.effective
                    ? skill.enabled
                      ? t("plugins.status.enabled")
                      : t("plugins.status.disabled")
                    : t("skills.shadowed")}
                </Pill>
              </div>
              <p class={styles.cardText}>{skill.description}</p>
              <p class={styles.meta}>
                {t("skills.meta", {
                  scope: skill.owner ? `${skill.scope} · ${skill.owner.name}` : skill.scope,
                  tokens: skill.approximateTokens,
                })}
                {skill.shadowedBy ? ` · ${t("skills.shadowedBy", { id: skill.shadowedBy })}` : ""}
                {skill.locked ? ` · ${t("skills.locked")}` : ""}
              </p>
            </div>
            <Switch
              checked={skill.enabled}
              label={t("plugins.enableNamed", { name: skill.displayId })}
              disabled={!skill.effective || !skill.manageable || skill.locked}
              busy={busy === skill.id}
              onChange={(enabled) => void toggle(skill, enabled)}
            />
          </li>
        ))}
      </ul>
    </>
  );
}
