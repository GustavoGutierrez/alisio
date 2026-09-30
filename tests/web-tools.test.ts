import { describe, expect, it } from "vitest";
import { prettyArgs, toolLabel, toolPath, toolSummary } from "../packages/web/src/util/tools.ts";

describe("tool rows", () => {
  it("names tools like the reference (Read, Shell) and humanizes unknown ones", () => {
    expect(toolLabel("read_file")).toBe("Read");
    expect(toolLabel("run_process")).toBe("Shell");
    expect(toolLabel("wayfinder:explore_repo")).toBe("Wayfinder explore repo");
  });

  it("summarizes calls from their most telling argument, on one bounded line", () => {
    expect(toolSummary('{"path":"README.md"}')).toBe("README.md");
    expect(toolSummary('{"command":"ls -la","description":"List files"}')).toBe("List files");
    expect(toolSummary('{"command":["git","status"]}')).toBe("git status");
    expect(toolSummary('{"x":"multi\\nline   text"}')).toBe("multi line text");
    expect(toolSummary(`{"query":"${"a".repeat(300)}"}`, 20)).toHaveLength(20);
    expect(toolSummary("not json")).toBe("not json");
    expect(toolSummary("{}")).toBe("");
  });

  it("extracts path arguments and pretty-prints JSON input", () => {
    expect(toolPath('{"file_path":"src/a.ts"}')).toBe("src/a.ts");
    expect(toolPath('{"command":"ls"}')).toBeUndefined();
    expect(prettyArgs('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyArgs("raw")).toBe("raw");
  });
});
