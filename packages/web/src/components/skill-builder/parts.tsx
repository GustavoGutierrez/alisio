/** Small building blocks of the Skill Builder: segmented radio group, spinner, issue lists. */
import type { SkillIssue } from "@alisio/sdk";
import styles from "./skill-builder.module.css";
import { issueText } from "./strings.ts";

export function Spinner() {
  return <span class={styles.spinner} aria-hidden="true" />;
}

/** A native radio group drawn as a segmented control (arrow keys and labels come for free). */
export function Segment<T extends string>(props: {
  name: string;
  label: string;
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={props.label} class={styles.segment}>
      {props.options.map((option) => (
        <label key={option.value} class={styles.segmentOption}>
          <input
            type="radio"
            name={props.name}
            value={option.value}
            checked={props.value === option.value}
            disabled={option.disabled}
            onChange={() => props.onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

/** The findings of one field, shown under it (errors in red, suggestions in amber). */
export function FieldIssues(props: {
  issues: SkillIssue[] | undefined;
  errors: SkillIssue[];
  id?: string;
}) {
  if (!props.issues?.length) return null;
  return (
    <div id={props.id}>
      {props.issues.map((issue) => (
        <p
          key={`${issue.code}:${issue.path ?? ""}`}
          class={styles.fieldIssue}
          data-tone={props.errors.includes(issue) ? undefined : "warn"}
        >
          {issueText(issue)}
        </p>
      ))}
    </div>
  );
}

export function IssueList(props: { issues: SkillIssue[]; tone?: "warn" }) {
  return (
    <ul class={styles.issueList}>
      {props.issues.map((issue) => (
        <li key={`${issue.code}:${issue.path ?? ""}`} class={styles.issue} data-tone={props.tone}>
          <span>{issueText(issue)}</span>
        </li>
      ))}
    </ul>
  );
}

export const formatSize = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
