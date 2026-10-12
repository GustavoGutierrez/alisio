/**
 * The parts of the Forja cards (Forja spec §11.2, Python spec §9.4): the engine and isolation
 * badge, the live list of nested calls, the progress bar and the body of a `js_run` card. The
 * decisions (which card, what the result means) are in `util/forge-card.ts` and `util/forge.ts`.
 */
import type { EngineId, IsolationLevel, ToolResult } from "@alisio/sdk";
import { t } from "../../i18n/index.ts";
import CodeView from "../../renderers/code/view.tsx";
import { RendererHost } from "../../renderers/RendererHost.tsx";
import type { ToolState } from "../../store/transcript.ts";
import { callCounts, type ForgeCallView, type ForgeView } from "../../util/forge.ts";
import { codeOf, engineBadge, parseJsResult } from "../../util/forge-card.ts";
import { toolLabel } from "../../util/tools.ts";
import { CopyButton } from "../CopyButton.tsx";
import { Icon } from "../icons.tsx";
import { ResultView } from "./ResultView.tsx";
import styles from "./transcript.module.css";

/** Engine and isolation in words and an icon; code on the host is flagged as a warning. */
export function EngineBadge(props: { engine: EngineId; isolation?: IsolationLevel }) {
  const badge = engineBadge(props.engine, props.isolation);
  return (
    <span
      class={styles.engineBadge}
      data-tone={badge.tone}
      title={t(badge.sandboxed ? "forge.sandboxed" : "forge.notSandboxed")}
    >
      <Icon name={badge.icon} size={12} />
      {t(badge.label)}
    </span>
  );
}

/** A thin bar for `completed` of `total`; announced to assistive technology as a progress bar. */
export function ForgeBar(props: { completed: number; total: number }) {
  const total = Math.max(1, props.total);
  const done = Math.min(Math.max(0, props.completed), total);
  return (
    <div
      class={styles.bar}
      role="progressbar"
      aria-label={t("forge.progress")}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-valuetext={t("forge.progressText", { completed: done, total })}
    >
      <span class={styles.barFill} style={{ width: `${Math.round((done / total) * 100)}%` }} />
    </div>
  );
}

const CALL_ICONS = {
  started: "refresh",
  succeeded: "check",
  failed: "x",
  denied: "shield",
} as const;

function CallRow({ call }: { call: ForgeCallView }) {
  return (
    <li class={styles.callRow} data-status={call.status}>
      <span class={styles.callIcon}>
        {call.status === "started" ? (
          <span class={`${styles.spinner} spin`} />
        ) : (
          <Icon name={CALL_ICONS[call.status]} size={12} />
        )}
      </span>
      <span class={styles.callTool}>{toolLabel(call.tool)}</span>
      <span class={styles.callStatus}>{t(`forge.call.${call.status}`)}</span>
      {call.durationMs !== undefined ? (
        <span class={styles.duration}>{t("tool.duration", { ms: call.durationMs })}</span>
      ) : null}
    </li>
  );
}

/** The nested calls of a script, in the order they began, updated while they run. */
export function CallList({ view }: { view: ForgeView }) {
  const counts = callCounts(view);
  return (
    <>
      <ul class={styles.calls} aria-label={t("forge.calls")}>
        {view.calls.map((call) => (
          <CallRow key={call.callId} call={call} />
        ))}
      </ul>
      <p class={styles.hint}>
        {t("forge.callsSummary", {
          total: counts.total,
          failed: counts.failed,
          denied: counts.denied,
        })}
      </p>
    </>
  );
}

const textOf = (result: ToolResult): string =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

/** What the finished script returned: the value, what it printed, the counters and any error. */
function JsOutcome({ result, listed }: { result: ToolResult; listed: boolean }) {
  const parsed = parseJsResult(textOf(result));
  if (!parsed) return <ResultView result={result} />;
  const structured =
    parsed.value !== null && typeof parsed.value === "object" ? parsed.value : undefined;
  const hasValue = parsed.value !== undefined;
  return (
    <>
      {hasValue ? (
        structured !== undefined ? (
          <RendererHost block={{ kind: "json", value: structured, collapsedDepth: 2 }} />
        ) : (
          <pre class={styles.output}>{String(parsed.value)}</pre>
        )
      ) : null}
      {parsed.output ? <pre class={styles.output}>{parsed.output}</pre> : null}
      {!hasValue && !parsed.output && !parsed.error ? (
        <p class={styles.hint}>{t("forge.noValue")}</p>
      ) : null}
      {parsed.truncated ? <p class={styles.hint}>{t("forge.outputCut")}</p> : null}
      {/* After a reload the per-call list is gone; the counters of the result remain. */}
      {!listed && parsed.calls?.total ? (
        <p class={styles.hint}>{t("forge.callsSummary", parsed.calls)}</p>
      ) : null}
      {parsed.error ? (
        <div class={styles.forgeError} role="alert">
          <p>
            <strong>{parsed.error.code}</strong> {parsed.error.message}
          </p>
          {parsed.hint ? <p class={styles.hint}>{parsed.hint}</p> : null}
        </div>
      ) : null}
    </>
  );
}

/** The expanded body of a `js_run` card. There is no "repeat": a script runs again only if asked. */
export function JsRunBody(props: { tool: ToolState; id: string }) {
  const { tool } = props;
  const { code, codePath } = codeOf(tool.arguments);
  const view = tool.forge;
  return (
    <div id={props.id} class={styles.processBody}>
      <p class={styles.sectionLabel}>{t("forge.code")}</p>
      {code !== undefined ? (
        <CodeView
          block={{ kind: "code", code, lang: "javascript" }}
          live={tool.status === "running"}
          copyLabel={t("forge.copyCode")}
        />
      ) : codePath ? (
        <p class={styles.codeFile}>
          <code>{codePath}</code>
          <CopyButton text={() => codePath} label={t("forge.copyPath")} />
          <span class={styles.hint}>{t("forge.codeFile")}</span>
        </p>
      ) : (
        <p class={styles.hint}>{t("forge.noCode")}</p>
      )}
      {view?.calls.length ? (
        <>
          <p class={styles.sectionLabel}>{t("forge.calls")}</p>
          <CallList view={view} />
        </>
      ) : null}
      <p class={styles.sectionLabel}>{t("tool.output")}</p>
      {tool.result ? (
        <JsOutcome result={tool.result} listed={!!view?.calls.length} />
      ) : tool.tail ? (
        <pre class={styles.output}>{tool.tail}</pre>
      ) : (
        <p class={styles.hint}>
          {tool.status === "pending" ? t("tool.pending") : t("tool.noOutput")}
        </p>
      )}
    </div>
  );
}
