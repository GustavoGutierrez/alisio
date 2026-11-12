/**
 * The creator run of a project: the five steps (pending, running, done, failed), a timer, the
 * agent's messages as a compact feed (tool calls behind "technical details"), its approvals and
 * questions inline, a reply box, Stop and Try again.
 */
import type { PluginCreatorProjectEntry } from "@alisio/sdk";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Markdown } from "../../markdown/view.tsx";
import { creatorSession } from "../../store/plugin-apps-state.ts";
import { type VisibleItem, visibleItems } from "../../store/transcript.ts";
import { useOverlayScrollbars } from "../../util/scrollbars.ts";
import { ApprovalPanel } from "../approval/ApprovalPanel.tsx";
import { InteractionPanel } from "../approval/InteractionPanel.tsx";
import { Icon } from "../icons.tsx";
import { ThinkRow, ToolRow } from "../transcript/ToolRow.tsx";
import styles from "./creator.module.css";
import { failureMessage } from "./failures.ts";
import { creatorFailure, formatClock, stepsView } from "./model.ts";
import {
  approvals,
  cancelRun,
  feed,
  interactions,
  prompt,
  readOnly,
  running,
  runStatus,
  startedAt,
  toastText,
} from "./store.ts";
import { type CrKey, cr } from "./strings.ts";

const STATUS_KEYS = {
  pending: "stepPending",
  running: "stepRunning",
  done: "stepDone",
  failed: "stepFailed",
} as const satisfies Record<string, CrKey>;

function FeedItem({ item, details }: { item: VisibleItem; details: boolean }) {
  switch (item.kind) {
    case "user":
      return <div class={styles.bubble}>{item.text}</div>;
    case "echo":
      return (
        <div class={styles.bubble} data-pending="true">
          {item.echo.display ?? item.echo.text}
        </div>
      );
    case "assistant":
      return item.text ? (
        <div class={styles.say}>
          <Markdown text={item.text} />
        </div>
      ) : null;
    case "streaming":
      return (
        <div class={styles.say}>
          <Markdown text={item.text} streaming />
        </div>
      );
    case "think":
      return details ? <ThinkRow text={item.text} live /> : null;
    case "tool":
      return details ? <ToolRow tool={item.tool} /> : null;
    default:
      return null;
  }
}

