/** Mermaid and math until their renderers land (phase 5): the source as a code block. */
import type { UiBlock } from "@alisio/sdk";
import CodeView from "../code/view.tsx";

export default function SourceView({ block }: { block: UiBlock }) {
  if (block.kind === "mermaid")
    return (
      <CodeView
        block={{
          kind: "code",
          lang: "mermaid",
          code: block.source,
          ...(block.title ? { caption: block.title } : {}),
        }}
      />
    );
  if (block.kind === "math")
    return <CodeView block={{ kind: "code", lang: "latex", code: block.latex }} />;
  return null;
}
