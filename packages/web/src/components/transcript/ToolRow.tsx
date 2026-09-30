import type { ToolResult } from "@alisio/sdk";
import { useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { RendererHost } from "../../renderers/RendererHost.tsx";
import { density } from "../../store/prefs.ts";
import type { ToolState } from "../../store/transcript.ts";
import { prettyArgs, toolLabel, toolPath, toolSummary } from "../../util/tools.ts";
import { Icon, type IconName } from "../icons.tsx";
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
};

function ResultView({ result }: { result: ToolResult }) {
  return (
    <>
      {result.content.map((part, i) =>
        part.type === "text" ? (
          <pre key={i} class={styles.output}>
            {part.text}
          </pre>
        ) : part.type === "ui" ? (
          <RendererHost key={i} block={part.block} />
        ) : (
          <img
            key={i}
            class={styles.image}
            src={`data:${part.mimeType};base64,${part.data}`}
            alt=""
          />
        ),
      )}
    </>
  );
}

/** A compact one-line tool call (`Read · README.md`) that expands to its input and output. */
export function ToolRow({ tool }: { tool: ToolState }) {
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const expanded = open ?? density.value === "detailed";
  const label = toolLabel(tool.name);
  const summary = toolSummary(tool.arguments);
  const path = toolPath(tool.arguments);
  const id = `tool-${tool.id}`;
  return (
    <div class={styles.process} data-status={tool.status}>
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
      {expanded ? (
        <div id={id} class={styles.processBody}>
          <p class={styles.sectionLabel}>{t("tool.input")}</p>
          <pre class={styles.output}>{prettyArgs(tool.arguments)}</pre>
          <p class={styles.sectionLabel}>{t("tool.output")}</p>
          {tool.result ? (
            <>
              <ResultView result={tool.result} />
              {tool.truncated ? <p class={styles.hint}>{t("tool.truncated")}</p> : null}
            </>
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
