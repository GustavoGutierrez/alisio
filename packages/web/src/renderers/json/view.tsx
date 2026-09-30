import type { UiBlock } from "@alisio/sdk";
import { useState } from "preact/hooks";
import { CopyButton } from "../../components/CopyButton.tsx";
import { t } from "../../i18n/index.ts";
import CodeView from "../code/view.tsx";
import styles from "./json.module.css";
import { childEntries, isContainer, type JsonKey, jsonPath, jsonPreview } from "./model.ts";

type JsonBlock = Extract<UiBlock, { kind: "json" }>;

const scalarClass = (value: unknown) =>
  typeof value === "string"
    ? styles.string
    : typeof value === "number"
      ? styles.number
      : typeof value === "boolean"
        ? styles.boolean
        : styles.null;

function Node(props: { name?: JsonKey; value: unknown; path: JsonKey[]; open: number }) {
  const { value, path } = props;
  const container = isContainer(value);
  const [expanded, setExpanded] = useState(props.open > 0);
  const label =
    props.name === undefined ? null : (
      <span class={styles.key}>
        {typeof props.name === "number" ? props.name : JSON.stringify(props.name)}:
      </span>
    );
  const tools = (
    <span class={styles.tools}>
      <CopyButton
        text={() => JSON.stringify(value, null, 2) ?? "undefined"}
        class={styles.tool}
        label={t("json.copyValue")}
        showText
      />
      <CopyButton
        text={() => jsonPath(path)}
        class={styles.tool}
        label={t("json.copyPath")}
        showText
      />
    </span>
  );
  if (!container)
    return (
      <li class={styles.row}>
        {label} <span class={scalarClass(value)}>{JSON.stringify(value) ?? "undefined"}</span>
        {tools}
      </li>
    );
  const { entries, more } = expanded ? childEntries(value) : { entries: [], more: 0 };
  return (
    <li class={styles.row}>
      <button
        type="button"
        class={styles.toggle}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "▾" : "▸"}
      </button>
      {label} <span class={styles.preview}>{jsonPreview(value)}</span>
      {tools}
      {expanded ? (
        <ul class={styles.children}>
          {entries.map(([key, child]) => (
            <Node
              key={String(key)}
              name={key}
              value={child}
              path={[...path, key]}
              open={props.open - 1}
            />
          ))}
          {more ? <li class={styles.more}>{t("json.more", { count: more })}</li> : null}
        </ul>
      ) : null}
    </li>
  );
}

/** A collapsible JSON tree (depth from `collapsedDepth`, default 2), or its source as code. */
export default function JsonView({ block }: { block: JsonBlock }) {
  const [source, setSource] = useState(false);
  return (
    <figure class={styles.block}>
      <figcaption class={styles.header}>
        <span>{block.caption ?? "JSON"}</span>
        <button
          type="button"
          class={styles.tool}
          aria-pressed={source}
          onClick={() => setSource(!source)}
        >
          {source ? t("json.tree") : t("json.source")}
        </button>
      </figcaption>
      {source ? (
        <CodeView
          block={{ kind: "code", lang: "json", code: JSON.stringify(block.value, null, 2) ?? "" }}
        />
      ) : (
        <ul class={styles.tree}>
          <Node value={block.value} path={[]} open={block.collapsedDepth ?? 2} />
        </ul>
      )}
    </figure>
  );
}
