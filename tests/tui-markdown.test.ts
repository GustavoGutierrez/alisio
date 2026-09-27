import { afterEach, describe, expect, it } from "vitest";
import { AssistantBlock } from "../packages/cli/src/tui/components.ts";
import type { TranscriptItem } from "../packages/cli/src/tui/state.ts";
import { editorCopyKey } from "../packages/cli/src/tui/state.ts";
import {
  highlightCode,
  markdownTheme,
  normalizeTableSeparators,
  sanitizeCode,
  tokenizeCode,
} from "../packages/cli/src/tui/theme.ts";

const savedEnv = new Map<string, string | undefined>();
afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});
const setEnv = (key: string, value: string | undefined = undefined) => {
  savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

const joined = (tokens: ReturnType<typeof tokenizeCode>[number]) =>
  tokens.map((t) => `${t.style}:${t.text}`).join("|");

describe("sanitizeCode", () => {
  it("strips ANSI and control characters and normalizes tabs", () => {
    expect(sanitizeCode("a\x1b[31mb\x1b[0mc\x07\tx\x1b]52;c;QUJD\x07")).toBe("abc  x");
  });
});

describe("highlightCode", () => {
  it("colors keywords, strings, numbers and comments in TS code", () => {
    const [decl, assign] = highlightCode('const name = "ali"; // TODO: fill\nconst n = 42;', "ts");
    expect(decl).toContain("\x1b[35m"); // keyword magenta
    expect(decl).toContain("\x1b[32m"); // string green
    expect(decl).toContain("\x1b[90m"); // comment gray
    expect(assign).toContain("\x1b[33m"); // number yellow
  });

  it("returns plain lines under NO_COLOR", () => {
    setEnv("NO_COLOR", "1");
    const out = highlightCode('const s = "x"; // c\nlet n = 42;', "ts");
    expect(out).toEqual(['const s = "x"; // c', "let n = 42;"]);
    for (const line of out) expect(line).not.toContain("\x1b");
  });

  it("never re-emits ANSI bytes that came from the input", () => {
    const out = highlightCode('const a = "\u001b[31mred\u001b[0m" + "🎉";\u0007', "ts");
    const stripped = out.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped).toBe('const a = "red" + "🎉";');
  });

  it("keeps code blocks two spaces indented through the theme", () => {
    expect(markdownTheme.codeBlockIndent).toBe("  ");
    expect(typeof markdownTheme.highlightCode).toBe("function");
  });
});

describe("tokenizeCode", () => {
  it("tokenizes a TS snippet into the expected styled segments", () => {
    const [line] = tokenizeCode("async function add(a, b) { return a + b; }", "ts");
    expect(joined(line ?? [])).toBe(
      "keyword:async|plain: |keyword:function|plain: |function:add|plain:(|plain:a|plain:,|plain: |plain:b|plain:)|plain: |plain:{|plain: |keyword:return|plain: |plain:a|plain: |plain:+|plain: |plain:b|plain:;|plain: |plain:}",
    );
  });

  it("marks JSON keys as properties and values as strings/numbers", () => {
    const [line] = tokenizeCode('{"answer": 42, "note": "ok"}', "json");
    const out = joined(line ?? []);
    expect(out).toContain("plain:{");
    expect(out).toContain('property:"answer"');
    expect(out).toContain("number:42");
    expect(out).toContain('string:"ok"');
  });

  it("tokenizes bash variables, assignments and comments", () => {
    const [assign, echo] = tokenizeCode('FOO="bar"\necho $FOO # done', "bash");
    expect(joined(assign ?? [])).toBe('property:FOO|plain:=|string:"bar"');
    expect(joined(echo ?? [])).toBe("plain:echo|plain: |number:$FOO|plain: |comment:# done");
  });

  it("tokenizes Python decorators, defs, docstrings and f-strings", () => {
    const lines = tokenizeCode(
      '@app.get("/")\ndef hello(name):\n    """Greet someone.\n    Multi-line."""\n    return f"hi {name}"  # comment',
      "python",
    );
    expect(joined(lines[0] ?? [])).toContain("function:app");
    expect(joined(lines[1] ?? [])).toBe(
      "keyword:def|plain: |function:hello|plain:(|plain:name|plain:)|plain::",
    );
    expect(joined(lines[2] ?? [])).toBe('plain:    |string:"""Greet someone.');
    expect(joined(lines[3] ?? [])).toBe('string:    Multi-line."""');
    expect(joined(lines[4] ?? [])).toContain("keyword:return");
    expect(joined(lines[4] ?? [])).toContain('string:f"hi {name}"');
    expect(joined(lines[4] ?? [])).toContain("comment:# comment");
  });

  it("keeps multi-line docstrings and block comments across lines", () => {
    const lines = tokenizeCode("/* open\ndone */\nx = 1", "ts");
    expect(joined(lines[0] ?? [])).toBe("comment:/* open");
    expect(joined(lines[1] ?? [])).toBe("comment:done */");
    expect(joined(lines[2] ?? [])).toContain("number:1");
  });

  it("colors YAML keys, CSS properties and HTML tags and attributes", () => {
    expect(joined(tokenizeCode("name: alisio", "yaml")[0] ?? [])).toBe(
      "property:name|plain::|plain: |plain:alisio",
    );
    expect(joined(tokenizeCode("color: red;", "css")[0] ?? [])).toContain("property:color");
    expect(joined(tokenizeCode('<div class="btn">hi</div>', "html")[0] ?? [])).toBe(
      'keyword:<div|plain: |property:class|plain:=|string:"btn"|plain:>|plain:hi|keyword:</div|plain:>',
    );
  });
});

