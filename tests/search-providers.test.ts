import { afterEach, describe, expect, it, vi } from "vitest";
import {
  duckDuckGoHtmlProvider,
  parseDuckDuckGoLiteHtml,
  searchWithFallback,
} from "../packages/core/src/tools/search.ts";

afterEach(() => vi.unstubAllGlobals());

/**
 * Fixture modeled on the verified DuckDuckGo lite response shape (2026-09): `result-link` anchors
 * whose href goes through `//duckduckgo.com/l/?uddg=<urlencoded>&amp;rut=...` (note the single
 * quotes on the class attributes), snippets in the following `result-snippet` cell, and result
 * rows inside `<div class='result'>` blocks. The ads/related section at the end must be ignored.
 */
const RESULTS_HTML = `<!DOCTYPE html>
<html>
<head><title>node.js web framework - DuckDuckGo</title></head>
<body>
  <form action="/lite/" method="post"><input class='query' type="text" name="q"></form>
  <div id="links">
    <div class='result'>
      <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexpressjs.com%2F&amp;rut=abc1" class='result-link'>Express.js &#x27;Fast&#x27; &amp; unopinionated</a>
      <table><tr><td class='result-snippet'>A <b>fast</b>, unopinionated, minimalist <b>web framework</b> for <b>Node.js</b>.</td></tr></table>
    </div>
    <div class='result'>
      <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.w3schools.com%2Fnodejs%2Fnodejs_frameworks.asp&amp;rut=abc2" class='result-link'>Node.js Frameworks - W3Schools</a>
      <table><tr><td class='result-snippet'>Why Use a Framework? Node.js frameworks provide structure &amp; utilities for building <b>web</b> apps.</td></tr></table>
    </div>
    <div class='result'>
      <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fnodejs%2Fnode&amp;rut=abc3" class='result-link'>GitHub - nodejs/node</a>
      <table><tr><td class='result-snippet'>Node.js JavaScript runtime :sparkles:.</td></tr></table>
    </div>
    <div class='result'>
      <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdeno.com%2F&amp;rut=abc4" class='result-link'>Deno</a>
      <table><tr><td class='result-snippet'>A modern runtime, sometimes compared to Node.js.</td></tr></table>
    </div>
  </div>
  <div id="ads">
    <a rel="nofollow" href="https://ad.example.com/sponsored" class='result-link'>Sponsored result</a>
    <a class='non-result' href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fevil.example.com%2F&amp;rut=zzz">Related search</a>
    <a href="#top">Back to top</a>
  </div>
</body>
</html>`;

/** A bot-check/captcha challenge page (the shape html.duckduckgo.com returns on HTTP 202). */
const CHALLENGE_HTML = `<!DOCTYPE html>
<html>
<head><meta http-equiv="refresh" content="0;url='https://html.duckduckgo.com/html/?q=node'"></head>
<body><h1>AnomalyDetection</h1><p>Sorry, you have been blocked. You are unable to access duckduckgo.com.</p></body>
</html>`;

/** A legitimate lite page with the search form but zero results: must yield []. */
const EMPTY_HTML = `<!DOCTYPE html>
<html>
<head><title>no results - DuckDuckGo</title></head>
<body>
  <form action="/lite/" method="post">
    <input class='query' type="text" size="40" name="q" value="qqqqzzzz">
    <input class='submit' type="submit" value="Search">
  </form>
  <p class='extra'>&nbsp;</p>
</body>
</html>`;

const ok = (body: string) =>
  new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });

