/**
 * Markdown as Preact nodes from `marked` tokens: raw HTML is shown as text, links are
 * restricted to http(s)/mailto, images are never fetched. Frozen blocks are memoized by
 * identity, so a streaming message only re-renders its open tail (spec §10.5).
 */
import type { Token, Tokens } from "marked";
import { Component, type ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import { RendererHost } from "../renderers/RendererHost.tsx";
import { detail } from "../store/app.ts";
import { openInDock } from "../store/dock.ts";
import { workspaceRelative } from "../util/files.ts";
import { fenceBlock, mathBlock } from "./fences.ts";
import {
  emptyMarkdown,
  type MarkdownBlock,
  type MarkdownState,
  updateMarkdown,
} from "./incremental.ts";
import styles from "./markdown.module.css";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });

const SAFE_LINK = /^(https?:|mailto:)/i;

function inline(tokens: Token[] | undefined): ComponentChildren {
  if (!tokens) return null;
  return tokens.map((token, i) => <Inline key={i} token={token} />);
}

function Inline({ token }: { token: Token }): ComponentChildren {
  switch (token.type) {
    case "text":
    case "escape": {
      const t = token as Tokens.Text;
      return t.tokens?.length ? inline(t.tokens) : decodeEntities(t.text);
    }
    case "strong":
      return <strong>{inline((token as Tokens.Strong).tokens)}</strong>;
    case "em":
      return <em>{inline((token as Tokens.Em).tokens)}</em>;
    case "del":
      return <del>{inline((token as Tokens.Del).tokens)}</del>;
    case "codespan":
      return <code class={styles.codespan}>{(token as Tokens.Codespan).text}</code>;
    case "br":
      return <br />;
    case "link": {
      const link = token as Tokens.Link;
      if (SAFE_LINK.test(link.href))
        return (
          <a
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            title={link.title ?? undefined}
          >
            {inline(link.tokens)}
          </a>
        );
      // Workspace paths open in the dock; unsafe schemes stay plain text.
      if (workspaceRelative(detail.value?.workspace, link.href) !== undefined)
        return (
          <button
            type="button"
            class={styles.fileLink}
            title={link.href}
            onClick={() => void openInDock(link.href)}
          >
            {inline(link.tokens)}
          </button>
        );
      return (
        <span class={styles.path} title={link.href}>
          {inline(link.tokens)}
        </span>
      );
    }
    case "image": {
      const image = token as Tokens.Image;
      return SAFE_LINK.test(image.href) ? (
        <a href={image.href} target="_blank" rel="noopener noreferrer">
          {image.text || image.href}
        </a>
      ) : (
        image.text
      );
    }
    case "checkbox":
      return (
        <input
          type="checkbox"
          checked={(token as Tokens.Checkbox).checked}
          disabled
          class={styles.check}
        />
      );
    case "html":
      return (token as Tokens.HTML).text;
    default: {
      const generic = token as { tokens?: Token[]; text?: string; raw: string };
      return generic.tokens ? inline(generic.tokens) : (generic.text ?? generic.raw);
    }
  }
}

function BlockToken({ token, live }: { token: Token; live?: boolean }): ComponentChildren {
  switch (token.type) {
    case "heading": {
      const h = token as Tokens.Heading;
      const Tag = `h${Math.min(6, Math.max(1, h.depth))}` as "h1";
      return <Tag class={styles.heading}>{inline(h.tokens)}</Tag>;
    }
    case "paragraph": {
      const p = token as Tokens.Paragraph;
      const math = mathBlock(p.text);
      if (math) return <RendererHost block={math} live={live} />;
      return <p>{inline(p.tokens)}</p>;
    }
    case "text": {
      const t = token as Tokens.Text;
      return t.tokens ? inline(t.tokens) : decodeEntities(t.text);
    }
    case "code": {
      const code = token as Tokens.Code;
      return <RendererHost block={fenceBlock(code.lang, code.text)} live={live} />;
    }
    case "blockquote":
      return (
        <blockquote class={styles.quote}>
          {(token as Tokens.Blockquote).tokens.map((child, i) => (
            <BlockToken key={i} token={child} live={live} />
          ))}
        </blockquote>
      );
    case "list": {
      const list = token as Tokens.List;
      const items = list.items.map((item, i) => (
        <li key={i} class={item.task ? styles.task : undefined}>
          {item.tokens.map((child, j) =>
            child.type === "text" && !list.loose ? (
              <Inline key={j} token={child} />
            ) : (
              <BlockToken key={j} token={child} live={live} />
            ),
          )}
        </li>
      ));
      return list.ordered ? (
        <ol start={typeof list.start === "number" ? list.start : undefined}>{items}</ol>
      ) : (
        <ul>{items}</ul>
      );
    }
    case "table": {
      const table = token as Tokens.Table;
      const align = (i: number) => table.align[i] ?? undefined;
      return (
        <div class={styles.tableWrap}>
          <table class={styles.table}>
            <thead>
              <tr>
                {table.header.map((cell, i) => (
                  <th key={i} scope="col" style={{ textAlign: align(i) }}>
                    {inline(cell.tokens)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} style={{ textAlign: align(j) }}>
                      {inline(cell.tokens)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "hr":
      return <hr class={styles.hr} />;
    case "html":
      return <p class={styles.rawHtml}>{(token as Tokens.HTML).text}</p>;
    case "space":
    case "def":
      return null;
    default: {
      const generic = token as { tokens?: Token[]; text?: string; raw: string };
      return generic.tokens ? (
        <p>{inline(generic.tokens)}</p>
      ) : (
        <p>{generic.text ?? generic.raw}</p>
      );
    }
  }
}

/** A frozen block renders once: its token object never changes. */
class Block extends Component<{ block: MarkdownBlock; live?: boolean }> {
  override shouldComponentUpdate(next: { block: MarkdownBlock; live?: boolean }) {
    return next.block !== this.props.block || next.live !== this.props.live;
  }
  override render() {
    return (
      <BlockToken
        token={this.props.block.token}
        live={this.props.live && !this.props.block.frozen}
      />
    );
  }
}

/** Renders Markdown text; while `streaming`, only the open tail is re-parsed and re-rendered. */
export function Markdown(props: { text: string; streaming?: boolean }) {
  const state = useRef<MarkdownState>(emptyMarkdown());
  state.current = updateMarkdown(state.current, props.text);
  return (
    <div class={styles.md}>
      {state.current.blocks.map((block) => (
        <Block key={block.key} block={block} live={props.streaming} />
      ))}
    </div>
  );
}