describe("normalizeTableSeparators", () => {
  it("rewrites em-dash separators to ASCII dashes, preserving alignment", () => {
    expect(normalizeTableSeparators("| a | b |\n|:——|—:|")).toBe("| a | b |\n|:---|---:|");
  });

  it("leaves well-formed ASCII separators alone", () => {
    const md = "| a | b |\n| --- | :---: |";
    expect(normalizeTableSeparators(md)).toBe(md);
  });

  it("does not touch horizontal rules or setext underlines (no pipes)", () => {
    const md = "# t\n---\n=== line";
    expect(normalizeTableSeparators(md)).toBe(md);
  });

  it("does not touch fenced or indented code", () => {
    const md = "```\n| — | — |\n```\n    | — | — |";
    expect(normalizeTableSeparators(md)).toBe(md);
  });

  it("does not touch prose rows", () => {
    expect(normalizeTableSeparators("| a | b |\n| c | d |")).toBe("| a | b |\n| c | d |");
  });
});

describe("AssistantBlock copy affordance", () => {
  const assistant = (
    text: string,
    done: boolean,
  ): Extract<TranscriptItem, { kind: "assistant" }> => ({
    kind: "assistant",
    text,
    reasoning: "",
    done,
  });

  it("shows a dim copy hint under a completed response", () => {
    const lines = new AssistantBlock(assistant("hello **world**", true)).render(80);
    const hint = lines.at(-1);
    expect(hint).toContain("copy");
    expect(hint).toContain("/copy");
    expect(hint).toContain("\x1b[2m"); // dim
  });

  it("shows no hint while streaming", () => {
    const block = new AssistantBlock(assistant("running", false));
    expect(block.render(80).some((l) => l.includes("/copy"))).toBe(false);
  });

  it("shows no hint for an empty completed response", () => {
    const block = new AssistantBlock(assistant("", true));
    expect(block.render(80).some((l) => l.includes("/copy"))).toBe(false);
  });

  it("appears once the answer completes", () => {
    const block = new AssistantBlock(assistant("partial", false));
    block.update(assistant("partial", true));
    expect(block.render(80).some((l) => l.includes("/copy"))).toBe(true);
  });

  it("falls back to an ASCII hint in a dumb terminal", () => {
    setEnv("TERM", "dumb");
    setEnv("LANG", "C");
    const hint = new AssistantBlock(assistant("hi", true)).render(80).at(-1);
    expect(hint).toContain("[copy]");
    expect(hint).not.toContain("⎘");
  });

  it("renders highlighted code blocks with the configured indent", () => {
    const lines = new AssistantBlock(assistant("```ts\nconst x = 1;\n```", true)).render(60);
    const codeLine = lines.find((l) => l.includes("const"));
    expect(codeLine).toBeDefined();
    expect(codeLine?.startsWith("  ")).toBe(true);
    expect(codeLine).toContain("\x1b[35m"); // keyword color applied
    expect(lines.at(-1)).toContain("/copy");
  });
});

describe("editorCopyKey (hotkey routing)", () => {
  it("triggers on c/y with an empty, idle editor", () => {
    expect(editorCopyKey("c", { text: "", autocomplete: false, busy: false })).toBe(true);
    expect(editorCopyKey("y", { text: "", autocomplete: false, busy: false })).toBe(true);
    expect(editorCopyKey("C", { text: "", autocomplete: false, busy: false })).toBe(true);
    expect(editorCopyKey("Y", { text: "", autocomplete: false, busy: false })).toBe(true);
  });

  it("never triggers with non-empty input, autocomplete or a running turn", () => {
    expect(editorCopyKey("c", { text: "x", autocomplete: false, busy: false })).toBe(false);
    expect(editorCopyKey("c", { text: "", autocomplete: true, busy: false })).toBe(false);
    expect(editorCopyKey("c", { text: "", autocomplete: false, busy: true })).toBe(false);
    expect(editorCopyKey("x", { text: "", autocomplete: false, busy: false })).toBe(false);
  });
});

describe("markdownTheme", () => {
  it("styles headings bold bright cyan", () => {
    const styled = markdownTheme.heading("Title");
    expect(styled).toContain("\x1b[1m"); // bold
    expect(styled).toContain("\x1b[96m"); // bright cyan
  });
});