describe("parseDuckDuckGoLiteHtml", () => {
  it("extracts 3+ results with decoded uddg URLs", () => {
    const results = parseDuckDuckGoLiteHtml(RESULTS_HTML);
    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results[0]?.url).toBe("https://expressjs.com/");
    expect(results[1]?.url).toBe("https://www.w3schools.com/nodejs/nodejs_frameworks.asp");
    expect(results[2]?.url).toBe("https://github.com/nodejs/node");
  });

  it("decodes HTML entities in titles", () => {
    const results = parseDuckDuckGoLiteHtml(RESULTS_HTML);
    // &#x27; -> ' and &amp; -> &; trailing dots are part of the title as given.
    expect(results[0]?.title).toBe("Express.js 'Fast' & unopinionated");
    expect(results[1]?.title).toBe("Node.js Frameworks - W3Schools");
    expect(results[2]?.title).toBe("GitHub - nodejs/node");
  });

  it("extracts and cleans the snippet text", () => {
    const results = parseDuckDuckGoLiteHtml(RESULTS_HTML);
    expect(results[0]?.snippet).toBe(
      "A fast, unopinionated, minimalist web framework for Node.js.",
    );
    expect(results[1]?.snippet).toBe(
      "Why Use a Framework? Node.js frameworks provide structure & utilities for building web apps.",
    );
  });

  it("ignores non-result anchors (ads, related and plain links)", () => {
    const results = parseDuckDuckGoLiteHtml(RESULTS_HTML);
    expect(results.some((r) => r.url === "https://ad.example.com/sponsored")).toBe(false);
    expect(results.some((r) => r.url === "https://evil.example.com/")).toBe(false);
    expect(results.every((r) => !/^https?:\/\/ad\.|\/evil\./.test(r.url))).toBe(true);
  });

  it("returns [] for a page without result rows", () => {
    expect(parseDuckDuckGoLiteHtml(EMPTY_HTML)).toEqual([]);
    expect(parseDuckDuckGoLiteHtml("<html><body>nothing</body></html>")).toEqual([]);
  });
});

describe("duckDuckGoHtmlProvider", () => {
  it("GETs the lite endpoint with a browser-like UA and returns parsed results", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", ((input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return Promise.resolve(ok(RESULTS_HTML));
    }) as typeof fetch);
    const results = await duckDuckGoHtmlProvider().search("node.js web framework");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://lite.duckduckgo.com/lite/?q=node.js+web+framework&kl=us-en",
    );
    const ua = (calls[0]!.init.headers as Record<string, string>)["User-Agent"] ?? "";
    expect(ua).toMatch(/Mozilla\/5\.0/);
    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results[0]?.url).toBe("https://expressjs.com/");
  });

  it("throws an actionable error on a 202/captcha response", async () => {
    vi.stubGlobal("fetch", (() =>
      Promise.resolve(new Response(CHALLENGE_HTML, { status: 202 }))) as typeof fetch);
    await expect(duckDuckGoHtmlProvider().search("node")).rejects.toThrow(/HTTP 202/);
    await expect(duckDuckGoHtmlProvider().search("node")).rejects.toThrow(/bot-check|captcha/i);
    await expect(duckDuckGoHtmlProvider().search("node")).rejects.toThrow(/DuckDuckGo lite/);
  });

  it("throws when a 200 page is not recognizable lite HTML", async () => {
    vi.stubGlobal("fetch", (() => Promise.resolve(ok(CHALLENGE_HTML))) as typeof fetch);
    await expect(duckDuckGoHtmlProvider().search("node")).rejects.toThrow(
      /bot-check|captcha|not recognizable/i,
    );
  });

  it("throws on a too-small or empty response body", async () => {
    vi.stubGlobal("fetch", (() => Promise.resolve(ok("<html></html>"))) as typeof fetch);
    await expect(duckDuckGoHtmlProvider().search("node")).rejects.toThrow(/empty response/i);
  });

  it("wraps fetch failures with provider context (no redirect following)", async () => {
    vi.stubGlobal("fetch", (() =>
      Promise.reject(
        Object.assign(new TypeError("fetch failed"), { code: "ERR_FETCH_FAILED" }),
      )) as typeof fetch);
    await expect(duckDuckGoHtmlProvider().search("node")).rejects.toThrow(
      /DuckDuckGo lite search request failed/,
    );
  });

  it("returns [] for a legitimate zero-result lite page", async () => {
    vi.stubGlobal("fetch", (() => Promise.resolve(ok(EMPTY_HTML))) as typeof fetch);
    await expect(duckDuckGoHtmlProvider().search("qqqqzzzz")).resolves.toEqual([]);
  });
});

describe("websearch provider resolution", () => {
  it("resolves duckduckgo-html through searchWithFallback with a keyless source label", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", ((input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return Promise.resolve(ok(RESULTS_HTML));
    }) as typeof fetch);
    const outcome = await searchWithFallback(
      "node",
      { provider: "duckduckgo-html" },
      undefined,
      AbortSignal.timeout(5_000),
    );
    expect(outcome.source).toBe("duckduckgo-html");
    expect(outcome.provider.id).toBe("duckduckgo-html");
    expect(outcome.limitation).toMatch(/DuckDuckGo lite/);
    expect(outcome.results.length).toBeGreaterThanOrEqual(3);
    expect(calls[0]!.url).toContain("lite.duckduckgo.com/lite/");
  });
});
