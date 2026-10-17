import type { Message } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  attributionKeys,
  referencedPaths,
  UsageLedger,
  usedRatio,
} from "../packages/core/src/context/usage.ts";
import { describeCall } from "../packages/core/src/context/util.ts";

const WS = "/ws";
const NONE: ReadonlySet<string> = new Set();

const user = (text: string): Message => ({ role: "user", text });
const asst = (calls: Array<[string, string, object | string]> = []): Message => ({
  role: "assistant",
  text: "",
  calls: calls.map(([id, name, args]) => ({
    id,
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
  })),
});
const result = (callId: string, text: string, isError = false): Message => ({
  role: "tool",
  callId,
  result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) },
});
const exchange = (id: string, name: string, args: object | string, out = "ok", isError = false) => [
  asst([[id, name, args]]),
  result(id, out, isError),
];
const readOut = (path: string) => JSON.stringify({ path, sha256: "a".repeat(64), content: "1: x" });
const listOut = (files: string[]) => JSON.stringify({ files, nextOffset: null, truncated: false });
const searchOut = (paths: string[]) =>
  JSON.stringify({
    exitCode: 0,
    stdout: [
      ...paths.map((p) =>
        JSON.stringify({ type: "match", data: { path: { text: p }, lines: { text: "x" } } }),
      ),
      JSON.stringify({ type: "summary", data: { elapsed_total: { nanos: 1 } } }),
    ].join("\n"),
    stderr: "",
    truncated: false,
  });

const ledger = (extra: Partial<ConstructorParameters<typeof UsageLedger>[0]> = {}) =>
  new UsageLedger({ workspace: WS, ...extra });

