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
 *      `"duckduckgo-instant"`, `"tavily"`, `"brave"` or `"serpapi"` (the last three need an API key
 *      env var).
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
  provider?: "searxng" | "duckduckgo-instant" | "tavily" | "brave" | "serpapi" | "native";
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
