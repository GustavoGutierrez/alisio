/** The project's files: a folder tree and a read-only viewer (binary and truncated files explained). */
import type { PluginCreatorFile, PluginCreatorFileList } from "@alisio/sdk";
import { useEffect, useState } from "preact/hooks";
import { formatSize } from "../../util/artifacts.ts";
import { Icon } from "../icons.tsx";
import styles from "./creator.module.css";
import { fileTree } from "./model.ts";
import { listFiles, readFile } from "./store.ts";
import { cr } from "./strings.ts";

export function FilesView({ id, version }: { id: string; version: string }) {
  const [list, setList] = useState<{ data?: PluginCreatorFileList; error?: string }>({});
  const [path, setPath] = useState<string | undefined>();
  const [file, setFile] = useState<{ data?: PluginCreatorFile; error?: string; loading?: boolean }>(
    {},
  );

  useEffect(() => {
    let alive = true;
    void listFiles(id)
      .then((data) => alive && setList({ data }))
      .catch((error) => alive && setList({ error: error instanceof Error ? error.message : "" }));
    return () => {
      alive = false;
    };
  }, [id, version]);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    setFile({ loading: true });
    void readFile(id, path)
      .then((data) => alive && setFile({ data }))
      .catch((error) => alive && setFile({ error: error instanceof Error ? error.message : "" }));
    return () => {
      alive = false;
    };
  }, [id, path, version]);

  if (list.error)
    return (
      <p class={styles.callout} data-tone="danger" role="alert">
        <Icon name="alert" size={16} />
        <span>{cr("filesFailed", { message: list.error })}</span>
      </p>
    );
  if (!list.data)
    return (
      <p class={styles.muted} role="status">
        {cr("filesLoading")}
      </p>
    );
  const rows = fileTree(list.data.files);
  return (
    <div>
      <p class={`${styles.muted} ${styles.small}`}>
        {cr("filesSummary", { count: list.data.count, size: formatSize(list.data.bytes) })}
      </p>
      <div class={styles.files}>
        <ul class={styles.tree} aria-label={cr("filesLabel")}>
          {rows.map((row) => (
            <li key={`${row.kind}:${row.path}`}>
              {row.kind === "dir" ? (
                <div
                  class={styles.fileRow}
                  data-kind="dir"
                  style={{ paddingInlineStart: `${8 + row.depth * 14}px` }}
                >
                  <Icon name="folder" size={14} />
                  <span class={styles.fileName}>{row.name}</span>
                </div>
              ) : (
                <button
                  type="button"
                  class={styles.fileRow}
                  aria-current={row.path === path ? "true" : undefined}
                  style={{ paddingInlineStart: `${8 + row.depth * 14}px` }}
                  onClick={() => setPath(row.path)}
                >
                  <Icon
                    name={/\.(svg|png|jpe?g|webp)$/i.test(row.name) ? "fileImage" : "fileCode"}
                    size={14}
                  />
                  <span class={styles.fileName}>{row.name}</span>
                  <span class={styles.fileSize}>{formatSize(row.bytes)}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
        <section
          class={styles.viewer}
          aria-label={path ?? cr("filesPick")}
          aria-busy={file.loading}
        >
          {path ? (
            <div class={styles.viewerHead}>
              <Icon name="file" size={14} />
              <code>{path}</code>
              <span class={styles.badge}>{cr("readOnlyView")}</span>
            </div>
          ) : null}
          {!path ? (
            <div class={styles.viewerEmpty}>{cr("filesPick")}</div>
          ) : file.loading ? (
            <div class={styles.viewerEmpty} role="status">
              {cr("fileLoading")}
            </div>
          ) : file.error ? (
            <div class={styles.viewerEmpty} role="alert">
              {file.error}
            </div>
          ) : file.data?.binary ? (
            <div class={styles.viewerEmpty}>
              {cr("fileBinary", { size: formatSize(file.data.bytes) })}
            </div>
          ) : (
            <>
              {file.data?.truncated ? (
                <p class={styles.callout} data-tone="warn">
                  <Icon name="info" size={16} />
                  <span>{cr("fileTruncated")}</span>
                </p>
              ) : null}
              <pre class={styles.code} tabIndex={0}>
                {file.data?.text ?? ""}
              </pre>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
