import type { PendingApproval } from "@alisio/sdk";
import { useEffect, useRef } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { decide, detail } from "../../store/app.ts";
import { formatSize } from "../../util/artifacts.ts";
import { toolLabel } from "../../util/tools.ts";
import { Icon } from "../icons.tsx";
import styles from "./approval.module.css";

/** Ignore activations this long after the panel appears (a stray Enter must not approve). */
const GUARD_MS = 300;

/**
 * Takes the composer's place while an approval waits (RF-08): focus moves here, the request is
 * announced, D/O/S answer, and focus returns to the composer afterwards.
 */
export function ApprovalPanel({ approvals }: { approvals: PendingApproval[] }) {
  const approval = approvals[0] as PendingApproval;
  const panel = useRef<HTMLDivElement>(null);
  const shownAt = useRef(0);
  useEffect(() => {
    shownAt.current = Date.now();
    panel.current?.focus();
  }, [approval.approvalId]);

  const answer = (decision: "once" | "session" | "deny") => {
    if (Date.now() - shownAt.current < GUARD_MS) return;
    void decide(approval.approvalId, decision);
  };

  const name = approval.name ? toolLabel(approval.name) : "";
  const analysis = approval.capability === "analysis.run";
  // Installing the optional packages: once or deny only (it is never remembered).
  const install = approval.capability === "analysis.install" ? approval.install : undefined;
  const title =
    approval.kind === "directory"
      ? t("approval.directory")
      : install
        ? t("approval.analysisInstall.title")
        : analysis
          ? t("approval.analysisRun.title")
          : t("approval.wants", {
              tool: name || (approval.name ?? ""),
              effect: t(`approval.effect.${approval.effect ?? "external"}`),
            });
  const titleId = `approval-title-${approval.approvalId}`;
  const bodyId = `approval-body-${approval.approvalId}`;
  return (
    <div class={styles.dock}>
      <div
        ref={panel}
        class={styles.panel}
        role="alertdialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        data-effect={approval.effect ?? "external"}
        onKeyDown={(event) => {
          if (
            event.target instanceof HTMLButtonElement &&
            (event.key === "Enter" || event.key === " ")
          ) {
            if (Date.now() - shownAt.current < GUARD_MS) event.preventDefault();
            return;
          }
          const key = event.key.toLowerCase();
          if (key === "d") answer("deny");
          else if (key === "o") answer("once");
          else if (key === "s" && !install) answer("session");
          else if (key === "enter") event.preventDefault();
        }}
      >
        <div class={styles.head}>
          <span class={styles.badge}>
            <Icon name="shield" size={16} />
          </span>
          <div class={styles.titles}>
            <p class={styles.eyebrow}>{t("approval.title")}</p>
            <h2 id={titleId} class={styles.title}>
              {title}
            </h2>
          </div>
          {approvals.length > 1 ? (
            <span class={styles.more}>{t("approval.more", { count: approvals.length - 1 })}</span>
          ) : null}
        </div>
        <div id={bodyId} class={styles.body}>
          {approval.label ? (
            <p class={styles.meta}>{t("approval.from", { label: approval.label })}</p>
          ) : null}
          {approval.sessionId !== approval.rootSessionId ? (
            <p class={styles.meta}>{t("approval.child")}</p>
          ) : null}
          {install ? (
            <>
              <p class={styles.warning} role="note">
                {t("approval.analysisInstall.network")}{" "}
                {t("approval.analysisInstall.size", {
                  size: formatSize(install.estimatedBytes),
                })}
              </p>
              <p class={styles.meta}>
                {t("approval.analysisInstall.packages", { packages: install.packages.join(", ") })}{" "}
                {t("approval.analysisInstall.dependencies", { count: install.packageCount })}
              </p>
              <p class={styles.meta}>
                {t("approval.analysisInstall.safety")} {t("approval.analysisInstall.once")}
              </p>
            </>
          ) : analysis ? (
            <>
              <p class={styles.warning} role="note">
                {approval.runtime === "oci"
                  ? `${t("approval.analysisRun.container")} ${t("approval.analysisRun.repo")}`
                  : `${t("approval.analysisRun.notSandboxed")} ${t("approval.analysisRun.repoManaged")}`}
              </p>
              <details class={styles.script}>
                <summary>{t("approval.analysisRun.script")}</summary>
                <pre class={styles.input}>{approval.preview ?? approval.input}</pre>
              </details>
            </>
          ) : (
            <>
              <p class={styles.meta}>{approval.directory ?? detail.value?.workspace}</p>
              {approval.input ? <pre class={styles.input}>{approval.input}</pre> : null}
            </>
          )}
        </div>
        <div class={styles.actions}>
          <button type="button" class={styles.deny} onClick={() => answer("deny")}>
            {t("approval.deny")}
            <kbd>D</kbd>
          </button>
          <span class={styles.gap} />
          {install ? null : (
            <button type="button" class={styles.secondary} onClick={() => answer("session")}>
              {analysis ? t("approval.allowForSession") : t("approval.session")}
              <kbd>S</kbd>
            </button>
          )}
          <button type="button" class={styles.primary} onClick={() => answer("once")}>
            {t("approval.once")}
            <kbd>O</kbd>
          </button>
        </div>
        <p class="sr-only">{t(install ? "approval.keysInstall" : "approval.keys")}</p>
      </div>
    </div>
  );
}