function Feed() {
  const [details, setDetails] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  useOverlayScrollbars(list);
  const stick = useRef(true);
  const state = feed.value;
  const items = visibleItems(state);
  // Follow the newest message unless the person scrolled up to read.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.version, details]);
  const shown = items.filter((item) => details || (item.kind !== "tool" && item.kind !== "think"));
  return (
    <div>
      <div class={styles.feedHead}>
        <h3>{cr("feedTitle")}</h3>
        <button
          type="button"
          class={styles.linkButton}
          aria-pressed={details}
          onClick={() => setDetails(!details)}
        >
          {details ? cr("hideDetails") : cr("showDetails")}
        </button>
      </div>
      <div
        ref={list}
        class={styles.feed}
        role="log"
        aria-label={cr("feedTitle")}
        onScroll={(event) => {
          const el = event.currentTarget as HTMLDivElement;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {shown.length ? (
          shown.map((item) => <FeedItem key={item.key} item={item} details={details} />)
        ) : (
          <p class={`${styles.muted} ${styles.small}`}>{cr("feedEmpty")}</p>
        )}
      </div>
    </div>
  );
}

function Reply({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | undefined>();
  const send = async (event: Event) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText("");
    setError(undefined);
    try {
      await prompt(sessionId, value);
    } catch (failure) {
      setText(value);
      setError(failureMessage(creatorFailure(failure)));
    }
  };
  return (
    <form class={styles.reply} onSubmit={send}>
      <label class="sr-only" for="creator-reply">
        {cr("replyLabel")}
      </label>
      <textarea
        id="creator-reply"
        class={styles.textarea}
        placeholder={cr("replyPlaceholder")}
        value={text}
        disabled={disabled}
        onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) void send(event);
        }}
      />
      <button type="submit" class={styles.ghost} disabled={disabled || !text.trim()}>
        {cr("send")}
      </button>
      {error ? (
        <p class={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function RunPanel({ entry }: { entry: PluginCreatorProjectEntry }) {
  const { project } = entry;
  const active = running.value;
  // Without an active run no step spins, even in records written before progress was settled.
  const steps = stepsView(project.progress?.steps, {
    active,
    packaged: entry.status.packageReady,
  });
  const status = runStatus.value;
  const sid = creatorSession.value;
  const waiting = approvals.value;
  const questions = interactions.value;
  const failed = !active && (status === "error" || steps.some((s) => s.status === "failed"));
  const lastRequest = project.requests.at(-1)?.at;
  const start = startedAt.value ?? lastRequest ?? Date.now();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const current = steps.find((s) => s.status === "running");
  const stateText = waiting.length
    ? cr("waitingApproval")
    : active
      ? cr("working")
      : status === "error"
        ? cr("runFailed")
        : cr("idle");

  return (
    <div class={styles.card}>
      <div class={styles.runHead}>
        <h2 class={styles.cardTitle}>
          <Icon name="wand" size={18} />
          {active ? cr("buildTitle", { name: project.displayName }) : cr("stepsLabel")}
        </h2>
        <span class={styles.timer} aria-hidden={!active}>
          {active ? cr("elapsed", { time: formatClock(now - start) }) : null}
        </span>
      </div>
      <p class={styles.runState} role="status" aria-live="polite">
        {active && !waiting.length ? <span class={styles.spinner} aria-hidden="true" /> : null}
        {waiting.length ? <Icon name="shield" size={16} /> : null}
        <span>
          {stateText}
          {current ? ` ${cr(`step_${current.id}` as CrKey)}…` : ""}
        </span>
      </p>
      <div class={styles.run}>
        <ol class={styles.steps} aria-label={cr("stepsLabel")}>
          {steps.map((step) => (
            <li key={step.id} class={styles.step} data-status={step.status}>
              <span class={styles.stepDot} aria-hidden="true">
                {step.status === "done" ? (
                  <Icon name="check" size={13} />
                ) : step.status === "failed" ? (
                  <Icon name="x" size={13} />
                ) : null}
              </span>
              <span class={styles.stepText}>
                <span class={styles.stepName}>{cr(`step_${step.id}` as CrKey)}</span>
                <span class={styles.stepNote}>
                  {cr(STATUS_KEYS[step.status])}
                  {step.note ? ` · ${step.note}` : ""}
                </span>
              </span>
            </li>
          ))}
        </ol>
        <div>
          <Feed />
          {waiting.length ? (
            <div class={styles.approvalBox}>
              <p>
                <strong>{cr("approvalTitle")}.</strong> {cr("approvalExplain")}
              </p>
              <ApprovalPanel approvals={waiting} />
            </div>
          ) : questions[0] ? (
            <div class={styles.approvalBox}>
              <InteractionPanel interaction={questions[0]} />
            </div>
          ) : null}
          {failed ? (
            <p class={styles.callout} data-tone="danger" role="alert">
              <Icon name="alert" size={16} />
              <span>
                {cr("runFailed")}{" "}
                {sid && !readOnly.value ? (
                  <button
                    type="button"
                    class={styles.linkButton}
                    onClick={() =>
                      void prompt(sid, cr("tryAgainPrompt")).catch((error) =>
                        toastText(failureMessage(creatorFailure(error))),
                      )
                    }
                  >
                    {cr("tryAgain")}
                  </button>
                ) : null}
              </span>
            </p>
          ) : null}
          {sid && !waiting.length && !questions.length ? (
            <Reply sessionId={sid} disabled={readOnly.value} />
          ) : null}
          {active ? (
            <div class={styles.actions}>
              <button type="button" class={styles.ghost} onClick={() => void cancelRun()}>
                <Icon name="stop" size={14} />
                {cr("stop")}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
