import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "../packages/core/src/documents/svg-sanitize.ts";

const ok = (src: string) => {
  const r = sanitizeSvg(src);
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  return r.svg;
};
const bad = (src: string) => {
  const r = sanitizeSvg(src);
  if (r.ok) throw new Error(`expected rejection, got: ${r.svg}`);
  return r.reason;
};
const wrap = (inner: string, attrs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${inner}</svg>`;

describe("sanitizeSvg (spec 026 §5.7.3)", () => {
  it("keeps shapes, groups, gradients and fragment references", () => {
    const out = ok(
      `<?xml version="1.0"?><!-- c --><svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20" role="img" aria-label="Logo"><title>Logo</title><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><g fill="url(#g)" fill-rule="evenodd" transform="translate(1 2)"><path d="M0,0 L10,10Z"/><rect x="1" y="1" width="3" height="3" rx="1"/></g><use href="#g"/></svg>`,
    );
    expect(out).toContain('viewBox="0 0 40 20"');
    expect(out).toContain('<linearGradient id="g">');
    expect(out).toContain('fill="url(#g)"');
    expect(out).toContain('<use href="#g"/>');
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(out).not.toContain("<?xml");
    expect(out).not.toContain("<!--");
  });

  it("rejects scripts, foreignObject, event handlers and unknown elements", () => {
    expect(bad(wrap("<script>alert(1)</script>"))).toMatch(/script/);
    expect(bad(wrap("<foreignObject><div/></foreignObject>"))).toMatch(/foreignObject/);
    expect(bad(wrap('<rect onclick="x()" width="1" height="1"/>'))).toMatch(/onclick/);
    expect(bad(wrap('<rect onload="x()" width="1" height="1"/>'))).toMatch(/onload/);
    expect(bad(wrap('<a href="https://evil.test"><rect width="1" height="1"/></a>'))).toMatch(/a/);
    expect(bad(wrap('<iframe src="x"/>'))).toMatch(/iframe/);
    expect(bad(wrap('<animate attributeName="href" to="javascript:1"/>'))).toMatch(/animate/);
  });

  it("rejects external references in href, xlink:href, url() and style", () => {
    expect(bad(wrap('<use href="https://evil.test/a.svg#x"/>'))).toMatch(/href/);
    expect(bad(wrap('<use xlink:href="//evil.test/a.svg#x"/>'))).toMatch(/href/);
    expect(bad(wrap('<image href="https://evil.test/a.png"/>'))).toMatch(/href/);
    expect(bad(wrap('<image href="data:image/svg+xml;base64,AAAA"/>'))).toMatch(/href/);
    expect(bad(wrap('<rect fill="url(https://evil.test/x)"/>'))).toMatch(/url/);
    expect(bad(wrap('<rect style="fill:url(http://evil.test/x)"/>'))).toMatch(/url/);
    expect(bad(wrap('<rect style="background:expression(alert(1))"/>'))).toMatch(/style/);
    expect(bad(wrap("<style>@import url(https://evil.test/a.css);</style>"))).toMatch(/style/);
    expect(bad(wrap("<style>rect{fill:url(https://evil.test/x)}</style>"))).toMatch(/style/);
    expect(bad(wrap('<rect fill="javascript:alert(1)"/>'))).toMatch(/javascript/);
  });

  it("allows raster data URIs on image and safe inline styles", () => {
    const out = ok(
      wrap(
        '<image href="data:image/png;base64,iVBORw0KGgo=" width="2" height="2"/><style>.a{fill:#cc5500;stroke:url(#g)}</style><rect class="a" style="fill:#224466" width="1" height="1"/>',
      ),
    );
    expect(out).toContain("data:image/png;base64,iVBORw0KGgo=");
    expect(out).toContain(".a{fill:#cc5500;stroke:url(#g)}");
    expect(out).toContain('style="fill:#224466"');
  });

  it("rejects DOCTYPE, entities, CDATA and processing instructions beyond the XML declaration", () => {
    expect(bad(`<!DOCTYPE svg [<!ENTITY x "y">]>${wrap("<text>&x;</text>")}`)).toMatch(/DOCTYPE/);
    expect(bad(wrap("<text>&xxe;</text>"))).toMatch(/entity/);
    expect(bad(wrap("<![CDATA[x]]>"))).toMatch(/CDATA/);
    expect(bad(`<?xml-stylesheet href="x"?>${wrap("")}`)).toMatch(/processing/);
  });

  it("rejects non-SVG roots, malformed markup, foreign namespaces and oversize input", () => {
    expect(bad("<html></html>")).toMatch(/svg/);
    expect(bad("<svg><g></svg>")).toMatch(/malformed/);
    expect(bad(wrap('<svg:rect xmlns:svg="http://www.w3.org/2000/svg"/>'))).toMatch(/namespace/);
    expect(bad(`<svg xmlns="http://www.w3.org/2000/svg">${"<g/>".repeat(21_000)}</svg>`)).toMatch(
      /elements/,
    );
    expect(
      bad(`<svg xmlns="http://www.w3.org/2000/svg">${"a".repeat(2.1 * 1024 * 1024)}</svg>`),
    ).toMatch(/larger/);
  });

  it("escapes text content and attribute values", () => {
    const out = ok(wrap('<text x="1" y="1">a &lt; b &amp; c</text><title>"q"</title>'));
    expect(out).toContain("a &lt; b &amp; c");
    expect(out).not.toMatch(/<text[^>]*>[^<]*<[a-z]/i);
  });
});
