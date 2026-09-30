/**
 * TeX formulas with KaTeX (spec §10.4). This module, KaTeX and its CSS/fonts form one lazy
 * chunk loaded with the first formula. The HTML is sanitized before insertion; a parse error
 * shows the source and the message (RNF-10).
 */
import type { UiBlock } from "@alisio/sdk";
import DOMPurify from "dompurify";
import "katex/dist/katex.min.css";
import { useMemo } from "preact/hooks";
import { CopyButton } from "../../components/CopyButton.tsx";
import { t } from "../../i18n/index.ts";
import { katex } from "./katex.ts";
import styles from "./math.module.css";
import { renderMath } from "./render.ts";

export default function MathView({ block }: { block: UiBlock }) {
  const latex = block.kind === "math" ? block.latex : "";
  const display = block.kind === "math" ? block.display !== false : true;
  const result = useMemo(() => {
    const out = renderMath(katex, latex, display);
    return "html" in out ? { html: DOMPurify.sanitize(out.html) } : out;
  }, [latex, display]);
  if ("error" in result) {
    if (!display)
      return (
        <code class={styles.inlineError} title={t("math.error", { message: result.error })}>
          {`\\(${latex}\\)`}
        </code>
      );
    return (
      <div class={styles.error} role="note">
        <p class={styles.message}>{t("math.error", { message: result.error })}</p>
        <pre class={styles.source}>{latex}</pre>
      </div>
    );
  }
  if (!display)
    // Safe: KaTeX output (trust:false) sanitized by DOMPurify.
    return <span class={styles.inline} dangerouslySetInnerHTML={{ __html: result.html }} />;
  return (
    <div class={styles.display}>
      {/* Safe: KaTeX output (trust:false) sanitized by DOMPurify. */}
      <div class={styles.formula} dangerouslySetInnerHTML={{ __html: result.html }} />
      <CopyButton text={() => latex} label={t("math.copy")} class={`icon-btn ${styles.copy}`} />
    </div>
  );
}
