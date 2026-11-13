/**
 * Sign-in of a remote MCP service (OAuth, specs/030 phase 4, UX-05): one step at a time (start, go to
 * the browser through a real link, wait, done or a way to try again). The view is hook-free for the
 * web tests; `SignInPanel` is the thin stateful shell that polls the flow. Lazy chunk.
 */
import type { McpSignInFlow } from "@alisio/sdk";
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../../store/app.ts";
import css from "../mcp-install/install.module.css";
import styles from "../settings.module.css";
import { type SignInViewModel, signInViewOf } from "./model.ts";
import { mgs } from "./strings.ts";

export interface SignInViewProps {
  view: SignInViewModel;
  name: string;
  onStart: () => void;
  onCancel: () => void;
  onClose: () => void;
}

/** One step at a time: start, go to the browser (a real link), wait, done or a way to try again. */
export function SignInView(props: SignInViewProps) {
  const { view } = props;
  return (
    <div class={css.panel} role="group" aria-label={mgs("signin.title", { name: props.name })}>
      <h4 class={css.title} tabIndex={-1}>
        {mgs("signin.title", { name: props.name })}
      </h4>
      {view.state === "idle" ? (
        <>
          <p class={css.lead}>{mgs("signin.lead")}</p>
          <p class={css.hint}>{mgs("signin.remoteBrowser")}</p>
        </>
      ) : null}
      <div
        class={css.result}
        data-tone={view.state === "failed" ? "danger" : view.state === "done" ? "ok" : "info"}
        role="status"
        aria-live="polite"
      >
        {view.state === "starting" ? <p class={css.headline}>{mgs("signin.starting")}</p> : null}
        {view.state === "awaiting" ? (
          <>
            <p class={css.headline}>{mgs("signin.waiting")}</p>
            {view.link ? (
              <p class={css.details}>
                <a href={view.link} target="_blank" rel="noopener noreferrer">
                  {mgs("signin.open")}
                </a>
              </p>
            ) : (
              <p class={css.details}>{mgs("signin.failed")}</p>
            )}
          </>
        ) : null}
        {view.state === "completing" ? (
          <p class={css.headline}>{mgs("signin.completing")}</p>
        ) : null}
        {view.state === "done" ? <p class={css.headline}>{mgs("signin.done")}</p> : null}
        {(view.state === "failed" || view.state === "cancelled") && view.messageKey ? (
          <p class={css.headline}>{mgs(view.messageKey)}</p>
        ) : null}
      </div>
      <div class={css.actions}>
        {view.state === "idle" ? (
          <button type="button" class={styles.primary} onClick={props.onStart}>
            {mgs("signin.start")}
          </button>
        ) : null}
        {view.state === "failed" || view.state === "cancelled" ? (
          <button type="button" class={styles.primary} onClick={props.onStart}>
            {mgs("signin.retry")}
          </button>
        ) : null}
        {view.state === "awaiting" || view.state === "completing" ? (
          <button type="button" class={styles.secondary} onClick={props.onCancel}>
            {mgs("signin.cancel")}
          </button>
        ) : null}
        {view.state !== "awaiting" && view.state !== "completing" ? (
          <button type="button" class={styles.secondary} onClick={props.onClose}>
            {mgs("signin.close")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export interface SignInPanelProps {
  workspaceId: string;
  bindingId: string;
  name: string;
  /** Start right away (the user already asked: "Connect my account"). */
  autoStart?: boolean;
  onClose: () => void;
  /** The flow finished (any way): refresh the list. */
  onFinished: () => void;
}

export function SignInPanel(props: SignInPanelProps) {
  const [flow, setFlow] = useState<McpSignInFlow | undefined>();
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const flowId = useRef<string | undefined>();
  const start = async () => {
    setStarting(true);
    setProblem(false);
    try {
      const started = await api.request<McpSignInFlow>(
        "POST",
        `/api/mcp/bindings/${props.bindingId}/auth`,
        {
          workspace: props.workspaceId,
        },
      );
      flowId.current = started.id;
      setFlow(started);
    } catch {
      setFlow({ id: "", state: "failed", error: { code: "oauth_failed", message: "" } });
      setProblem(true);
    } finally {
      setStarting(false);
    }
  };
  useEffect(() => {
    if (props.autoStart) void start();
    root.current?.querySelector<HTMLElement>("h4")?.focus();
  }, []);
  // While the browser is open, look at the flow every second until it ends.
  useEffect(() => {
    if (!flow || (flow.state !== "awaiting-browser" && flow.state !== "completing")) return;
    const timer = setInterval(() => {
      void api
        .request<McpSignInFlow>("GET", `/api/mcp/auth/flows/${flow.id}`)
        .then((next) => {
          setFlow(next);
          if (next.state === "completed" || next.state === "failed" || next.state === "cancelled")
            props.onFinished();
        })
        .catch(() => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, [flow?.id, flow?.state]);
  const cancel = () => {
    if (!flow) return;
    void api
      .request<McpSignInFlow>("POST", `/api/mcp/auth/flows/${flow.id}/cancel`, {})
      .then((next) => {
        setFlow(next);
        props.onFinished();
      })
      .catch(() => undefined);
  };
  return (
    <div ref={root}>
      <SignInView
        view={signInViewOf(flow, starting)}
        name={props.name}
        onStart={() => void start()}
        onCancel={cancel}
        onClose={props.onClose}
      />
      {problem ? null : null}
    </div>
  );
}
