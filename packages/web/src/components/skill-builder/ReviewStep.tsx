/** Step 3: edit the draft, see live validation, ask for changes and save. */
import type { SkillDraft, SkillWriteScope } from "@alisio/sdk";
import { useMemo, useState } from "preact/hooks";
import { Markdown } from "../../markdown/view.tsx";
import { Icon } from "../icons.tsx";
import { ScopePicker } from "./DescribeStep.tsx";
import {
  type DraftField,
  FEEDBACK_MAX,
  fileTree,
  LIMITS,
  removeFile,
  reviewDraft,
  type SaveFailure,
  setDraftField,
  setFileContent,
} from "./model.ts";
import { FieldIssues, formatSize, IssueList, Spinner } from "./parts.tsx";
import styles from "./skill-builder.module.css";
import { sb } from "./strings.ts";

export interface SaveProblem {
  kind: SaveFailure;
  message: string;
}

export function ReviewStep(props: {
  draft: SkillDraft;
  onChange: (draft: SkillDraft) => void;
  existingNames: string[];
  scope: SkillWriteScope;
  onScope: (scope: SkillWriteScope) => void;
  hasProject: boolean;
  model: string | undefined;
  /** An error from the last regeneration. */
  error: string | undefined;
  canRestore: boolean;
  onRestore: () => void;
  onRegenerate: (feedback: string) => void;
  onBack: () => void;
  saving: boolean;
  problem: SaveProblem | undefined;
  onSave: () => void;
  onOverwrite: () => void;
  onTrust: () => void;
  onSaveGlobally: () => void;
  onDismissProblem: () => void;
}) {
  const { draft } = props;
  const review = useMemo(
    () => reviewDraft(draft, props.existingNames),
    [draft, props.existingNames],
  );
  const [preview, setPreview] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [advanced, setAdvanced] = useState(false);
  const [feedback, setFeedback] = useState("");
  const tree = fileTree(draft);
  const field = (name: DraftField) => (event: { currentTarget: { value: string } }) =>
    props.onChange(setDraftField(draft, name, event.currentTarget.value));
  const folder = props.scope === "project" ? ".agents/skills" : "~/.agents/skills";
  const bodyLines = draft.body.split("\n").length;
  const summary = review.canSave
    ? sb("summaryOk", { warnings: review.warnings.length })
    : sb("summaryErrors", { errors: review.errors.length, warnings: review.warnings.length });
  const problem = props.problem;
  return (
    <div class={styles.page}>
      <header>
        <h2 class={styles.title} id="sb-step-title" tabIndex={-1}>
          {sb("reviewTitle")}
        </h2>
        <p class={styles.lead}>
          {props.model || draft.generatedBy
            ? sb("draftBy", { model: draft.generatedBy ?? props.model ?? "" })
            : null}
        </p>
      </header>
      <div class={styles.reviewGrid}>
        <div class={styles.main}>
          <div class={styles.field}>
            <label class={styles.label} for="sb-name">
              {sb("nameLabel")}
            </label>
            <input
              id="sb-name"
              class={`${styles.input} ${styles.mono}`}
              value={draft.name}
              maxLength={80}
              spellcheck={false}
              autocomplete="off"
              aria-invalid={
                review.byField.name?.some((i) => review.errors.includes(i)) || undefined
              }
              aria-describedby="sb-name-issues"
              onInput={field("name")}
            />
            <span class={styles.hint}>{sb("nameHint")}</span>
            <FieldIssues id="sb-name-issues" issues={review.byField.name} errors={review.errors} />
            <span class={styles.hint}>
              {sb("savesAs", { path: `${folder}/${draft.name || "…"}/` })}
            </span>
          </div>
          <div class={styles.field}>
            <label class={styles.label} for="sb-description">
              {sb("descriptionLabel")}
            </label>
            <textarea
              id="sb-description"
              class={styles.textarea}
              rows={3}
              value={draft.description}
              aria-invalid={
                review.byField.description?.some((i) => review.errors.includes(i)) || undefined
              }
              aria-describedby="sb-description-hint sb-description-issues"
              onInput={field("description")}
            />
            <span
              class={`${styles.count}${draft.description.length > LIMITS.description ? ` ${styles.countOver}` : ""}`}
            >
              {sb("descriptionCount", { count: draft.description.length, max: LIMITS.description })}
            </span>
            <span class={styles.hint} id="sb-description-hint">
              {sb("descriptionHint")}
            </span>
            <FieldIssues
              id="sb-description-issues"
              issues={review.byField.description}
              errors={review.errors}
            />
          </div>
          <div class={styles.field}>
            <div class={styles.panelTitle}>
              <label class={styles.label} for="sb-body">
                {sb("bodyLabel")}
              </label>
              <span class={styles.tabs} role="tablist" aria-label={sb("bodyLabel")}>
                <button
                  type="button"
                  role="tab"
                  class={styles.tab}
                  aria-selected={!preview}
                  onClick={() => setPreview(false)}
                >
                  {sb("bodyEdit")}
                </button>
                <button
                  type="button"
                  role="tab"
                  class={styles.tab}
                  aria-selected={preview}
                  onClick={() => setPreview(true)}
                >
                  {sb("bodyPreview")}
                </button>
              </span>
            </div>
            {preview ? (
              <div class={styles.preview}>
                <Markdown text={draft.body} />
              </div>
            ) : (
              <textarea
                id="sb-body"
                class={`${styles.textarea} ${styles.mono} ${styles.bodyEditor}`}
                rows={14}
                spellcheck={false}
                value={draft.body}
                aria-invalid={
                  review.byField.body?.some((i) => review.errors.includes(i)) || undefined
                }
                aria-describedby="sb-body-issues"
                onInput={field("body")}
              />
            )}
            <span class={styles.count}>{sb("bodyLines", { count: bodyLines })}</span>
            <FieldIssues id="sb-body-issues" issues={review.byField.body} errors={review.errors} />
          </div>
          <div>
            <button
              type="button"
              class={styles.disclosure}
              aria-expanded={advanced}
              aria-controls="sb-advanced"
              onClick={() => setAdvanced(!advanced)}
            >
              <Icon name={advanced ? "chevronDown" : "chevronRight"} size={14} />
              {sb("advanced")}
            </button>
          </div>
          {advanced ? (
            <div class={styles.options} id="sb-advanced">
              <div class={styles.field}>
                <label class={styles.label} for="sb-license">
                  {sb("licenseLabel")}
                </label>
                <input
                  id="sb-license"
                  class={styles.input}
                  value={draft.license ?? ""}
                  maxLength={LIMITS.license}
                  onInput={field("license")}
                />
                <FieldIssues issues={review.byField.license} errors={review.errors} />
              </div>
              <div class={styles.field}>
                <label class={styles.label} for="sb-compat">
                  {sb("compatibilityLabel")}
                </label>
                <span class={styles.hint}>{sb("compatibilityHint")}</span>
                <input
                  id="sb-compat"
                  class={styles.input}
                  value={draft.compatibility ?? ""}
                  onInput={field("compatibility")}
                />
                <FieldIssues issues={review.byField.compatibility} errors={review.errors} />
              </div>
            </div>
          ) : null}
          <section class={styles.field} aria-labelledby="sb-files-title">
            <h3 class={styles.label} id="sb-files-title">
              {sb("filesTitle")}
            </h3>
            {tree.length ? (
              tree.map((group) => (
                <div key={group.folder} class={styles.fileGroup}>
                  <p class={styles.fileGroupTitle}>{group.folder}/</p>
                  {group.files.map((file) => {
                    const source = draft.files.find((f) => f.path === file.path);
                    const expanded = open[file.path] === true;
                    const issues = review.byField.file?.filter((i) => i.path === file.path);
                    return (
                      <div key={file.path} class={styles.fileRow}>
                        <div class={styles.fileHead}>
                          <Icon name="fileCode" size={15} />
                          <span class={styles.fileName}>{file.name}</span>
                          <span class={styles.fileMeta}>
                            {sb("fileLines", { lines: file.lines, size: formatSize(file.bytes) })}
                          </span>
                          <span class={styles.fileActions}>
                            <button
                              type="button"
                              class={styles.linkBtn}
                              aria-expanded={expanded}
                              aria-label={sb("fileEditNamed", { name: file.path })}
                              onClick={() => setOpen({ ...open, [file.path]: !expanded })}
                            >
                              {expanded ? sb("fileHide") : sb("fileEdit")}
                            </button>
                            <button
                              type="button"
                              class={`${styles.linkBtn} ${styles.linkBtnDanger}`}
                              aria-label={sb("fileRemoveNamed", { name: file.path })}
                              onClick={() => props.onChange(removeFile(draft, file.path))}
                            >
                              {sb("fileRemove")}
                            </button>
                          </span>
                        </div>
                        {file.purpose ? <span class={styles.hint}>{file.purpose}</span> : null}
                        {expanded ? (
                          <textarea
                            class={`${styles.textarea} ${styles.mono}`}
                            rows={10}
                            spellcheck={false}
                            aria-label={sb("fileContentLabel", { name: file.path })}
                            value={source?.content ?? ""}
                            onInput={(event) =>
                              props.onChange(
                                setFileContent(draft, file.path, event.currentTarget.value),
                              )
                            }
                          />
                        ) : null}
                        <FieldIssues issues={issues} errors={review.errors} />
                      </div>
                    );
                  })}
                </div>
              ))
            ) : (
              <p class={styles.hint}>{sb("filesNone")}</p>
            )}
            <FieldIssues issues={review.byField.files} errors={review.errors} />
            <p class={styles.hint}>{sb("filesNote")}</p>
          </section>
        </div>
        <aside class={styles.side} aria-label={sb("validationTitle")}>
          <section class={styles.panel}>
            <h3 class={styles.panelTitle}>{sb("validationTitle")}</h3>
            <p class={styles.hint} role="status" aria-live="polite">
              {summary}
            </p>
            {review.errors.length ? (
              <>
                <h4 class={styles.label}>{sb("errorsTitle")}</h4>
                <p class={styles.hint}>{sb("errorsLead")}</p>
                <IssueList issues={review.errors} />
              </>
            ) : null}
            {review.warnings.length ? (
              <>
                <h4 class={styles.label}>{sb("suggestionsTitle")}</h4>
                <p class={styles.hint}>{sb("suggestionsLead")}</p>
                <IssueList issues={review.warnings} tone="warn" />
              </>
            ) : null}
            {!review.errors.length && !review.warnings.length ? (
              <p class={styles.ok}>{sb("allGood")}</p>
            ) : null}
          </section>
          <section class={styles.panel}>
            <ScopePicker
              name="sb-scope-review"
              scope={props.scope}
              hasProject={props.hasProject}
              onChange={props.onScope}
            />
          </section>
          <form
            class={styles.panel}
            onSubmit={(event) => {
              event.preventDefault();
              props.onRegenerate(feedback);
            }}
          >
            <h3 class={styles.panelTitle}>{sb("regenerateTitle")}</h3>
            <label class={styles.hint} for="sb-feedback">
              {sb("feedbackLabel")}
            </label>
            <textarea
              id="sb-feedback"
              class={styles.textarea}
              rows={2}
              maxLength={FEEDBACK_MAX}
              value={feedback}
              placeholder={sb("feedbackPlaceholder")}
              onInput={(event) => setFeedback(event.currentTarget.value)}
            />
            <span class={styles.hint}>{sb("regenerateNote")}</span>
            {props.error ? (
              <p class={styles.fieldIssue} role="alert">
                {sb("generateFailed", { message: props.error })}
              </p>
            ) : null}
            <div class={styles.actionBar}>
              {props.canRestore ? (
                <button type="button" class={styles.linkBtn} onClick={props.onRestore}>
                  {sb("restorePrevious")}
                </button>
              ) : null}
              <button
                type="submit"
                class={styles.secondaryBtn}
                disabled={!props.model || props.saving}
              >
                <Icon name="refresh" size={15} />
                {sb("regenerate")}
              </button>
            </div>
          </form>
        </aside>
      </div>
      {problem ? (
        <div class={styles.notice} data-tone="danger" role="alert">
          <p>
            {problem.kind === "exists"
              ? `${sb("overwriteTitle")} ${sb("overwriteBody", { name: draft.name })}`
              : problem.kind === "untrusted"
                ? sb("untrustedSave")
                : problem.kind === "readonly"
                  ? sb("readOnly")
                  : sb("saveFailed", { message: problem.message })}
          </p>
          {problem.kind === "exists" ? (
            <>
              <button
                type="button"
                class={styles.dangerBtn}
                disabled={props.saving}
                onClick={props.onOverwrite}
              >
                {props.saving ? <Spinner /> : null}
                {sb("overwriteConfirm")}
              </button>
              <button type="button" class={styles.secondaryBtn} onClick={props.onDismissProblem}>
                {sb("keepEditing")}
              </button>
            </>
          ) : null}
          {problem.kind === "untrusted" ? (
            <>
              <button type="button" class={styles.secondaryBtn} onClick={props.onSaveGlobally}>
                {sb("saveGlobally")}
              </button>
              <button type="button" class={styles.secondaryBtn} onClick={props.onTrust}>
                {sb("trustProject")}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      <div class={`${styles.actionBar} ${styles.stickyFoot}`}>
        <button
          type="button"
          class={styles.secondaryBtn}
          onClick={props.onBack}
          disabled={props.saving}
        >
          {sb("back")}
        </button>
        <span class={styles.actionSpacer} />
        <button
          type="button"
          class={styles.primaryBtn}
          disabled={!review.canSave || props.saving}
          aria-busy={props.saving || undefined}
          onClick={props.onSave}
        >
          {props.saving ? <Spinner /> : <Icon name="check" size={16} />}
          {props.saving ? sb("saving") : sb("save")}
        </button>
      </div>
    </div>
  );
}
