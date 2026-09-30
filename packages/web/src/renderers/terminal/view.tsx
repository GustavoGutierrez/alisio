import type { UiBlock } from "@alisio/sdk";
import { useMemo, useState } from "preact/hooks";
import { CopyButton } from "../../components/CopyButton.tsx";
import { t } from "../../i18n/index.ts";
import { type AnsiSpan, parseAnsi, settleCarriageReturns, tailLines } from "./ansi.ts";
import styles from "./terminal.module.css";

type TerminalBlock = Extract<UiBlock, { kind: "terminal" }>;

/** Lines shown before "Show all" (spec §10.4). */
const VISIBLE_LINES = 2000;

const color = (value: number | string | undefined) =>
  value === undefined ? undefined : typeof value === "number" ? `var(--ansi-${value})` : value;

function Span({ span }: { span: AnsiSpan }) {
  const plain =
    span.fg === undefined &&
    span.bg === undefined &&
    !span.bold &&
    !span.dim &&
    !span.italic &&
    !span.underline &&
    !span.inverse;
  if (plain) return <>{span.text}</>;
  const fg = color(span.inverse ? span.bg : span.fg);
  const bg = color(span.inverse ? (span.fg ?? 7) : span.bg);
  return (
    <span
      style={{
        ...(fg ? { color: fg } : span.inverse ? { color: "var(--code-bg)" } : {}),
        ...(bg ? { background: bg } : {}),
        ...(span.bold ? { fontWeight: 700 } : {}),
        ...(span.dim ? { opacity: 0.7 } : {}),
        ...(span.italic ? { fontStyle: "italic" } : {}),
        ...(span.underline ? { textDecoration: "underline" } : {}),
      }}
    >
      {span.text}
    </span>
  );
}

/**
 * Read-only terminal output (spec §10.4): ANSI colors, the last 2 000 lines with "show all",
 * copy of the command and of the output, exit code and duration. `live` blocks come from
 * `tool_progress` and simply re-render as output grows.
 */
export default function TerminalView(props: { block: TerminalBlock; live?: boolean }) {
  const { block } = props;
  const [all, setAll] = useState(false);
  const settled = useMemo(() => settleCarriageReturns(block.output), [block.output]);
  const shown = all ? { text: settled, hidden: 0 } : tailLines(settled, VISIBLE_LINES);
  const spans = useMemo(() => parseAnsi(shown.text), [shown.text]);
  const plainOutput = () =>
    parseAnsi(settled)
      .map((s) => s.text)
      .join("");
  const exit = block.exitCode;
  return (
    <figure class={styles.block}>
      <figcaption class={styles.header}>
        <span class={styles.prompt} aria-hidden="true">
          $
        </span>
        <code class={styles.command}>{block.command ?? t("terminal.output")}</code>
        <span class={styles.actions}>
          {block.command ? (
            <CopyButton
              text={() => block.command ?? ""}
              class={styles.action}
              label={t("terminal.copyCommand")}
              showText
            />
          ) : null}
          <CopyButton
            text={plainOutput}
            class={styles.action}
            label={t("terminal.copyOutput")}
            showText
          />
        </span>
      </figcaption>
      {shown.hidden ? (
        <button type="button" class={styles.more} onClick={() => setAll(true)}>
          {t("terminal.showAll", { count: shown.hidden })}
        </button>
      ) : null}
      <pre class={styles.output} tabIndex={0} aria-live={props.live ? "off" : undefined}>
        {spans.length ? (
          spans.map((span, i) => <Span key={i} span={span} />)
        ) : (
          <span class={styles.empty}>
            {props.live ? t("terminal.waiting") : t("terminal.empty")}
          </span>
        )}
      </pre>
      {exit !== undefined || block.durationMs !== undefined || block.truncated || props.live ? (
        <p class={styles.footer}>
          {props.live ? <span class={styles.running}>{t("terminal.running")}</span> : null}
          {exit !== undefined ? (
            <span class={exit === 0 ? styles.ok : styles.fail}>
              {t("terminal.exit", { code: exit })}
            </span>
          ) : null}
          {block.durationMs !== undefined ? (
            <span>{t("tool.duration", { ms: block.durationMs })}</span>
          ) : null}
          {block.truncated ? <span>{t("terminal.truncated")}</span> : null}
        </p>
      ) : null}
    </figure>
  );
}
