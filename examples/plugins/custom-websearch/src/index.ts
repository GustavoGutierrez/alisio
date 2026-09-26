import { definePlugin, type SearchProvider, type SearchResult } from "@alisio/sdk";

/**
 * Wraps Brave's Search API behind the `websearch` extension point, using a user-supplied key
 * (never hardcoded, never logged). Registering this fully replaces Alisio's built-in websearch
 * resolution (the default public SearXNG instance, DuckDuckGo Instant Answer, or a configured
 * provider) for as long as this plugin is loaded — the same way a custom mascot plugin replaces
 * the default mascot. Unregistering it (the plugin is disabled or unloaded) restores the
 * built-in chain automatically; a throwing/broken provider here also falls back to it, with a
 * diagnostic, rather than failing the `websearch` tool call outright.
 */
export function braveSearchProvider(apiKey: string): SearchProvider {
  return {
    id: "brave-example",
    async search(query: string, options?: { signal?: AbortSignal }): Promise<SearchResult[]> {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      const res = await fetch(url, {
        headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
        signal: options?.signal,
      });
      if (!res.ok) throw new Error(`Brave Search request failed: HTTP ${res.status}`);
      const body = (await res.json()) as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
      };
      return (body.web?.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.description ?? "",
      }));
    },
  };
}

export default definePlugin({
  id: "brave-websearch",
  version: "0.1.0",
  apiVersion: 1,
  setup(api) {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      // Fail loudly at setup rather than silently falling back to the built-in chain: a plugin
      // the user explicitly loaded for this purpose should say clearly why it did nothing.
      throw new Error(
        "brave-websearch: set BRAVE_SEARCH_API_KEY to use this plugin (get one at " +
          "https://api.search.brave.com/, ~1000 free queries/month at the time of writing, card required).",
      );
    }
    api.extensions.register("websearch", braveSearchProvider(apiKey), { priority: 10 });
  },
});
