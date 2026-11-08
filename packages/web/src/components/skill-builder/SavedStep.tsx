/** Final state: where the skill was saved and whether it is already active. */
import type { SkillCreateResult } from "@alisio/sdk";
import { useState } from "preact/hooks";
import { api } from "../../store/app.ts";
import { errorText } from "../../store/errors.ts";
import { Icon } from "../icons.tsx";
import { Spinner } from "./parts.tsx";
import styles from "./skill-builder.module.css";
import { sb } from "./strings.ts";

export function SavedStep(props: {
  result: SkillCreateResult;
  workspaceId: string | undefined;
  onViewSkills: () => void;
  onAnother: () => void;
  onClose: () => void;
}) {
  const { result } = props;
  const [live, setLive] = useState(result.reloaded);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const reload = async () => {
    if (!props.workspaceId) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await api.reloadWorkspace(props.workspaceId);
      setLive(true);
    } catch (error) {
      setMessage(sb("reloadFailed", { message: errorText(error) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class={styles.page}>
      <div class={styles.saved}>
        <span class={styles.savedIcon}>
          <Icon name="check" size={22} />
        </span>
        <h2 class={styles.title} id="sb-step-title" tabIndex={-1}>
          {sb("savedTitle")}
        </h2>
        <p>
          {sb("savedAt", { path: "" })}
          <span class={styles.pathCode}>{result.skill.path}/</span>
        </p>
        <p class={styles.lead} role="status" aria-live="polite">
          {live
            ? message
              ? ""
              : result.reloaded
                ? sb("savedActive")
                : sb("reloaded")
            : sb("savedPending", { reason: result.reason ?? "" })}
        </p>
        {message ? (
          <p class={styles.fieldIssue} role="alert">
            {message}
          </p>
        ) : null}
        {!live ? (
          <button
            type="button"
            class={styles.secondaryBtn}
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => void reload()}
          >
            {busy ? <Spinner /> : <Icon name="refresh" size={15} />}
            {busy ? sb("reloading") : sb("reloadNow")}
          </button>
        ) : null}
      </div>
      <div class={styles.actionBar}>
        <button type="button" class={styles.secondaryBtn} onClick={props.onViewSkills}>
          {sb("viewSkills")}
        </button>
        <button type="button" class={styles.secondaryBtn} onClick={props.onAnother}>
          {sb("createAnother")}
        </button>
        <span class={styles.actionSpacer} />
        <button type="button" class={styles.primaryBtn} onClick={props.onClose}>
          {sb("done")}
        </button>
      </div>
    </div>
  );
}
