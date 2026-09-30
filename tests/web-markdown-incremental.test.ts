import { describe, expect, it } from "vitest";
import { fenceBlock, mathBlock } from "../packages/web/src/markdown/fences.ts";
import {
  emptyMarkdown,
  fullBlocks,
  type MarkdownState,
  updateMarkdown,
} from "../packages/web/src/markdown/incremental.ts";

const DOC = [
  "# Title",
  "",
  "Some *intro* text with `code` and a [link](https://example.com).",
  "",
  "- one",
  "- two",
  "  continued",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "```ts",
  "const x = 1;",
  "",
  "console.log(x);",
  "```",
  "",
  "> quoted",
  "",
  "Final paragraph.",
  "",
].join("\n");

const shape = (state: MarkdownState) =>
  state.blocks.map((b) => ({ type: b.token.type, raw: b.token.raw }));
const reference = (text: string) =>
  fullBlocks(text).map((b) => ({ type: b.token.type, raw: b.token.raw }));

function stream(text: string, step: number): MarkdownState {
  let state = emptyMarkdown();
  for (let end = step; end < text.length + step; end += step)
    state = updateMarkdown(state, text.slice(0, end));
  return state;
}

describe("incremental markdown", () => {
  it("ends with the same blocks as a full parse, whatever the chunk size", () => {
    for (const step of [1, 3, 7, 16, 64, DOC.length])
      expect(shape(stream(DOC, step)), `step ${step}`).toEqual(reference(DOC));
  });

  it("freezes finished blocks: they keep identity and are not re-parsed", () => {
    let state = updateMarkdown(emptyMarkdown(), "# A\n\npara one\n\npara two\n\npara");
    const frozen = state.blocks.filter((b) => b.frozen);
    expect(frozen.map((b) => b.token.type)).toEqual(["heading", "paragraph"]);
    state = updateMarkdown(state, "# A\n\npara one\n\npara two\n\npara three and more");
    expect(state.blocks[0]).toBe(frozen[0]);
    expect(state.blocks[1]).toBe(frozen[1]);
    expect(state.blocks.at(-1)?.frozen).toBe(false);
    expect(state.blocks.map((b) => b.key)).toEqual(state.blocks.map((b) => `b${b.offset}`));
  });

  it("treats an unclosed fence as open: never frozen, closed later with the right content", () => {
    let state = updateMarkdown(emptyMarkdown(), "a\n\nb\n\n```js\nlet a = 1;\n\n\nlet b");
    const last = state.blocks.at(-1);
    expect(last?.token.type).toBe("code");
    expect(last?.frozen).toBe(false);
    state = updateMarkdown(state, "a\n\nb\n\n```js\nlet a = 1;\n\n\nlet b = 2;\n```\n\nafter");
    const code = state.blocks.find((b) => b.token.type === "code");
    expect(code?.token.type === "code" && code.token.text).toBe("let a = 1;\n\n\nlet b = 2;");
    expect(state.blocks.at(-1)?.token.type).toBe("paragraph");
  });

  it("starts over when the text is replaced rather than extended", () => {
    let state = updateMarkdown(emptyMarkdown(), "# One\n\ntwo\n\nthree\n\nfour");
    state = updateMarkdown(state, "Different");
    expect(shape(state)).toEqual([{ type: "paragraph", raw: "Different" }]);
  });

  it("routes special fences to UiBlocks", () => {
    expect(fenceBlock("mermaid", "graph TD; A-->B")).toEqual({
      kind: "mermaid",
      source: "graph TD; A-->B",
    });
    expect(fenceBlock("math", "x^2")).toEqual({ kind: "math", latex: "x^2", display: true });
    expect(fenceBlock("diff", "-a\n+b")).toEqual({ kind: "diff", patch: "-a\n+b" });
    expect(fenceBlock("ts", "let a")).toEqual({ kind: "code", lang: "ts", code: "let a" });
    expect(fenceBlock("", "plain")).toEqual({ kind: "code", code: "plain" });
    const short = JSON.stringify({ a: 1 }, null, 2);
    expect(fenceBlock("json", short)).toEqual({ kind: "code", lang: "json", code: short });
    const long = JSON.stringify(
      Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i])),
      null,
      2,
    );
    expect(fenceBlock("json", long)).toMatchObject({ kind: "json", value: { k0: 0 } });
    expect(fenceBlock("json", `${long}\n,broken`)).toMatchObject({ kind: "code", lang: "json" });
  });

  it("recognizes $$ display math paragraphs, not inline dollar amounts", () => {
    expect(mathBlock("$$\n\\int_0^1 x\\,dx\n$$")).toEqual({
      kind: "math",
      latex: "\\int_0^1 x\\,dx",
      display: true,
    });
    expect(mathBlock("It costs $5 and $6.")).toBeUndefined();
  });

  const inlineTokens = (text: string) => {
    const [block] = updateMarkdown(emptyMarkdown(), text).blocks;
    const tokens = (block?.token as { tokens?: Array<{ type: string; text?: string }> }).tokens;
    return (tokens ?? []).map((t) => ({ type: t.type, text: t.text }));
  };

  it("routes \\( … \\) to inline math, never $ amounts", () => {
    expect(inlineTokens("Area \\(\\pi r^2\\) here")).toEqual([
      { type: "text", text: "Area " },
      { type: "inlineMath", text: "\\pi r^2" },
      { type: "text", text: " here" },
    ]);
    expect(inlineTokens("It costs $5 and $6.").map((t) => t.type)).not.toContain("inlineMath");
    expect(inlineTokens("open \\(x^2 never closed").map((t) => t.type)).not.toContain("inlineMath");
    expect(inlineTokens("`\\(code\\)`").map((t) => t.type)).toEqual(["codespan"]);
  });

  it("routes ```math and $$ blocks to display math while streaming", () => {
    let state = updateMarkdown(emptyMarkdown(), "Intro\n\n```math\nE = m");
    expect(state.blocks.at(-1)?.token.type).toBe("code");
    state = updateMarkdown(state, "Intro\n\n```math\nE = mc^2\n```\n\n$$a+b$$\n\nend");
    const code = state.blocks.find((b) => b.token.type === "code")?.token as {
      lang: string;
      text: string;
    };
    expect(fenceBlock(code.lang, code.text)).toEqual({
      kind: "math",
      latex: "E = mc^2",
      display: true,
    });
    const para = state.blocks.find((b) => b.token.raw.startsWith("$$"))?.token as {
      text: string;
    };
    expect(mathBlock(para.text)).toEqual({ kind: "math", latex: "a+b", display: true });
  });
});
