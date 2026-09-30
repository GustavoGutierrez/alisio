import type { ToolResult } from "@alisio/sdk";
import { useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { RendererHost } from "../../renderers/RendererHost.tsx";
import { pluginNames } from "../../store/app.ts";
import { openInDock } from "../../store/dock.ts";
import { density } from "../../store/prefs.ts";
import type { ToolState } from "../../store/transcript.ts";
import {
  liveCommand,
  prettyArgs,
  toolLabel,
  toolPath,
  toolPlugin,
  toolSummary,
} from "../../util/tools.ts";
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

function Part({ part }: { part: ToolResult["content"][number] }) {
  if (part.type === "text") return <pre class={styles.output}>{part.text}</pre>;
  if (part.type === "ui") return <RendererHost block={part.block} />;
  return <img class={styles.image} src={`data:${part.mimeType};base64,${part.data}`} alt="" />;
}

/**
 * A tool result: rich parts (ui blocks, images) first; when there are any, the text parts (what
 * the model saw) fold under "Raw output".
 */
function ResultView({ result }: { result: ToolResult }) {
  const rich = result.content.filter((part) => part.type !== "text");
  const text = result.content.filter((part) => part.type === "text");
  if (!rich.length)
    return (
      <>
        {text.map((part, i) => (
          <Part key={i} part={part} />
        ))}
      </>
    );
  return (
    <>
      {rich.map((part, i) => (
        <Part key={i} part={part} />
      ))}
      {text.length ? (
        <details class={styles.raw}>
          <summary>{t("tool.rawOutput")}</summary>
          {text.map((part, i) => (
            <Part key={i} part={part} />
          ))}
        </details>
      ) : null}
    </>
  );
}

/** A compact one-line tool call (`Read · README.md`) that expands to its input and output. */
export function ToolRow({ tool }: { tool: ToolState }) {
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const expanded = open ?? density.value === "detailed";
  const label = toolLabel(tool.name);
  const plugin = toolPlugin(tool.name, pluginNames.value);
  const summary = toolSummary(tool.arguments);
  const path = toolPath(tool.arguments);
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
