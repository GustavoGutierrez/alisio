import { useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { Markdown } from "../../markdown/view.tsx";
import { RendererHost } from "../../renderers/RendererHost.tsx";
import { pluginNames } from "../../store/app.ts";
import { openInDock } from "../../store/dock.ts";
import { planFromArguments } from "../../store/plan-review.ts";
import { density } from "../../store/prefs.ts";
import type { ToolState } from "../../store/transcript.ts";
import { forgeProgressLine } from "../../util/forge.ts";
import { cardKind, engineOfCard, liveAnnouncement } from "../../util/forge-card.ts";
import {
  liveCommand,
  prettyArgs,
  toolLabel,
  toolPath,
  toolPlugin,
  toolProgressLine,
  toolSummary,
} from "../../util/tools.ts";
import { Icon, type IconName } from "../icons.tsx";
import { EngineBadge, ForgeBar, JsRunBody } from "./ForgeParts.tsx";
import { ResultView } from "./ResultView.tsx";
import styles from "./transcript.module.css";

const ICONS: Record<string, IconName> = {
  read_file: "file",
  write_file: "edit",
  edit_file: "edit",
  list_files: "folder",
  search_text: "search",
  glob: "search",
  shell: "terminal",
  run_process: "terminal",
  web_fetch: "globe",
  web_search: "globe",
  ask_user_question: "question",
  exit_plan: "file",
  js_run: "terminal",
  python_run: "terminal",
};

/** A compact one-line tool call (`Read · README.md`) that expands to its input and output. */
export function ToolRow({ tool }: { tool: ToolState }) {
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  // The plan of `exit_plan` is the answer of the turn: it is shown open, as Markdown, in the chat.
  const plan = tool.name === "exit_plan" ? planFromArguments(tool.arguments) : undefined;
  const expanded = open ?? (!!plan || density.value === "detailed");
  // Forja cards (`js_run`, `python_run`) add an engine badge and live progress; `execute` and every
  // other tool keep the generic row.
  const kind = cardKind(tool.name);
  const resultText =
    tool.result?.content.map((part) => (part.type === "text" ? part.text : "")).join("") ?? "";
  const engine =
    kind === "generic"
      ? undefined
      : engineOfCard({
          resultText,
          ...(tool.forge ? { forgeEngine: tool.forge.engine } : {}),
        });
  const label = kind === "javascript" ? t("forge.js.title") : toolLabel(tool.name);
  const plugin = toolPlugin(tool.name, pluginNames.value);
  const summary = toolSummary(tool.arguments);
  const path = toolPath(tool.arguments);
  const progress =
    tool.status === "running"
      ? kind !== "generic" && tool.forge
        ? forgeProgressLine(tool.forge)
        : toolProgressLine(tool.tail)
      : "";
  const showBar =
    kind !== "generic" &&
    tool.status === "running" &&
    tool.forge?.total !== undefined &&
    tool.forge.total > 0;
  const id = `tool-${tool.id}`;
  return (
    <div class={styles.process} data-status={tool.status}>
      <div class={styles.headRow}>
        <button
          type="button"
          class={styles.processHead}
          aria-expanded={expanded}
          aria-controls={id}
          aria-label={`${t("tool.expand", { name: label })}${summary ? `: ${summary}` : ""}`}
          onClick={() => setOpen(!expanded)}
        >
          <span class={styles.processIcon}>
            <Icon name={expanded ? "chevronDown" : (ICONS[tool.name] ?? "tool")} size={15} />
          </span>
          <span class={styles.processName}>{label}</span>
          {plugin ? <span class={styles.pluginTag}>{plugin}</span> : null}
          {summary ? (
            <>
              <span class={styles.dot} aria-hidden="true">
                ·
              </span>
              <span class={path ? `${styles.summary} ${styles.fileRef}` : styles.summary}>
                {summary}
              </span>
            </>
          ) : null}
          {engine ? <EngineBadge engine={engine.engine} isolation={engine.isolation} /> : null}
          {progress && !expanded ? <span class={styles.progress}>{progress}</span> : null}
          <span class={styles.processState}>
            {tool.status === "running" ? (
              <span class={`${styles.spinner} spin`} title={t("tool.running")} />
            ) : tool.status === "failed" ? (
              <span class={styles.failed}>{t("tool.failed")}</span>
            ) : tool.durationMs !== undefined ? (
              <span class={styles.duration}>{t("tool.duration", { ms: tool.durationMs })}</span>
            ) : null}
          </span>
        </button>
        {path ? (
          <button
            type="button"
            class={`icon-btn ${styles.openFile}`}
            aria-label={t("tool.openFile", { path })}
            title={t("tool.openFile", { path })}
            onClick={() => void openInDock(path)}
          >
            <Icon name="panel" size={14} />
          </button>
        ) : null}
      </div>
      {kind !== "generic" ? (
        <span class="sr-only" role="status" aria-live="polite">
          {liveAnnouncement(tool.status, tool.forge)}
        </span>
      ) : null}
      {showBar && tool.forge ? (
        <ForgeBar completed={tool.forge.completed ?? 0} total={tool.forge.total ?? 0} />
      ) : null}
      {kind === "python" && engine?.reason ? (
        <p class={styles.reason} title={engine.reason}>
          {t("forge.reason", { reason: engine.reason })}
        </p>
      ) : null}
      {expanded && kind === "javascript" ? (
        <JsRunBody tool={tool} id={id} />
      ) : expanded ? (
        <div id={id} class={styles.processBody}>
          {plan ? (
            <div class={styles.answer}>
              <Markdown text={plan.plan} />
            </div>
          ) : (
            <>
              <p class={styles.sectionLabel}>{t("tool.input")}</p>
              <pre class={styles.output}>{prettyArgs(tool.arguments)}</pre>
            </>
          )}
          <p class={styles.sectionLabel}>{t("tool.output")}</p>
          {tool.result ? (
            <>
              <ResultView result={tool.result} />
              {tool.truncated ? <p class={styles.hint}>{t("tool.truncated")}</p> : null}
            </>
          ) : tool.tail && liveCommand(tool) !== undefined ? (
            <RendererHost
              block={{ kind: "terminal", command: liveCommand(tool), output: tool.tail }}
              live={tool.status === "running"}
            />
          ) : tool.tail ? (
            <pre class={styles.output}>{tool.tail}</pre>
          ) : tool.preview ? (
            <pre class={styles.output}>{tool.preview}</pre>
          ) : (
            <p class={styles.hint}>
              {tool.status === "pending" ? t("tool.pending") : t("tool.noOutput")}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** `Think · first line…`, expandable to the whole reasoning (never persisted). */
export function ThinkRow({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const first = text.trim().split("\n")[0] ?? "";
  return (
    <div class={styles.process}>
      <button
        type="button"
        class={styles.processHead}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span class={styles.processIcon}>
          <Icon name={open ? "chevronDown" : "sparkle"} size={15} />
        </span>
        <span class={styles.processName}>{t("transcript.think")}</span>
        {first ? (
          <>
            <span class={styles.dot} aria-hidden="true">
              ·
            </span>
            <span class={styles.summary}>{first}</span>
          </>
        ) : null}
        {live ? (
          <span class={styles.processState}>
            <span class={`${styles.spinner} spin`} />
          </span>
        ) : null}
      </button>
      {open ? <p class={styles.thinkBody}>{text}</p> : null}
    </div>
  );
}
