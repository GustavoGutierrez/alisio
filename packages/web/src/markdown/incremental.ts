/**
 * Incremental Markdown for streamed assistant text (spec §10.5). `marked`'s lexer produces a
 * token tree (never an HTML string: the view renders tokens as Preact nodes, so no `innerHTML`
 * and no sanitizer are needed). On every update only the text from the start of the
 * second-to-last block is re-lexed; earlier blocks are frozen and keep their object identity, so
 * memoized views skip them. An unclosed fence always runs to the end of the text, so it stays
 * among the open blocks until it closes.
 */
import { Marked, type Token } from "marked";
import { inlineMathExtension } from "./fences.ts";

export interface MarkdownBlock {
  /** Stable key: the block's offset in the source. */
  key: string;
  offset: number;
  token: Token;
  /** Frozen blocks never change again while the text only grows. */
  frozen: boolean;
}

export interface MarkdownState {
  source: string;
  blocks: MarkdownBlock[];
  /** Offset where the open (re-lexed) region starts. */
  frozenEnd: number;
}

const markdown = new Marked({ gfm: true, extensions: [inlineMathExtension] });

/** Blocks kept open (re-lexed on every update). */
const OPEN_BLOCKS = 2;

export const emptyMarkdown = (): MarkdownState => ({ source: "", blocks: [], frozenEnd: 0 });

interface Lexed {
  block?: MarkdownBlock;
  end: number;
}

function lexFrom(text: string, base: number): Lexed[] {
  const out: Lexed[] = [];
  let offset = base;
  for (const token of markdown.lexer(text)) {
    const start = offset;
    offset += token.raw.length;
    out.push({
      ...(token.type === "space"
        ? {}
        : { block: { key: `b${start}`, offset: start, token, frozen: false } }),
      end: offset,
    });
  }
  return out;
}

/** Every block of `text`, parsed at once (no freezing). */
export const fullBlocks = (text: string): MarkdownBlock[] =>
  lexFrom(text.replace(/\r\n?/g, "\n"), 0).flatMap((l) => (l.block ? [l.block] : []));

/** Updates the parse for `text`; when `text` does not extend the previous source, starts over. */
export function updateMarkdown(previous: MarkdownState, input: string): MarkdownState {
  const text = input.replace(/\r\n?/g, "\n");
  if (text === previous.source) return previous;
  const state = text.startsWith(previous.source) ? previous : emptyMarkdown();
  const frozen = state.blocks.filter((b) => b.frozen);
  const lexed = lexFrom(text.slice(state.frozenEnd), state.frozenEnd);
  const content = lexed.filter((l) => l.block).length;
  let toFreeze = Math.max(0, content - OPEN_BLOCKS);
  let frozenEnd = state.frozenEnd;
  const open: MarkdownBlock[] = [];
  for (const item of lexed) {
    if (toFreeze > 0) {
      if (item.block) {
        frozen.push({ ...item.block, frozen: true });
        toFreeze--;
      }
      frozenEnd = item.end;
    } else if (item.block) open.push(item.block);
  }
  return { source: text, blocks: [...frozen, ...open], frozenEnd };
}
