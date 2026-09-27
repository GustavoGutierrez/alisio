import { type ToolResult, textProjection, textResult, type UiBlock } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  blockFromJsonText,
  blockFromUnknown,
  mapMcpCallResult,
  mapMcpResourceResult,
  renderUiBlockText,
} from "../packages/core/src/mcp/rich.ts";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("SDK contract", () => {
  it("keeps textResult byte-identical and the UiBlock union compiles", () => {
    expect(textResult("unchanged")).toEqual({ content: [{ type: "text", text: "unchanged" }] });
    expect(textResult("error", true)).toEqual({
      content: [{ type: "text", text: "error" }],
      isError: true,
    });
    const table: UiBlock = { kind: "table", columns: ["a", "b"], rows: [["1", "2"]] };
    const tree: UiBlock = {
      kind: "tree",
      nodes: [{ label: "root", children: [{ label: "leaf" }] }],
    };
    const kv: UiBlock = {
      kind: "key-value",
      entries: [
        ["k", "v"],
        ["n", "4"],
      ],
    };
    const code: UiBlock = { kind: "code", lang: "ts", code: "const x = 1;" };
    const md: UiBlock = { kind: "markdown", text: "# hi" };
    // Every union member is assignable to a ToolResult content part (compile-time contract).
    const blocks: UiBlock[] = [table, tree, kv, code, md];
    const rich: ToolResult = {
      content: [
        { type: "text", text: "plain" },
        ...blocks.map((block) => ({ type: "ui" as const, block })),
        { type: "image", mimeType: "image/png", data: PNG_1PX },
      ],
    };
    expect(rich.content).toHaveLength(7);
  });
});

describe("textProjection", () => {
  it("keeps text parts in order and drops ui/image parts, preserving isError", () => {
    const result: ToolResult = {
      content: [
        { type: "text", text: "first" },
        { type: "ui", block: { kind: "key-value", entries: [["a", "1"]] } },
        { type: "image", mimeType: "image/png", data: PNG_1PX },
        { type: "text", text: "last" },
      ],
      isError: true,
    };
    expect(textProjection(result)).toEqual({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "last" },
      ],
      isError: true,
    });
  });

  it("returns the same reference when already text-only", () => {
    const result = textResult("plain");
    expect(textProjection(result)).toBe(result);
  });
});

describe("shape detection", () => {
  it("recognizes {columns,rows} and {headers,rows} tables", () => {
    expect(
      blockFromUnknown({
        columns: ["a", "b"],
        rows: [
          ["1", "2"],
          ["3", "4"],
        ],
      }),
    ).toEqual({
      kind: "table",
      columns: ["a", "b"],
      rows: [
        ["1", "2"],
        ["3", "4"],
      ],
    });
    expect(blockFromUnknown({ headers: ["x"], rows: [{ x: 1 }] })).toEqual({
      kind: "table",
      columns: ["x"],
      rows: [["1"]],
    });
  });

  it("recognizes {nodes:[...]} trees with children and meta", () => {
    expect(
      blockFromUnknown({ nodes: [{ label: "root", children: [{ label: "leaf", meta: "2" }] }] }),
    ).toEqual({
      kind: "tree",
      nodes: [{ label: "root", children: [{ label: "leaf", meta: "2" }] }],
    });
    expect(blockFromUnknown({ tree: { label: "single" } })).toEqual({
      kind: "tree",
      nodes: [{ label: "single" }],
    });
  });

  it("recognizes flat scalar objects as key-value, rejects nested ones", () => {
    expect(blockFromUnknown({ name: "alisio", count: 3, ok: true, none: null })).toEqual({
      kind: "key-value",
      entries: [
        ["name", "alisio"],
        ["count", "3"],
        ["ok", "true"],
        ["none", "null"],
      ],
    });
    expect(blockFromUnknown({ nested: { a: 1 } })).toBeUndefined();
    expect(blockFromUnknown(["a", "b"])).toBeUndefined();
    expect(blockFromUnknown({ rows: [["1"]] })).toBeUndefined(); // no columns
  });

  it("parses JSON text parts only when they look like a record", () => {
    expect(blockFromJsonText('{"a": 1}')).toEqual({ kind: "key-value", entries: [["a", "1"]] });
    expect(blockFromJsonText('{"columns":["a"],"rows":[["b"]]}')).toEqual({
      kind: "table",
      columns: ["a"],
      rows: [["b"]],
    });
    expect(blockFromJsonText("[1, 2, 3]")).toBeUndefined();
    expect(blockFromJsonText("not json")).toBeUndefined();
    expect(blockFromJsonText('{"a":{"b":1}}')).toBeUndefined(); // nested, no verified shape
  });
});

