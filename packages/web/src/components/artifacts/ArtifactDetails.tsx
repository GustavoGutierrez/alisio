import { Fragment } from "preact";
import { t } from "../../i18n/index.ts";
import type { ArtifactDetail } from "../../net/api.ts";
import { dashboardProvenance, formatSize } from "../../util/artifacts.ts";
import styles from "./panel.module.css";

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

/**
 * Provenance of an artifact (spec §19): date, size, files, model, provider, runtime, inputs with
 * their hashes and the execution. Never the script itself, never a local path.
 */
export function ArtifactDetails(props: { detail: ArtifactDetail }) {
  const { detail } = props;
  const p = detail.provenance;
  const runtime = p.runtime as
    | {
        mode?: string;
        python?: string;
        extras?: string[];
        runtimeVersion?: string;
        engine?: string;
        image?: string;
      }
    | undefined;
  const inputs = Array.isArray(p.inputs)
    ? (p.inputs as Array<{ name?: string; sha256?: string }>)
    : [];
  const dashboard = dashboardProvenance(p);
  const rows: Array<[string, preact.ComponentChildren]> = [
    [t("artifactPanel.created"), new Date(detail.createdAt).toLocaleString()],
    [t("artifactPanel.size"), formatSize(detail.bytes)],
    [t("artifactPanel.files"), String(detail.files.length || detail.fileCount)],
    ...(str(p.model)
      ? ([[t("artifactPanel.model"), str(p.model)]] as Array<[string, string]>)
      : []),
    ...(str(p.provider)
      ? ([[t("artifactPanel.provider"), str(p.provider)]] as Array<[string, string]>)
      : []),
    ...(dashboard
      ? ([
          [
            t("artifactPanel.dashboard"),
            [
              t(
                dashboard.planner === "rules"
                  ? "artifactPanel.plannerRules"
                  : "artifactPanel.plannerDecisions",
              ),
              dashboard.decisionProvider,
            ]
              .filter(Boolean)
              .join(" · "),
          ],
        ] as Array<[string, string]>)
      : []),
    ...(runtime
      ? ([
          [
            t("artifactPanel.runtime"),
            [
              runtime.mode,
              runtime.engine,
              runtime.python ? `Python ${runtime.python}` : undefined,
              runtime.image?.replace(/(@sha256:[a-f0-9]{12})[a-f0-9]+$/, "$1…"),
              runtime.extras?.length ? runtime.extras.join(", ") : undefined,
              runtime.runtimeVersion,
            ]
              .filter(Boolean)
              .join(" · "),
          ],
        ] as Array<[string, string]>)
      : []),
    ...(inputs.length
      ? ([
          [
            t("artifactPanel.inputs"),
            <ul key="inputs" class={styles.mono}>
              {inputs.map((input) => (
                <li key={`${input.name}-${input.sha256}`}>
                  {input.name} · {input.sha256?.slice(0, 12)}
                </li>
              ))}
            </ul>,
          ],
        ] as Array<[string, preact.ComponentChildren]>)
      : []),
    ...(str(p.executionId)
      ? ([
          [t("artifactPanel.execution"), <span class={styles.mono}>{str(p.executionId)}</span>],
        ] as Array<[string, preact.ComponentChildren]>)
      : []),
    ...(str(p.rerunOf)
      ? ([[t("artifactPanel.rerunOf"), <span class={styles.mono}>{str(p.rerunOf)}</span>]] as Array<
          [string, preact.ComponentChildren]
        >)
      : []),
    ...(detail.status !== "ready"
      ? ([
          [
            t("artifactPanel.status"),
            t(detail.status === "expired" ? "artifact.expired" : "artifact.deleted"),
          ],
        ] as Array<[string, string]>)
      : []),
    ...(str(p.scriptSha256)
      ? ([
          [
            t("artifactPanel.script"),
            <span class={styles.mono}>{str(p.scriptSha256)?.slice(0, 16)}</span>,
          ],
        ] as Array<[string, preact.ComponentChildren]>)
      : []),
  ];
  return (
    <section class={styles.sheet} aria-label={t("artifactPanel.detailsTitle")}>
      <h3>{t("artifactPanel.detailsTitle")}</h3>
      <dl class={styles.details}>
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value ?? t("artifactPanel.none")}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}
