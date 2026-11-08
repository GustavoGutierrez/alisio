import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parsePrintRequest,
  parsePrintResult,
  resolveBundleFile,
} from "../apps/desktop/src/print-protocol.ts";

const root = join("/", "tmp", "alisio-print-root");
const request = (over: Record<string, unknown> = {}) => ({
  type: "print",
  id: "r1",
  bundleDir: join(root, "r1"),
  entry: "index.html",
  options: {
    contentWidthMm: 158,
    tagged: true,
    measure: true,
    timeoutMs: 60_000,
  },
  ...over,
});

describe("print request validation (spec 026 D7)", () => {
  it("accepts a well-formed request whose bundle is inside the print root", () => {
    expect(parsePrintRequest(request(), root)).toMatchObject({ type: "print", id: "r1" });
  });

  it("rejects a bundle outside the print root, a traversal entry and bad ids or options", () => {
    const bad = [
      request({ bundleDir: "/etc" }),
      request({ bundleDir: join(root, "..", "x") }),
      request({ bundleDir: "relative/dir" }),
      request({ bundleDir: root }),
      request({ entry: "../index.html" }),
      request({ entry: "/abs.html" }),
      request({ entry: "https://evil.test/" }),
      request({ id: "" }),
      request({ id: "a b" }),
      request({ id: "x".repeat(80) }),
      request({ options: { ...request().options, contentWidthMm: -1 } }),
      request({ options: { ...request().options, contentWidthMm: 99_999 } }),
      request({ options: { ...request().options, timeoutMs: 10 * 60_000 } }),
      request({ options: { ...request().options, tagged: "yes" } }),
      request({ type: "other" }),
      null,
      "print",
    ];
    for (const value of bad)
      expect(parsePrintRequest(value, root), JSON.stringify(value)).toBeUndefined();
  });
});

describe("print result validation", () => {
  it("accepts ok and error results and bounds the error text", () => {
    expect(
      parsePrintResult({
        type: "print-result",
        id: "r1",
        ok: true,
        pdfPath: join(root, "r1", "out.pdf"),
      }),
    ).toMatchObject({ ok: true });
    const err = parsePrintResult({
      type: "print-result",
      id: "r1",
      ok: false,
      error: "x".repeat(5000),
    });
    expect(err?.ok === false && err.error.length).toBe(500);
    expect(parsePrintResult({ type: "print-result", id: "r1" })).toBeUndefined();
    expect(parsePrintResult({ type: "ready" })).toBeUndefined();
  });

  it("keeps only well-formed measurements", () => {
    const m = parsePrintResult({
      type: "print-result",
      id: "r1",
      ok: true,
      pdfPath: "/x/out.pdf",
      measurements: {
        overflow: [{ block: 1, tag: "div", overflowPx: 5 }, { bad: 1 }],
        lowDpi: [{ src: "a", dpi: 90 }],
      },
    });
    expect(m?.ok && m.measurements).toEqual({
      overflow: [{ block: 1, tag: "div", overflowPx: 5 }],
      lowDpi: [{ src: "a", dpi: 90 }],
    });
  });
});

describe("resolveBundleFile (network off, virtual origin)", () => {
  const dir = join(root, "r1");
  it("serves files of the bundle from the virtual origin only", () => {
    expect(resolveBundleFile(dir, "https://document.invalid/css/theme.css")).toBe(
      join(dir, "css", "theme.css"),
    );
    expect(resolveBundleFile(dir, "https://document.invalid/a%20b.png")).toBe(join(dir, "a b.png"));
  });
  it("refuses other hosts, schemes, traversal and malformed URLs", () => {
    for (const url of [
      "https://evil.test/a.css",
      "http://document.invalid/a.css",
      "https://document.invalid.evil.test/a",
      "https://document.invalid/..%2fsecret",
      "file:///etc/passwd",
      "not a url",
    ])
      expect(resolveBundleFile(dir, url), url).toBeUndefined();
  });
});