describe("mapMcpCallResult", () => {
  it("keeps plain text-only results as text (one part, no projection noise)", () => {
    expect(mapMcpCallResult({ content: [{ type: "text", text: "hi" }] })).toEqual({
      content: [{ type: "text", text: "hi" }],
    });
  });

  it("maps an image part with its mime and base64 data and projects a marker", () => {
    const result = mapMcpCallResult({
      content: [{ type: "image", mimeType: "image/png", data: PNG_1PX }],
    });
    expect(result.content[0]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: PNG_1PX,
    });
    expect(result.content[1]).toEqual({
      type: "text",
      text: `[image: image/png (${Math.floor((PNG_1PX.length * 3) / 4)} bytes)]`,
    });
  });

  it("folds structuredContent tables and always appends the canonical text projection", () => {
    const result = mapMcpCallResult({
      content: [],
      structuredContent: { columns: ["a", "b"], rows: [["1", "2"]] },
    });
    expect(result.content[0]).toEqual({
      type: "ui",
      block: { kind: "table", columns: ["a", "b"], rows: [["1", "2"]] },
    });
    const projection = result.content[1];
    expect(projection && "text" in projection ? projection.text : "").toContain("| a | b |");
    expect(projection && "text" in projection ? projection.text : "").toContain("| 1 | 2 |");
  });

  it("folds a JSON-parseable text part matching a key-value shape", () => {
    const result = mapMcpCallResult({
      content: [{ type: "text", text: '{"repo": "alisio", "branch": "main"}' }],
    });
    expect(result.content[0]).toEqual({
      type: "ui",
      block: {
        kind: "key-value",
        entries: [
          ["repo", "alisio"],
          ["branch", "main"],
        ],
      },
    });
    expect(result.content[1]).toEqual({ type: "text", text: "repo: alisio\nbranch: main" });
  });

  it("keeps unverifiable JSON text as plain text (previous flattening behavior)", () => {
    expect(mapMcpCallResult({ content: [{ type: "text", text: '{"nested":{"a":1}}' }] })).toEqual({
      content: [{ type: "text", text: '{"nested":{"a":1}}' }],
    });
  });

  it("marks audio/unknown parts with a text marker, never forwarding raw data", () => {
    const result = mapMcpCallResult({
      content: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }],
    });
    expect(result.content).toEqual([{ type: "text", text: "[mcp part: audio]" }]);
  });

  it("falls back to JSON.stringify for unrecognized results, preserving isError", () => {
    const raw = { other: 1, isError: true };
    expect(mapMcpCallResult(raw)).toEqual({
      content: [{ type: "text", text: JSON.stringify(raw) }],
      isError: true,
    });
  });

  it("maps text + image + structuredContent together with one projection", () => {
    const result = mapMcpCallResult({
      content: [
        { type: "text", text: "plain" },
        { type: "image", mimeType: "image/png", data: PNG_1PX },
      ],
      structuredContent: { nodes: [{ label: "root", children: [{ label: "leaf" }] }] },
    });
    const kinds = result.content.map((p) => p.type);
    expect(kinds).toEqual(["text", "image", "ui", "text"]);
    const projection = result.content.at(-1);
    expect(projection && "text" in projection ? projection.text : "").toContain(
      "[image: image/png (72 bytes)]",
    );
    expect(projection && "text" in projection ? projection.text : "").toContain("└─ root");
    expect(projection && "text" in projection ? projection.text : "").toContain("└─ leaf");
  });
});

describe("mapMcpResourceResult", () => {
  it("maps text contents to text parts", () => {
    expect(
      mapMcpResourceResult({
        contents: [{ uri: "test://example", mimeType: "text/plain", text: "resource content" }],
      }),
    ).toEqual({ content: [{ type: "text", text: "resource content" }] });
  });

  it("maps image blobs to image parts and projects a marker", () => {
    const result = mapMcpResourceResult({
      contents: [{ uri: "test://logo.png", mimeType: "image/png", blob: PNG_1PX }],
    });
    expect(result.content[0]).toEqual({ type: "image", mimeType: "image/png", data: PNG_1PX });
  });

  it("keeps non-image blobs as a text marker, never raw base64", () => {
    expect(
      mapMcpResourceResult({
        contents: [{ uri: "test://doc.pdf", mimeType: "application/pdf", blob: "JVBERi0x" }],
      }),
    ).toEqual({ content: [{ type: "text", text: "[resource blob: application/pdf (6 bytes)]" }] });
  });

  it("keeps resource listings (no contents) as flattened JSON", () => {
    const listing = { resources: [{ uri: "test://example", name: "example" }] };
    expect(mapMcpResourceResult(listing)).toEqual({
      content: [{ type: "text", text: JSON.stringify(listing) }],
    });
  });

  it("folds JSON text contents that match a verified shape", () => {
    const result = mapMcpResourceResult({
      contents: [
        {
          uri: "test://table",
          mimeType: "application/json",
          text: '{"columns":["a"],"rows":[["1"]]}',
        },
      ],
    });
    expect(result.content[0]).toEqual({
      type: "ui",
      block: { kind: "table", columns: ["a"], rows: [["1"]] },
    });
    expect(result.content[1]).toEqual({ type: "text", text: "| a |\n| --- |\n| 1 |" });
  });
});

describe("renderUiBlockText (canonical model projection)", () => {
  it("renders tables as markdown tables", () => {
    expect(
      renderUiBlockText({
        kind: "table",
        columns: ["a", "b"],
        rows: [["1", "2"]],
        caption: "sizes",
      }),
    ).toBe("[table: sizes]\n| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  it("renders key-value, trees, code and markdown blocks", () => {
    expect(renderUiBlockText({ kind: "key-value", entries: [["a", "1"]] })).toBe("a: 1");
    expect(
      renderUiBlockText({ kind: "tree", nodes: [{ label: "r", children: [{ label: "l" }] }] }),
    ).toBe("└─ r\n   └─ l");
    expect(renderUiBlockText({ kind: "code", lang: "ts", code: "const x = 1;" })).toBe(
      "```ts\nconst x = 1;\n```",
    );
    expect(renderUiBlockText({ kind: "markdown", text: "# hi" })).toBe("# hi");
  });
});
