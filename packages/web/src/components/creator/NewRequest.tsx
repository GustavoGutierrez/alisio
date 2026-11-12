/** "Create a new plugin": the 3-step explainer, the request box with tips, the model and the button. */
import type { AgentModelOption } from "@alisio/sdk";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../icons.tsx";
import styles from "./creator.module.css";
import { creatorFailure, failureMessage } from "./failures.ts";
import { REQUEST_MAX, requestProblem } from "./model.ts";
import { createProject, loadModels, readOnly, requestDraft, requestFocus } from "./store.ts";
import { cr } from "./strings.ts";

export function HowItWorks() {
  return (
    <>
      <h3 class={styles.sectionTitle}>{cr("howTitle")}</h3>
      <ol class={styles.how}>
        <li>
          <span>
            <strong>{cr("how1Title")}</strong>
            {cr("how1Body")}
          </span>
        </li>
        <li>
          <span>
            <strong>{cr("how2Title")}</strong>
            {cr("how2Body")}
          </span>
        </li>
        <li>
          <span>
            <strong>{cr("how3Title")}</strong>
            {cr("how3Body")}
          </span>
        </li>
      </ol>
    </>
  );
}

/** Model picker over the configured models; "" means the default model. */
export function ModelSelect(props: {
  id: string;
  workspace: string | undefined;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [models, setModels] = useState<AgentModelOption[] | undefined>();
  useEffect(() => {
    if (!props.workspace) {
      setModels([]);
      return;
    }
    let alive = true;
    void loadModels(props.workspace)
      .then((list) => alive && setModels(list))
      .catch(() => alive && setModels([]));
    return () => {
      alive = false;
    };
  }, [props.workspace]);
  return (
    <div class={styles.field}>
      <label class={styles.label} for={props.id}>
        {cr("modelLabel")}
      </label>
      <select
        id={props.id}
        class={styles.select}
        value={props.value}
        disabled={props.disabled || !models}
        aria-describedby={`${props.id}-hint`}
        onChange={(event) => props.onChange((event.target as HTMLSelectElement).value)}
      >
        <option value="">{models ? cr("modelDefault") : cr("modelsLoading")}</option>
        {(models ?? []).map((model) => (
          <option key={model.reference} value={model.reference}>
            {model.name ?? model.id} · {model.providerName}
          </option>
        ))}
      </select>
      <span id={`${props.id}-hint`} class={`${styles.muted} ${styles.small}`}>
        {cr("modelHint")}
      </span>
    </div>
  );
}

export function NewRequest(props: { workspace: string | undefined }) {
  const text = requestDraft.value;
  const [model, setModel] = useState("");
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const focus = requestFocus.value;
  useEffect(() => {
    if (focus) box.current?.focus();
  }, [focus]);
  const locked = readOnly.value;

  const submit = async (event: Event) => {
    event.preventDefault();
    const check = requestProblem(text);
    if (check) {
      setProblem(
        check === "empty" ? cr("requestEmpty") : cr("requestTooLong", { max: REQUEST_MAX }),
      );
      box.current?.focus();
      return;
    }
    setProblem(undefined);
    setBusy(true);
    try {
      await createProject(text.trim(), model || undefined);
      requestDraft.value = "";
    } catch (error) {
      const failure = creatorFailure(error);
      if (failure.kind === "readOnly") readOnly.value = true;
      setProblem(failure.kind === "model" ? cr("modelMissing") : failureMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class={styles.card}>
      <h2 class={styles.cardTitle}>
        <Icon name="sparkle" size={18} />
        {cr("newTitle")}
      </h2>
      <HowItWorks />
      <form onSubmit={submit} noValidate>
        <div class={styles.field}>
          <label class={styles.label} for="creator-request">
            {cr("requestLabel")}
          </label>
          <textarea
            ref={box}
            id="creator-request"
            class={styles.textarea}
            placeholder={cr("requestPlaceholder")}
            value={text}
            disabled={locked || busy}
            aria-invalid={problem ? "true" : undefined}
            aria-describedby={problem ? "creator-request-error" : undefined}
            onInput={(event) => {
              requestDraft.value = (event.target as HTMLTextAreaElement).value;
              if (problem) setProblem(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void submit(event);
            }}
          />
          <span class={styles.counter} aria-hidden="true">
            {text.trim().length} / {REQUEST_MAX}
          </span>
          {problem ? (
            <p id="creator-request-error" class={styles.error} role="alert">
              {problem}
            </p>
          ) : null}
        </div>
        <details class={styles.tips}>
          <summary>{cr("tipsTitle")}</summary>
          <ul>
            <li>{cr("tip1")}</li>
            <li>{cr("tip2")}</li>
            <li>{cr("tip3")}</li>
          </ul>
        </details>
        <div class={styles.row}>
          <ModelSelect
            id="creator-model"
            workspace={props.workspace}
            value={model}
            onChange={setModel}
            disabled={locked || busy}
          />
          <button type="submit" class={styles.primary} disabled={locked || busy}>
            {busy ? (
              <span class={styles.spinner} aria-hidden="true" />
            ) : (
              <Icon name="wand" size={16} />
            )}
            {busy ? cr("creating") : cr("create")}
          </button>
        </div>
      </form>
    </div>
  );
}
