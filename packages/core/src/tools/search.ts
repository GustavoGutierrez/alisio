/**
 * Pluggable web-search backends for the `websearch` standard tool. No provider is bundled as a
 * hard dependency: everything here is a plain HTTP call behind the SDK's `SearchProvider` port.
 *
 * Resolution order (see `searchWithFallback`):
 *   1. A plugin-registered `websearch` extension (`api.extensions.register("websearch", ...)`)
 *      fully replaces the built-in chain, exactly like a custom mascot replaces the default one.
 *      A throwing plugin provider falls back to the built-in chain with a diagnostic, never a hard
 *      failure of the tool call.
 *   2. `websearch.provider` from config, when set: `"searxng"` (with a custom `searxngUrl`),
 *      `"duckduckgo-instant"`, `"duckduckgo-html"`, `"tavily"`, `"brave"` or `"serpapi"` (the last
 *      three need an API key env var).
 *   3. Nothing configured: a public SearXNG instance (see `DEFAULT_SEARXNG_URL`) — genuinely free
 *      and keyless, but empirically unreliable: while building this tool, nearly every public
 *      instance tried (searx.be and several others from https://searx.space) rate-limited or
 *      bot-blocked a single fresh automated request. Treat this as a zero-config starting point
 *      to try, not something to depend on; self-hosting is one config line away
 *      (`websearch.searxngUrl`, e.g. `docker run searxng/searxng`).
 *
 * `"native"` is resolved one layer up (see `application.ts`): when configured, the `websearch`
 * tool is not registered at all, because the provider answers the search server-side as part of
 * its own response, never through this tool-execution path.
 */
import type { SearchProvider, SearchResult } from "@alisio/sdk";

export interface WebsearchConfig {
  provider?:
    | "searxng"
    | "duckduckgo-instant"
    | "duckduckgo-html"
    | "tavily"
    | "brave"
    | "serpapi"
    | "native";
  /** Overrides the default public instance; self-hosted or another public instance. */
  searxngUrl?: string;
  /** Environment variable holding the API key for `tavily`, `brave` or `serpapi`. */
  apiKeyEnv?: string;
}

/**
 * A long-running, widely mirrored public SearXNG instance (see https://searx.space for others).
 * Best-effort only: a public instance has no SLA and routinely rate-limits or bot-blocks
 * automated requests (verified empirically — see the module doc comment above).
 */
export const DEFAULT_SEARXNG_URL = "https://searx.be";

const PRIVATE_IPV4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^169\.254\./,
];
/**
 * Heuristic SSRF guard: a user-configured `searxngUrl` could point anywhere, unlike the fixed
 * built-in providers' hardcoded hosts. This is not exhaustive (no DNS-rebinding protection), but
 * it rejects the obvious cases and requires HTTPS for anything that is not clearly local/private.
 */
export function isLoopbackOrPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  if (PRIVATE_IPV4.some((re) => re.test(h))) return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // IPv6 unique local addresses
  return false;
}
export function validateSearxngUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`websearch.searxngUrl is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("websearch.searxngUrl must be http or https");
  if (url.protocol === "http:" && !isLoopbackOrPrivateHost(url.hostname))
    throw new Error(
      "websearch.searxngUrl must use https unless it targets a loopback or private host",
    );
  return url;
}

const asText = (value: unknown): string => (typeof value === "string" ? value : "");
// Some public search backends (DuckDuckGo's Instant Answer API among them) vary their response
// content-type by User-Agent; a browser-like one gets consistent JSON instead of a JSONP-flavored
// content-type for an unrecognized client.
const DEFAULT_UA =
  "Mozilla/5.0 (compatible; AlisioAgent/1.0; +https://github.com/GustavoGutierrez/alisio)";
async function getJson(
  url: URL,
  options: { signal?: AbortSignal; headers?: Record<string, string> },
) {
  const res = await fetch(url, {
    signal: options.signal,
    headers: { "User-Agent": DEFAULT_UA, ...options.headers },
  });
  if (!res.ok) throw new Error(`${url.hostname} search request failed: HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // A public SearXNG instance under bot protection answers 200 with an HTML challenge/captcha
    // page instead of JSON (some APIs, like DuckDuckGo's, also report a non-JSON content-type on
    // an otherwise-valid JSON body, so content-type alone cannot tell the two apart). A plain
    // `res.json()` call would fail here with a confusing "Unexpected token '<'"; this gives the
    // actual, actionable cause instead.
    throw new Error(
      `${url.hostname} did not return valid JSON; it may be showing a bot-check/captcha page ` +
        "instead of results. Public instances vary in how aggressively they block automated " +
        "requests — try another instance or self-host one (see websearch.searxngUrl, e.g. " +
        '"http://localhost:8080").',
    );
  }
}

