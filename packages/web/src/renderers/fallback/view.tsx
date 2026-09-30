import type { UiBlock } from "@alisio/sdk";
import { t } from "../../i18n/index.ts";
import styles from "../blocks.module.css";

/** Text projection of any block: the readable part first, the raw JSON folded. */
export function blockText(block: UiBlock): string {
  const b = block as Record<string, unknown>;
  for (const key of ["code", "text", "output", "patch", "source", "latex"])
    if (typeof b[key] === "string") return b[key] as string;
  return "";
}

/**
 * Unknown kinds (e.g. persisted by a newer Alisio), loading views and failed renderers:
 * a notice, the text projection and the folded JSON of the block (RF-13).
 */
export default function FallbackView(props: { block: UiBlock; error?: string; loading?: boolean }) {
  const text = blockText(props.block);
  if (props.loading) return <pre class={styles.plain}>{text}</pre>;
  return (
    <div class={styles.fallback}>
      <p class={styles.note}>
        {props.error ?? t("block.unsupported", { kind: String(props.block.kind) })}
      </p>
      {text ? <pre class={styles.plain}>{text}</pre> : null}
      <details>
        <summary>{t("block.showJson")}</summary>
        <pre class={styles.plain}>{JSON.stringify(props.block, null, 2)}</pre>
      </details>
    </div>
  );
}
