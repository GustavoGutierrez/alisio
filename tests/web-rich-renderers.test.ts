import { describe, expect, it, vi } from "vitest";
import { katex } from "../packages/web/src/renderers/math/katex.ts";
import { KATEX_OPTIONS, renderMath } from "../packages/web/src/renderers/math/render.ts";
import {
  type MermaidEngine,
  mermaidConfig,
  renderMermaid,
} from "../packages/web/src/renderers/mermaid/render.ts";

// T-17 (phase 5): the Mermaid and KaTeX renderers never break a message; bad input falls back
// to the source with the error.
describe("math renderer", () => {
  it("renders TeX with KaTeX, untrusted and without throwing", () => {
    expect(KATEX_OPTIONS).toMatchObject({ throwOnError: false, trust: false });
    expect(KATEX_OPTIONS.maxExpand).toBeLessThanOrEqual(1000);
    const out = renderMath(katex, "\\frac{a}{b} + x^2", true);
    expect("html" in out && out.html).toContain("katex-display");
    const inline = renderMath(katex, "x^2", false);
    expect("html" in inline && inline.html).not.toContain("katex-display");
  });

  it("falls back to the source and the parse error for malformed TeX", () => {
    const out = renderMath(katex, "\\frac{a", true);
    expect(out).toMatchObject({ error: expect.stringMatching(/KaTeX parse error/i) });
    expect("html" in out).toBe(false);
  });

  it("never emits links or scripts from untrusted commands", () => {
    const out = renderMath(katex, "\\href{javascript:alert(1)}{x} \\url{javascript:y}", false);
    const html = "html" in out ? out.html : "";
    expect(html).not.toMatch(/href="javascript/i);
    expect(html).not.toMatch(/<script/i);
  });

  it("reports an unexpected engine failure as an error instead of throwing", () => {
    const broken = {
      renderToString: () => {
        throw new Error("boom");
      },
    };
    expect(renderMath(broken, "x", true)).toEqual({ error: "boom" });
  });
});

describe("mermaid renderer", () => {
  it("configures Mermaid in strict mode without HTML labels", () => {
    const config = mermaidConfig("dark");
    expect(config).toMatchObject({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: false,
      theme: "dark",
    });
    expect(mermaidConfig("light").theme).toBe("default");
  });

  it("sanitizes the SVG the engine produces", async () => {
    const engine: MermaidEngine = {
      parse: vi.fn(async () => true),
      render: vi.fn(async () => ({ svg: '<svg><script>x</script><g id="n"/></svg>' })),
    };
    const sanitize = vi.fn((svg: string) => svg.replace(/<script>.*?<\/script>/g, ""));
    const out = await renderMermaid(engine, "m1", "graph TD; A-->B", sanitize);
    expect(sanitize).toHaveBeenCalledOnce();
    expect(out).toEqual({ svg: '<svg><g id="n"/></svg>' });
  });

  it("falls back to the source and the error for an invalid diagram", async () => {
    const engine: MermaidEngine = {
      parse: async () => {
        throw new Error("Parse error on line 1: expecting 'NEWLINE'");
      },
      render: vi.fn(async () => ({ svg: "<svg/>" })),
    };
    const out = await renderMermaid(engine, "m2", "graph ??", (s) => s);
    expect(out).toEqual({ error: "Parse error on line 1: expecting 'NEWLINE'" });
    expect(engine.render).not.toHaveBeenCalled();
  });

  it("treats an empty sanitized result as an error", async () => {
    const engine: MermaidEngine = {
      parse: async () => true,
      render: async () => ({ svg: "<svg/>" }),
    };
    const out = await renderMermaid(engine, "m3", "graph TD; A", () => "");
    expect(out).toMatchObject({ error: expect.any(String) });
  });
});
