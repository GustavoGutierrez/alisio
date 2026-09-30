/**
 * Phase 3 views for developer blocks: readable and safe, deliberately simple. Phase 4 replaces
 * them with the full renderers of spec §10.4 (unified/split diff, ANSI terminal, JSON tree,
 * test filters); Phase 5 adds Mermaid and KaTeX.
 */
import type { UiBlock } from "@alisio/sdk";
import type { ComponentType } from "preact";
import styles from "../blocks.module.css";
import CodeView from "../code/view.tsx";

type Of<K extends UiBlock["kind"]> = { block: Extract<UiBlock, { kind: K }> };
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

function DiffView({ block }: Of<"diff">) {
  const patch =
    block.patch ??
    [
      block.before !== undefined ? `--- ${block.path ?? "before"}\n${block.before}` : "",
      block.after !== undefined ? `+++ ${block.path ?? "after"}\n${block.after}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  return (
    <div>
      {block.path || block.caption ? (
        <p class={styles.caption}>{block.caption ?? block.path}</p>
      ) : null}
      <pre class={styles.plain}>
        {patch.split("\n").map((line, i) => (
          <span
            key={i}
            class={
              line.startsWith("@@")
                ? styles.hunk
                : line.startsWith("+")
                  ? styles.add
                  : line.startsWith("-")
                    ? styles.del
                    : undefined
            }
          >
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

function TerminalView({ block }: Of<"terminal">) {
  return (
    <div>
      {block.command ? <p class={styles.caption}>$ {block.command}</p> : null}
      <pre class={styles.plain}>{block.output.replace(ANSI, "")}</pre>
      {block.exitCode !== undefined || block.durationMs !== undefined ? (
        <p class={styles.status}>
          {block.exitCode !== undefined ? (
            <span class={block.exitCode === 0 ? styles.passed : styles.failed}>
              exit {block.exitCode}
            </span>
          ) : null}
          {block.durationMs !== undefined ? <span>{block.durationMs} ms</span> : null}
        </p>
      ) : null}
    </div>
  );
}

const JsonView = ({ block }: Of<"json">) => (
  <CodeView
    block={{
      kind: "code",
      lang: "json",
      code: JSON.stringify(block.value, null, 2),
      ...(block.caption ? { caption: block.caption } : {}),
    }}
  />
);

function TestsView({ block }: Of<"test-results">) {
  const cases = block.suites.flatMap((s) => s.cases);
  const count = (status: string) => cases.filter((c) => c.status === status).length;
  return (
    <div>
      <p class={styles.status}>
        <span class={styles.passed}>✓ {count("passed")}</span>
        <span class={styles.failed}>✗ {count("failed")}</span>
        <span>○ {count("skipped") + count("todo")}</span>
      </p>
      {block.suites.map((suite, i) => (
        <div key={i}>
          <p class={styles.caption}>{suite.name}</p>
          <ul class={styles.tree}>
            {suite.cases.map((c, j) => (
              <li key={j} class={c.status === "failed" ? styles.failed : undefined}>
                {c.status === "passed" ? "✓" : c.status === "failed" ? "✗" : "○"} {c.name}
                {c.error ? <pre class={styles.plain}>{c.error}</pre> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

const MARK = { pending: "○", running: "●", completed: "✓", failed: "✗", cancelled: "–" } as const;

function ProgressView({ block }: Of<"progress">) {
  return (
    <div>
      {block.title ? <p class={styles.caption}>{block.title}</p> : null}
      <ul class={styles.tree}>
        {block.steps.map((step, i) => (
          <li key={i}>
            {MARK[step.status]} {step.label}
            {step.detail ? <span class={styles.meta}>{step.detail}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

const MermaidSource = ({ block }: Of<"mermaid">) => (
  <CodeView
    block={{
      kind: "code",
      lang: "mermaid",
      code: block.source,
      ...(block.title ? { caption: block.title } : {}),
    }}
  />
);
const MathSource = ({ block }: Of<"math">) => (
  <CodeView block={{ kind: "code", lang: "latex", code: block.latex }} />
);

export const views: Record<string, ComponentType<{ block: UiBlock }>> = {
  diff: DiffView as ComponentType<{ block: UiBlock }>,
  terminal: TerminalView as ComponentType<{ block: UiBlock }>,
  json: JsonView as ComponentType<{ block: UiBlock }>,
  "test-results": TestsView as ComponentType<{ block: UiBlock }>,
  progress: ProgressView as ComponentType<{ block: UiBlock }>,
  mermaid: MermaidSource as ComponentType<{ block: UiBlock }>,
  math: MathSource as ComponentType<{ block: UiBlock }>,
};
