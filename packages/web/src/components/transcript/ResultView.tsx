import type { ToolResult } from "@alisio/sdk";
import { t } from "../../i18n/index.ts";
import { RendererHost } from "../../renderers/RendererHost.tsx";
import styles from "./transcript.module.css";

function Part({ part }: { part: ToolResult["content"][number] }) {
  if (part.type === "text") return <pre class={styles.output}>{part.text}</pre>;
  if (part.type === "ui") return <RendererHost block={part.block} />;
  return <img class={styles.image} src={`data:${part.mimeType};base64,${part.data}`} alt="" />;
}

/**
 * A tool result: rich parts (ui blocks, images) first; when there are any, the text parts (what
 * the model saw) fold under "Raw output".
 */
export function ResultView({ result }: { result: ToolResult }) {
  const rich = result.content.filter((part) => part.type !== "text");
  const text = result.content.filter((part) => part.type === "text");
  if (!rich.length)
    return (
      <>
        {text.map((part, i) => (
          <Part key={i} part={part} />
        ))}
      </>
    );
  return (
    <>
      {rich.map((part, i) => (
        <Part key={i} part={part} />
      ))}
      {text.length ? (
        <details class={styles.raw}>
          <summary>{t("tool.rawOutput")}</summary>
          {text.map((part, i) => (
            <Part key={i} part={part} />
          ))}
        </details>
      ) : null}
    </>
  );
}