export function searxngProvider(baseUrl: string): SearchProvider {
  const validated = validateSearxngUrl(baseUrl);
  return {
    id: `searxng:${validated.host}`,
    async search(query, options) {
      const url = new URL("/search", validated);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      const body = (await getJson(url, { signal: options?.signal })) as {
        results?: Array<{ title?: unknown; url?: unknown; content?: unknown }>;
      };
      return (body.results ?? [])
        .slice(0, 10)
        .map((r) => ({ title: asText(r.title), url: asText(r.url), snippet: asText(r.content) }));
    },
  };
}

/**
 * DuckDuckGo's free, keyless Instant Answer API. It only returns a result for a direct
 * factual/infobox-style query (Wikipedia-style); an ordinary "search the web for X" query
 * routinely returns nothing here even though results exist on the web — this is NOT a general
 * search engine. Callers must not treat an empty result as "nothing found on the web".
 */
export function duckDuckGoInstantProvider(): SearchProvider {
  return {
    id: "duckduckgo-instant",
    async search(query, options) {
      const url = new URL("https://api.duckduckgo.com/");
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("no_html", "1");
      url.searchParams.set("skip_disambig", "1");
      const body = (await getJson(url, { signal: options?.signal })) as {
        AbstractText?: unknown;
        AbstractURL?: unknown;
        Heading?: unknown;
        RelatedTopics?: Array<{ Text?: unknown; FirstURL?: unknown }>;
      };
      const results: SearchResult[] = [];
      if (asText(body.AbstractText))
        results.push({
          title: asText(body.Heading) || query,
          url: asText(body.AbstractURL),
          snippet: asText(body.AbstractText),
        });
      for (const topic of body.RelatedTopics ?? []) {
        const text = asText(topic.Text);
        const link = asText(topic.FirstURL);
        if (text && link)
          results.push({ title: text.split(" - ")[0] || text, url: link, snippet: text });
      }
      return results.slice(0, 10);
    },
  };
}

// --- DuckDuckGo lite (HTML) ---
// The keyless `lite.duckduckgo.com/lite/` page answers a plain GET with real, general web-search
// results (unlike the Instant Answer API). It is a scrape of HTML that DuckDuckGo may change at any
// time, so the parser below is deliberately tolerant: only `result-link` anchors whose href goes
// through the `//duckduckgo.com/l/?uddg=` redirector are trusted as results; ads/related links and
// the surrounding table/div markup are ignored. Verified live (2026-09): the full
// `html.duckduckgo.com/html/` endpoint returns HTTP 202 with a captcha challenge for automated
// requests, while `lite.duckduckgo.com/lite/` answers HTTP 200 with results and no key.
const DUCKDUCKGO_LITE_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
const DUCKDUCKGO_LITE_URL = "https://lite.duckduckgo.com/lite/";

/** Minimal local HTML-entity decoder (no dependency): the common named ones plus numeric forms. */
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos|nbsp);/g, (raw, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    if (lower === "nbsp") return "\u00a0";
    try {
      const code = lower.startsWith("#x")
        ? parseInt(lower.slice(2), 16)
        : lower.startsWith("#")
          ? parseInt(lower.slice(1), 10)
          : NaN;
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : raw;
    } catch {
      return raw;
    }
  });
}

