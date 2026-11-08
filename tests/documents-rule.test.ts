import { describe, expect, it } from "vitest";
import { buildDocumentRule, DOCUMENT_RULE_MAX_CHARS } from "../packages/core/src/documents/rule.ts";
import {
  buildRoutingRule,
  ROUTING_RULE_MAX_CHARS,
} from "../packages/core/src/forge/routing-rule.ts";

describe("routing (DOC-AC-21)", () => {
  it("keeps the code-execution section within 900 characters and no longer routes designed PDFs to python_run", () => {
    const rule = buildRoutingRule({
      javascript: true,
      python: true,
      guide: true,
      scratchpad: "/tmp/p",
    });
    expect(rule.length).toBeLessThanOrEqual(ROUTING_RULE_MAX_CHARS);
    expect(rule).toMatch(/programmatic PDF/);
    expect(rule).not.toMatch(/XLSX\/DOCX\/PDF/);
  });

  it("builds the Documents section only when document_create exists, within 300 characters, never naming a plugin", () => {
    expect(buildDocumentRule({ documents: false })).toBe("");
    const rule = buildDocumentRule({ documents: true });
    expect(rule.length).toBeLessThanOrEqual(DOCUMENT_RULE_MAX_CHARS);
    expect(rule).toContain("document_create");
    expect(rule).toContain("document_themes");
    expect(rule).not.toMatch(/evalua|thesis/i);
  });
});
