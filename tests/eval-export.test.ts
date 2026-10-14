/** `buildExportBundle` (specs/010 5.4, D9): a shareable bundle without absolute paths or secrets. */
import type { EvalReport } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { parseReport } from "../packages/core/src/eval/compare.ts";
import {
  buildExportBundle,
  EvalExportRefusedError,
  type ExportContext,
} from "../packages/core/src/eval/export.ts";
import { buildReport, renderReportMarkdown } from "../packages/core/src/eval/report.ts";
import { record, runsOf } from "./eval-helpers.ts";

const FAKE_KEY = "sk-ant-api03-ABCDEFGHIJKLMNOP1234567890";
const ctx: ExportContext = {
  roots: [
    { path: "/home/alice", placeholder: "<home>" },
    { path: "/home/alice/.local/state/alisio", placeholder: "<state>" },
    { path: "/home/alice/.local/state/alisio/eval/r1", placeholder: "<run-dir>" },
    { path: "/tmp", placeholder: "<tmp>" },
  ],
};

function input(overrides: Parameters<typeof record>[0] = {}) {
  const runs = runsOf("t1", ["pass", "fail"], () => overrides);
  const report = buildReport(runs);
  return { report, runs, markdown: renderReportMarkdown(report) };
}

describe("buildExportBundle", () => {
  it("wraps report, runs and markdown in a schemaVersion 1 bundle with equal numbers", () => {
    const source = input();
    const bundle = buildExportBundle(source, ctx);
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.runs).toHaveLength(2);
    expect(parseReport(bundle.report)).toEqual(source.report);
    expect(bundle.markdown).toBe(source.markdown);
  });

  it("replaces known roots and any other absolute path with placeholders", () => {
    const detail =
      "missing /home/alice/.local/state/alisio/eval/r1/x.txt, in /tmp/alisio-eval-9/w/a.ts, also /opt/other/dir/f and C:\\Users\\bob\\proj\\f.ts; see https://example.com/a/b";
    const bundle = buildExportBundle(
      input({ verifiers: [{ id: "v", status: "fail", detail }] }),
      ctx,
    );
    const raw = JSON.stringify(bundle);
    expect(raw).not.toContain("/home/alice");
    expect(raw).not.toContain("/tmp/");
    expect(raw).not.toContain("/opt/other");
    expect(raw).not.toContain("C:\\\\Users");
    expect(bundle.runs[0]?.verifiers[0]?.detail).toContain("<run-dir>/x.txt");
    expect(bundle.runs[0]?.verifiers[0]?.detail).toContain("https://example.com/a/b");
  });

  it("refuses on a secret and names the field path, never the value", () => {
    const source = input({ verifiers: [{ id: "v", status: "fail", detail: `key ${FAKE_KEY}` }] });
    let error: unknown;
    try {
      buildExportBundle(source, ctx);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EvalExportRefusedError);
    const message = (error as Error).message;
    expect(message).toContain("runs[0].verifiers[0].detail");
    expect(message).not.toContain(FAKE_KEY);
  });

  it("refuses exact credential values and scans the markdown too", () => {
    const source = { ...input(), markdown: "# report\nleaked hunter2hunter2 here" };
    expect(() => buildExportBundle(source, { ...ctx, secrets: ["hunter2hunter2"] })).toThrow(
      /markdown/,
    );
  });

  it("reduces a provider id that embeds an endpoint host, everywhere", () => {
    const host = "llm.internal.example.com:8443";
    const bundle = buildExportBundle(input({ provider: `openai-compatible@${host}` }), ctx);
    const raw = JSON.stringify(bundle);
    expect(raw).not.toContain("internal.example.com");
    expect(bundle.runs[0]?.provider).toBe("custom-endpoint");
    expect((bundle.report as EvalReport).conditions.provider).toBe("custom-endpoint");
  });

  it("keeps a plain provider id", () => {
    const bundle = buildExportBundle(input({ provider: "openai-compatible" }), ctx);
    expect(bundle.runs[0]?.provider).toBe("openai-compatible");
  });
});
