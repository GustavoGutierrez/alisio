/**
 * The web app shell must never scroll the page: the viewport-sized shell cannot be scrolled even
 * programmatically (focus(), scrollIntoView(), a screen reader), and the absolutely positioned
 * screen-reader live regions inside the transcript stay anchored inside it. The web tests have no
 * DOM, so this checks the CSS contract that was verified in Chromium.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = (path: string) => readFileSync(`packages/web/src/${path}`, "utf8");
const rule = (source: string, selector: string) => {
  const start = source.indexOf(`${selector} {`);
  expect(start, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("}", start));
};

describe("web app shell layout", () => {
  it("fills the dynamic viewport with a vh fallback and clips instead of scrolling", () => {
    const app = rule(css("app.module.css"), ".app");
    expect(app).toMatch(/height: 100vh;\s*height: 100dvh;/);
    expect(app).toMatch(/overflow: hidden;\s*[^}]*overflow: clip;/);
    expect(app).toMatch(/position: relative/);
  });

  it("does not let the document scroll", () => {
    const base = css("styles/base.css");
    expect(rule(base, "html,\nbody")).toMatch(/overflow: hidden/);
    expect(rule(base, "html,\nbody")).toMatch(/overscroll-behavior: none/);
  });

  it("anchors the run status live region inside the transcript scroller", () => {
    expect(rule(css("components/transcript/transcript.module.css"), ".runStatus")).toMatch(
      /position: relative/,
    );
  });
});
