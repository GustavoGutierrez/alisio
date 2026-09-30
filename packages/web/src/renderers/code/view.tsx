import type { UiBlock } from "@alisio/sdk";
import { useEffect, useRef, useState } from "preact/hooks";
import { CopyButton } from "../../components/CopyButton.tsx";
import { t } from "../../i18n/index.ts";
import { whenVisible } from "../visible.ts";
import styles from "./code.module.css";
import type { HighlightedToken } from "./highlight.ts";

type CodeBlock = Extract<UiBlock, { kind: "code" }>;

/**
 * A code block with a header (language, copy, wrap). Plain text renders at once; highlighting
 * loads when the block scrolls into view, and never while it is still streaming (`live`).
 */
export default function CodeView(props: { block: CodeBlock; live?: boolean }) {
  const { block } = props;
  const ref = useRef<HTMLPreElement>(null);
  const [lines, setLines] = useState<HighlightedToken[][] | undefined>();
  const [wrap, setWrap] = useState(false);
  useEffect(() => {
    setLines(undefined);
    if (props.live || !ref.current || block.code.length > 200_000) return;
    let cancelled = false;
    const stop = whenVisible(ref.current, () => {
      void import("./highlight.ts")
        .then(({ highlight }) => highlight(block.code, block.lang))
        .then((result) => {
          if (!cancelled) setLines(result);
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [block.code, block.lang, props.live]);
  return (
    <figure class={styles.block}>
      <figcaption class={styles.header}>
        <span class={styles.lang}>{block.caption ?? block.lang ?? "text"}</span>
        <span class={styles.actions}>
          <button
            type="button"
            class={styles.action}
            aria-pressed={wrap}
            onClick={() => setWrap(!wrap)}
          >
            {t("code.wrap")}
          </button>
          <CopyButton text={() => block.code} class={styles.action} showText />
        </span>
      </figcaption>
      <pre ref={ref} class={wrap ? `${styles.pre} ${styles.wrap}` : styles.pre} tabIndex={0}>
        <code>
          {lines
            ? lines.map((line, i) => (
                <span key={i} class={styles.line}>
                  {line.map((token, j) => (
                    <span
                      key={j}
                      class="shiki-token"
                      style={{
                        color: token.color,
                        "--shiki-dark": token.dark,
                        fontStyle: token.fontStyle && token.fontStyle & 1 ? "italic" : undefined,
                        fontWeight: token.fontStyle && token.fontStyle & 2 ? "600" : undefined,
                      }}
                    >
                      {token.content}
                    </span>
                  ))}
                  {"\n"}
                </span>
              ))
            : block.code}
        </code>
      </pre>
    </figure>
  );
}
