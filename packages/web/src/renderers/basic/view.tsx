import type { TreeNode, UiBlock } from "@alisio/sdk";
import type { ComponentType } from "preact";
import { Markdown } from "../../markdown/view.tsx";
import styles from "../blocks.module.css";

type Of<K extends UiBlock["kind"]> = { block: Extract<UiBlock, { kind: K }> };

function TableView({ block }: Of<"table">) {
  return (
    <div class={styles.scroll}>
      {block.caption ? <p class={styles.caption}>{block.caption}</p> : null}
      <table class={styles.table}>
        <thead>
          <tr>
            {block.columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KeyValueView({ block }: Of<"key-value">) {
  return (
    <div class={styles.scroll}>
      {block.caption ? <p class={styles.caption}>{block.caption}</p> : null}
      <table class={styles.table}>
        <tbody>
          {block.entries.map(([k, v], i) => (
            <tr key={i}>
              <th scope="row">{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Nodes({ nodes }: { nodes: TreeNode[] }) {
  return (
    <ul class={styles.tree}>
      {nodes.map((node, i) => (
        <li key={i}>
          {node.label}
          {node.meta ? <span class={styles.meta}>{node.meta}</span> : null}
          {node.children?.length ? <Nodes nodes={node.children} /> : null}
        </li>
      ))}
    </ul>
  );
}

const TreeView = ({ block }: Of<"tree">) => <Nodes nodes={block.nodes} />;
const MarkdownView = ({ block }: Of<"markdown">) => <Markdown text={block.text} />;

export const views: Record<string, ComponentType<{ block: UiBlock }>> = {
  table: TableView as ComponentType<{ block: UiBlock }>,
  "key-value": KeyValueView as ComponentType<{ block: UiBlock }>,
  tree: TreeView as ComponentType<{ block: UiBlock }>,
  markdown: MarkdownView as ComponentType<{ block: UiBlock }>,
};