/** Strips tags and collapses whitespace, keeping the text usable as a title or snippet. */
function htmlToText(fragment: string): string {
  return decodeHtmlEntities(fragment.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

const RESULT_LINK = /<a\b[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
const HREF_ATTR = /href\s*=\s*"([^"]*)"/i;
const SNIPPET_CELL = /class=['"]result-snippet['"]>([\s\S]*?)<\/td>/gi;
const UDDG_PARAM = /uddg=([^&"]+)/i;

/**
 * Parses DuckDuckGo lite HTML into `SearchResult`s (exported so tests can exercise it without the
 * network). Ignores every anchor that is not a `result-link` whose href starts with
 * `//duckduckgo.com/l/?uddg=` — ads and related-search links never count. Snippets are taken from
 * the `result-snippet` cell that follows each result and precedes the next one. Returns [] for a
 * lite page that legitimately has no results.
 */
export function parseDuckDuckGoLiteHtml(html: string): SearchResult[] {
  const anchors = [...html.matchAll(RESULT_LINK)];
  const snippets = [...html.matchAll(SNIPPET_CELL)];
  const results: SearchResult[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i]!;
    const tag = anchor[0];
    const href = HREF_ATTR.exec(tag)?.[1] ?? "";
    if (!href.startsWith("//duckduckgo.com/l/?uddg=")) continue;
    const raw = UDDG_PARAM.exec(href)?.[1];
    let url = "";
    if (raw) {
      try {
        url = decodeURIComponent(raw);
      } catch {
        url = "";
      }
    }
    if (!url) continue;
    const title = htmlToText(anchor[1] ?? "");
    if (!title) continue;
    let snippet = "";
    const limit = anchors[i + 1] ? anchors[i + 1]!.index : html.length;
    for (const cell of snippets) {
      if (cell.index !== undefined && cell.index > (anchor.index ?? 0) && cell.index < limit) {
        snippet = htmlToText(cell[1] ?? "");
        break;
      }
    }
    results.push({ title, url, snippet });
  }
  return results;
}

/**
 * DuckDuckGo's keyless HTML "lite" endpoint: a real general web search (unlike the Instant Answer
 * API), scraped without an API key or cookie machinery. Works when the default public SearXNG
 * instance is bot-blocked. See `parseDuckDuckGoLiteHtml` for the HTML parsing contract.
 */
export function duckDuckGoHtmlProvider(): SearchProvider {
  return {
    id: "duckduckgo-html",
    async search(query, options) {
      const url = new URL(DUCKDUCKGO_LITE_URL);
      url.searchParams.set("q", query);
      url.searchParams.set("kl", "us-en");
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { "User-Agent": DUCKDUCKGO_LITE_UA, Accept: "text/html" },
          // Never follow a redirect blindly: on this endpoint a redirect is a bot-check detour,
          // not a moved page, and following it would just land on a captcha.
          redirect: "error",
          signal: options?.signal,
        });
      } catch (error) {
        throw new Error(
          `DuckDuckGo lite search request failed: ${
            error instanceof Error ? error.message : String(error)
          }. The provider is duckduckgo-html (${DUCKDUCKGO_LITE_URL}); possible causes: a network ` +
            "failure, a redirect (treated as a bot-check detour), or rate limiting. Try again later " +
            "or switch websearch.provider via /settings.",
        );
      }
      if (res.status !== 200) {
        throw new Error(
          `DuckDuckGo lite search failed: HTTP ${res.status}. The endpoint may be showing a ` +
            "bot-check/captcha challenge instead of results (the full html.duckduckgo.com endpoint " +
            "returns HTTP 202 for automated requests). Try again later, or switch websearch.provider " +
            "via /settings (e.g. searxng with your own instance).",
        );
      }
      const html = await res.text();
      if (html.length <= 200) {
        throw new Error(
          "DuckDuckGo lite search returned an unexpectedly empty response (no HTML to parse); the " +
            "endpoint may be bot-blocked. Try again later or switch websearch.provider via /settings.",
        );
      }
      if (
        !html.includes("result-link") &&
        !html.includes("result-snippet") &&
        !/action=['"]\/lite\/['"]/.test(html)
      ) {
        throw new Error(
          "DuckDuckGo lite did not return recognizable DuckDuckGo lite HTML results; it may be " +
            "showing a bot-check/captcha challenge instead. Try again later or switch " +
            "websearch.provider via /settings.",
        );
      }
      return parseDuckDuckGoLiteHtml(html).slice(0, 10);
    },
  };
}

export function tavilyProvider(apiKey: string): SearchProvider {
  return {
    id: "tavily",
    async search(query, options) {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": DEFAULT_UA },
        body: JSON.stringify({ api_key: apiKey, query, max_results: 10 }),
        signal: options?.signal,
      });
      if (!res.ok) throw new Error(`Tavily search request failed: HTTP ${res.status}`);
      const body = (await res.json()) as {
        results?: Array<{ title?: unknown; url?: unknown; content?: unknown }>;
      };
      return (body.results ?? []).map((r) => ({
        title: asText(r.title),
        url: asText(r.url),
        snippet: asText(r.content),
      }));
    },
  };
}

export function braveProvider(apiKey: string): SearchProvider {
  return {
    id: "brave",
    async search(query, options) {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      const body = (await getJson(url, {
        signal: options?.signal,
        headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
      })) as {
        web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> };
      };
      return (body.web?.results ?? []).map((r) => ({
        title: asText(r.title),
        url: asText(r.url),
        snippet: asText(r.description),
      }));
    },
  };
}