describe("usage ledger", () => {
  it("T1: a read followed by an edit of the same path counts as used", () => {
    const l = ledger();
    const h1 = [
      user("go"),
      ...exchange("c1", "read_file", { path: "src/a.ts" }, readOut("src/a.ts")),
    ];
    l.record(1, h1, NONE);
    const h2 = [...h1, ...exchange("c2", "edit_file", { path: "src/a.ts" })];
    l.record(2, h2, NONE);
    const s = l.summary();
    expect(s.observed).toBe(1);
    expect(s.used).toBe(1);
    expect(s.byTool.read_file).toEqual({ observed: 1, used: 1 });
    expect(s.byKind.tool_result).toEqual({ observed: 1, used: 1 });
    expect(usedRatio({ observed: s.observed, used: s.used })).toBe(1);
  });

  it("T2: a result observed only in the latest request is pending, not in the ratio", () => {
    const l = ledger();
    l.record(
      1,
      [user("go"), ...exchange("c1", "read_file", { path: "a.ts" }, readOut("a.ts"))],
      NONE,
    );
    const s = l.summary();
    expect(s.pending).toBe(1);
    expect(s.observed).toBe(0);
    expect(s.byTool).toEqual({});
    expect(usedRatio({ observed: 0, used: 0 })).toBeUndefined();
  });

  it("T3: re-reading the same path is not use and is counted as a re-read", () => {
    const l = ledger();
    const h1 = [user("go"), ...exchange("c1", "read_file", { path: "a.ts" }, readOut("a.ts"))];
    l.record(1, h1, NONE);
    const h2 = [...h1, ...exchange("c2", "read_file", { path: "./a.ts" }, readOut("a.ts"))];
    l.record(2, h2, NONE);
    const s = l.summary();
    expect(s.used).toBe(0);
    expect(s.observed).toBe(1);
    expect(s.rereads).toBe(1);
    // Seeing the same history again must not count the re-read twice.
    l.record(3, h2, NONE);
    expect(l.summary().rereads).toBe(1);
  });

  it("T4: search_text keys come from the match paths (workspace-relative); the path argument is ignored", () => {
    const l = ledger();
    const h1 = [
      user("go"),
      ...exchange(
        "c1",
        "search_text",
        { pattern: "x", path: "." },
        searchOut([`${WS}/src/a.ts`, `${WS}/src/b.ts`]),
      ),
    ];
    l.record(1, h1, NONE);
    const h2 = [
      ...h1,
      ...exchange("c2", "search_text", { pattern: "y", path: "." }, searchOut([])),
    ];
    l.record(2, h2, NONE);
    expect(l.summary().used).toBe(0);
    const h3 = [...h2, ...exchange("c3", "read_file", { path: "src/b.ts" }, readOut("src/b.ts"))];
    l.record(3, h3, NONE);
    const s = l.summary();
    expect(s.byTool.search_text).toEqual({ observed: 1, used: 1 });
    expect(s.rereads).toBe(0);
  });

  it("T5: list_files keys come from the listed files; editing one of them is use", () => {
    const l = ledger();
    const h1 = [
      user("go"),
      ...exchange("c1", "list_files", { path: "src" }, listOut(["src/a.ts", "src/b.ts"])),
    ];
    l.record(1, h1, NONE);
    l.record(2, [...h1, ...exchange("c2", "edit_file", { path: "src/b.ts" })], NONE);
    expect(l.summary().byTool.list_files).toEqual({ observed: 1, used: 1 });
  });

  it("T6: paths are normalized to the workspace without case folding", () => {
    const keys = (path: string) =>
      attributionKeys(describeCall("read_file", JSON.stringify({ path })), "", WS);
    expect(keys("./src/a.ts")).toEqual(["src/a.ts"]);
    expect(keys("src/a.ts")).toEqual(["src/a.ts"]);
    expect(keys(`${WS}/src/a.ts`)).toEqual(["src/a.ts"]);
    expect(keys("src//dir/")).toEqual(["src/dir"]);
    expect(keys("/other/src/a.ts")).toEqual(["/other/src/a.ts"]);
    expect(keys("SRC/a.ts")).toEqual(["SRC/a.ts"]);
    expect(keys(`${WS}-two/a.ts`)).toEqual([`${WS}-two/a.ts`]);
  });

  it("T7: run_process commands use observed paths with path-boundary matching", () => {
    const run = (key: string, args: object) => {
      const l = ledger();
      const h1 = [user("go"), ...exchange("c1", "read_file", { path: key }, readOut(key))];
      l.record(1, h1, NONE);
      l.record(2, [...h1, ...exchange("c2", "run_process", args)], NONE);
      return l.summary().used;
    };
    expect(run("src/a.test.ts", { command: "vitest", args: ["src/a.test.ts"] })).toBe(1);
    expect(run("src/a.test.ts", { command: "vitest", args: ["--root=src/a.test.ts"] })).toBe(1);
    expect(run("a.ts", { command: "vitest", args: ["data.ts"] })).toBe(0);
    expect(run("a.ts", { command: "vitest", args: ["src/a.ts"] })).toBe(0);
    expect(run("a.ts", { command: "vitest", args: ["a.tsx"] })).toBe(0);
    expect(run("a.ts", { command: "sh", args: ["-c", "cat 'a.ts'; true"] })).toBe(1);
    expect(
      referencedPaths(describeCall("shell", JSON.stringify({ command: "ls a.ts" })), WS).command,
    ).toBe("ls a.ts");
  });

  it("T8: results that cannot be attributed never enter a ratio", () => {
    const l = ledger();
    const h1 = [
      user("go"),
      ...exchange("c1", "bg_output", { id: "t1" }, "{}"),
      ...exchange("c2", "webfetch", { url: "https://x.test" }, "page"),
      ...exchange("c3", "read_file", { path: "a.ts" }, "File not found", true),
    ];
    l.record(1, h1, NONE);
    l.record(2, [...h1, asst(), user("later")], NONE);
    const s = l.summary();
    expect(s.unattributed).toBe(3);
    expect(s.observed).toBe(0);
    expect(s.pending).toBe(0);
    expect(s.byTool).toEqual({});
  });

  it("T9: a result first seen as a stub is stub-only; one elided after being seen stays observed", () => {
    const l = ledger();
    const h1 = [
      user("go"),
      ...exchange("c1", "read_file", { path: "a.ts" }, readOut("a.ts")),
      ...exchange("c2", "read_file", { path: "b.ts" }, readOut("b.ts")),
    ];
    l.record(1, h1, new Set(["c2"]));
    l.record(2, [...h1, asst(), user("x")], new Set(["c1", "c2"]));
    const s = l.summary();
    expect(s.stubOnly).toBe(1);
    expect(s.observed).toBe(1);
    expect(s.pending).toBe(0);
    expect(s.byTool.read_file?.observed).toBe(1);
  });

  it("T10: a compaction restart neither double counts nor forgets entries", () => {
    const l = ledger();
    const h1 = [user("go"), ...exchange("c1", "read_file", { path: "a.ts" }, readOut("a.ts"))];
    l.record(1, h1, NONE);
    const h2 = [...h1, ...exchange("c2", "edit_file", { path: "a.ts" })];
    l.record(2, h2, NONE);
    const after = l.summary();
    const compacted: Message[] = [
      { role: "user", text: "checkpoint", summary: true },
      ...exchange("c3", "read_file", { path: "b.ts" }, readOut("b.ts")),
    ];
    l.record(3, compacted, NONE);
    l.record(4, compacted, NONE);
    const s = l.summary();
    expect(after.used).toBe(1);
    expect(s.used).toBe(1);
    expect(s.observed).toBe(2);
    expect(s.byTool.read_file).toEqual({ observed: 2, used: 1 });
  });

  it("T11: the summary is deterministic and sorted by tool name", () => {
    const build = () => {
      const l = ledger();
      const h1 = [
        user("go"),
        ...exchange("c1", "search_text", { pattern: "x" }, searchOut(["z.ts"])),
        ...exchange("c2", "read_file", { path: "a.ts" }, readOut("a.ts")),
        ...exchange("c3", "list_files", {}, listOut(["q.ts"])),
      ];
      l.record(1, h1, NONE);
      l.record(2, [...h1, ...exchange("c4", "edit_file", { path: "a.ts" })], NONE);
      return l.summary();
    };
    const a = build();
    expect(build()).toEqual(a);
    expect(Object.keys(a.byTool)).toEqual(["list_files", "read_file", "search_text"]);
  });

  it("T12: caps evict the oldest entries and count them; keys are capped", () => {
    const l = ledger({ maxEntries: 3, maxKeysPerEntry: 2 });
    let h: Message[] = [user("go")];
    for (let i = 1; i <= 5; i++) {
      h = [...h, ...exchange(`c${i}`, "read_file", { path: `f${i}.ts` }, readOut(`f${i}.ts`))];
      l.record(i, h, NONE);
    }
    l.record(6, [...h, asst(), user("x")], NONE);
    const s = l.summary();
    expect(s.evicted).toBe(2);
    expect(s.observed + s.pending).toBe(3);
    const k = attributionKeys(
      describeCall("list_files", "{}"),
      listOut(["a", "b", "c", "d"]),
      WS,
      undefined,
      2,
    );
    expect(k).toEqual(["a", "b"]);
  });

  it("T13: a call is never use of its own result; bad arguments and throwing pathsOf are ignored", () => {
    const l = ledger({
      pathsOf: (tool) => {
        if (tool === "boom") throw new Error("x");
        return undefined;
      },
    });
    const h1 = [user("go"), ...exchange("c1", "read_file", { path: "a.ts" }, readOut("a.ts"))];
    l.record(1, h1, NONE);
    const h2 = [
      ...h1,
      ...exchange("c2", "edit_file", "{not json"),
      ...exchange("c3", "boom", { path: "a.ts" }),
    ];
    expect(() => l.record(2, h2, NONE)).not.toThrow();
    // `boom` still names its args.path, which is a reference to a.ts.
    expect(l.summary().used).toBe(1);
    const own = ledger();
    own.record(
      1,
      [user("go"), ...exchange("c1", "read_file", { path: "a.ts" }, readOut("a.ts"))],
      NONE,
    );
    own.record(
      2,
      [user("go"), ...exchange("c1", "read_file", { path: "a.ts" }, readOut("a.ts"))],
      NONE,
    );
    expect(own.summary().used).toBe(0);
  });
});
