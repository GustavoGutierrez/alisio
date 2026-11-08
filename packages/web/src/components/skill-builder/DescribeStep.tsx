/** Step 1: one required field, a compact "save to" choice and optional details. */
import { useState } from "preact/hooks";
import { Icon } from "../icons.tsx";
import { type DescribeForm, describeProblem, IDEA_MAX, type IncludeKey } from "./model.ts";
import { Segment } from "./parts.tsx";
import styles from "./skill-builder.module.css";
import { sb } from "./strings.ts";

const INCLUDE_ROWS: Array<
  [IncludeKey, "includeScripts" | "includeTemplates" | "includeReferences"]
> = [
  ["scripts", "includeScripts"],
  ["templates", "includeTemplates"],
  ["references", "includeReferences"],
];

export function ScopePicker(props: {
  name: string;
  scope: DescribeForm["scope"];
  hasProject: boolean;
  onChange: (scope: DescribeForm["scope"]) => void;
}) {
  return (
    <div class={styles.field}>
      <span class={styles.label} id={`${props.name}-label`}>
        {sb("saveTo")}
      </span>
      <Segment
        name={props.name}
        label={sb("saveTo")}
        value={props.scope}
        options={[
          { value: "project", label: sb("scopeProject"), disabled: !props.hasProject },
          { value: "global", label: sb("scopeGlobal") },
        ]}
        onChange={props.onChange}
      />
      <span class={styles.hint}>
        {props.scope === "project"
          ? props.hasProject
            ? sb("scopeProjectHint", { path: ".agents/skills/" })
            : sb("scopeNoProject")
          : sb("scopeGlobalHint", { path: "~/.agents/skills/" })}
      </span>
    </div>
  );
}

export function DescribeStep(props: {
  form: DescribeForm;
  onChange: (form: DescribeForm) => void;
  hasProject: boolean;
  trusted: boolean;
  /** The active model's name; undefined when none is configured. */
  model: string | undefined;
  modelsLoading: boolean;
  error: string | undefined;
  notice: string | undefined;
  onGenerate: () => void;
  onOpenModels: () => void;
}) {
  const { form } = props;
  const [more, setMore] = useState(false);
  const [touched, setTouched] = useState(false);
  const problem = describeProblem(form);
  const submit = () => {
    setTouched(true);
    if (!problem && props.model) props.onGenerate();
  };
  const set = (patch: Partial<DescribeForm>) => props.onChange({ ...form, ...patch });
  const untrustedProject = form.scope === "project" && props.hasProject && !props.trusted;
  return (
    <form
      class={styles.page}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <header>
        <h2 class={styles.title} id="sb-step-title" tabIndex={-1}>
          {sb("title")}
        </h2>
        <p class={styles.lead}>{sb("lead")}</p>
      </header>
      <div class={styles.field}>
        <label class={styles.label} for="sb-idea">
          {sb("ideaLabel")}
        </label>
        <textarea
          id="sb-idea"
          class={styles.textarea}
          rows={5}
          maxLength={IDEA_MAX}
          value={form.idea}
          placeholder={sb("ideaPlaceholder")}
          aria-invalid={touched && problem ? "true" : undefined}
          aria-describedby="sb-idea-issue"
          onInput={(event) => set({ idea: event.currentTarget.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div id="sb-idea-issue">
          {touched && problem ? (
            <p class={styles.fieldIssue}>
              {problem === "idea_required"
                ? sb("ideaRequired")
                : sb("ideaTooLong", { max: IDEA_MAX })}
            </p>
          ) : null}
        </div>
      </div>
      <ScopePicker
        name="sb-scope"
        scope={form.scope}
        hasProject={props.hasProject}
        onChange={(scope) => set({ scope })}
      />
      {untrustedProject ? (
        <div class={styles.notice} data-tone="warn" role="status">
          <p>{sb("untrustedNote")}</p>
          <button
            type="button"
            class={styles.secondaryBtn}
            onClick={() => set({ scope: "global" })}
          >
            {sb("saveGlobally")}
          </button>
        </div>
      ) : null}
      <div>
        <button
          type="button"
          class={styles.disclosure}
          aria-expanded={more}
          aria-controls="sb-more"
          onClick={() => setMore(!more)}
        >
          <Icon name={more ? "chevronDown" : "chevronRight"} size={14} />
          {sb("moreOptions")}
        </button>
      </div>
      {more ? (
        <div class={styles.options} id="sb-more">
          <div class={styles.field}>
            <label class={styles.label} for="sb-when">
              {sb("whenLabel")}
            </label>
            <span class={styles.hint}>{sb("whenHint")}</span>
            <textarea
              id="sb-when"
              class={styles.textarea}
              rows={2}
              maxLength={2000}
              value={form.when}
              placeholder={sb("whenPlaceholder")}
              onInput={(event) => set({ when: event.currentTarget.value })}
            />
          </div>
          <div class={styles.field}>
            <span class={styles.label}>{sb("includeLabel")}</span>
            <span class={styles.hint}>{sb("includeHint")}</span>
            <div class={styles.includeGrid}>
              {INCLUDE_ROWS.map(([key, label]) => (
                <div class={styles.includeRow} key={key}>
                  <span>{sb(label)}</span>
                  <Segment
                    name={`sb-include-${key}`}
                    label={sb(label)}
                    value={form.include[key] ?? "auto"}
                    options={[
                      { value: "auto", label: sb("includeAuto") },
                      { value: "yes", label: sb("includeYes") },
                      { value: "no", label: sb("includeNo") },
                    ]}
                    onChange={(value) => set({ include: { ...form.include, [key]: value } })}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      {props.notice ? (
        <p class={styles.hint} role="status">
          {props.notice}
        </p>
      ) : null}
      {props.error ? (
        <div class={styles.notice} data-tone="danger" role="alert">
          <p>{sb("generateFailed", { message: props.error })}</p>
          <button type="button" class={styles.secondaryBtn} onClick={submit}>
            {sb("tryAgain")}
          </button>
        </div>
      ) : null}
      {!props.model && !props.modelsLoading ? (
        <div class={styles.notice} data-tone="warn" role="status">
          <p>{sb("noModel")}</p>
          <button type="button" class={styles.secondaryBtn} onClick={props.onOpenModels}>
            {sb("openModels")}
          </button>
        </div>
      ) : null}
      <div class={styles.actionBar}>
        <button type="submit" class={styles.primaryBtn} disabled={!props.model}>
          <Icon name="sparkle" size={16} />
          {props.model ? sb("generateWith", { model: props.model }) : sb("generate")}
        </button>
      </div>
    </form>
  );
}