export function serpApiProvider(apiKey: string): SearchProvider {
  return {
    id: "serpapi",
    async search(query, options) {
      const url = new URL("https://serpapi.com/search.json");
      url.searchParams.set("q", query);
      url.searchParams.set("api_key", apiKey);
      const body = (await getJson(url, { signal: options?.signal })) as {
        organic_results?: Array<{ title?: unknown; link?: unknown; snippet?: unknown }>;
      };
      return (body.organic_results ?? []).map((r) => ({
        title: asText(r.title),
        url: asText(r.link),
        snippet: asText(r.snippet),
      }));
    },
  };
}

export interface ResolvedSearch {
  provider: SearchProvider;
  source: string;
  limitation?: string;
}
function resolveBuiltin(config: WebsearchConfig | undefined): ResolvedSearch {
  const provider = config?.provider;
  if (!provider || provider === "searxng") {
    const url = config?.searxngUrl ?? DEFAULT_SEARXNG_URL;
    return {
      provider: searxngProvider(url),
      source: config?.searxngUrl ? `searxng (${url})` : `default public SearXNG instance (${url})`,
      ...(config?.searxngUrl
        ? {}
        : {
            limitation:
              "Using a public SearXNG instance. In practice, most public instances rate-limit " +
              "or bot-block a fresh automated request (verified while building this tool: " +
              "nearly every instance tried returned 429 or a captcha page on the first call) — " +
              "treat this as a best-effort starting point, not a reliable default. Self-host " +
              "(e.g. `docker run searxng/searxng`) and set websearch.searxngUrl (for example " +
              '"http://localhost:8080") for search that actually works consistently.',
          }),
    };
  }
  if (provider === "duckduckgo-instant")
    return {
      provider: duckDuckGoInstantProvider(),
      source: "duckduckgo-instant",
      limitation:
        "DuckDuckGo's Instant Answer API only answers direct factual/infobox-style queries, not " +
        "general web search. An empty result here does not mean nothing exists on the web.",
    };
  if (provider === "duckduckgo-html")
    return {
      provider: duckDuckGoHtmlProvider(),
      source: "duckduckgo-html",
      limitation:
        "DuckDuckGo lite HTML provider: keyless and free, but it scrapes HTML DuckDuckGo may " +
        "change at any time, and heavy automation can be bot-checked. Use it as a keyless fallback " +
        "when the default public SearXNG instance is bot-blocked; self-hosted SearXNG remains the " +
        "most reliable option.",
    };
  if (provider === "native")
    throw new Error(
      'websearch.provider is "native": search runs server-side through the model provider; ' +
        "this tool should never be registered or called in that mode.",
    );
  const envVar = config?.apiKeyEnv ?? `${provider.toUpperCase()}_API_KEY`;
  const key = process.env[envVar];
  if (!key)
    throw new Error(
      `websearch.provider is "${provider}" but ${envVar} is not set in the environment`,
    );
  if (provider === "tavily") return { provider: tavilyProvider(key), source: "tavily" };
  if (provider === "brave") return { provider: braveProvider(key), source: "brave" };
  if (provider === "serpapi") return { provider: serpApiProvider(key), source: "serpapi" };
  throw new Error(`Unknown websearch.provider: ${provider satisfies never}`);
}
export interface SearchOutcome extends ResolvedSearch {
  results: SearchResult[];
  /** Set only when a plugin-registered provider failed and the built-in chain served instead. */
  diagnostic?: string;
}
export async function searchWithFallback(
  query: string,
  config: WebsearchConfig | undefined,
  resolveExtension: (() => { provider: SearchProvider; plugin: string } | undefined) | undefined,
  signal: AbortSignal,
): Promise<SearchOutcome> {
  const extension = resolveExtension?.();
  if (extension) {
    try {
      const results = await extension.provider.search(query, { signal });
      return { provider: extension.provider, source: `plugin:${extension.plugin}`, results };
    } catch (error) {
      const diagnostic = `Plugin websearch provider (${extension.plugin}) failed, using the built-in chain instead: ${error instanceof Error ? error.message : String(error)}`;
      const builtin = resolveBuiltin(config);
      const results = await builtin.provider.search(query, { signal });
      return { ...builtin, results, diagnostic };
    }
  }
  const builtin = resolveBuiltin(config);
  const results = await builtin.provider.search(query, { signal });
  return { ...builtin, results };
}
