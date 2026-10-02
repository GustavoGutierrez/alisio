import type { ArtifactRef } from "@alisio/sdk";
import { useEffect, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import styles from "./panel.module.css";
import { TextPreview } from "./TextPreview.tsx";

type Chunk = typeof import("../plan/PlanViewer.tsx");

/**
 * The plan viewer (`plan.md` + `plan.json` + `diagrams/*.mmd`), loaded on first use (its own
 * chunk). If the chunk cannot load, the plan still reads as plain Markdown.
 */
export function LazyPlanViewer(props: {
  artifact: ArtifactRef;
  entry: string;
  files: Array<{ path: string; bytes: number }>;
}) {
  const [chunk, setChunk] = useState<Chunk>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    import("../plan/PlanViewer.tsx").then(
      (loaded) => {
        if (alive) setChunk(loaded);
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  if (failed)
    return (
      <TextPreview
        key={props.artifact.id}
        artifact={props.artifact}
        entry={props.entry}
        as="markdown"
      />
    );
  if (!chunk)
    return (
      <div class={styles.state} aria-busy="true">
        {t("artifact.loading")}
      </div>
    );
  return (
    <chunk.default
      key={props.artifact.id}
      artifactId={props.artifact.id}
      title={props.artifact.title}
      files={props.files}
      entry={props.entry}
    />
  );
}
