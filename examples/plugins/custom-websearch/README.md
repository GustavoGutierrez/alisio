# alisio-plugin-brave-websearch

Example [Alisio](https://github.com/GustavoGutierrez/alisio) plugin that replaces `websearch`'s
result provider with [Brave Search](https://api.search.brave.com/) using the typed `websearch`
extension point — the same mechanism `mascot`/`startup-screen` use (priority-based resolution,
automatic fallback on a throwing provider, restored on unload). It depends only on `@alisio/sdk`
(peer dependency) and ships JavaScript.

```sh
npm run build
export BRAVE_SEARCH_API_KEY=...   # https://api.search.brave.com/ — needs a card; a free ~$5/month
                                   # credit covers roughly 1000 queries at the time of writing
alisio --plugin ./examples/plugins/custom-websearch/dist/index.js --allow-external
```

Registering `websearch` fully replaces Alisio's built-in resolution (the default public SearXNG
instance, DuckDuckGo Instant Answer, or a configured provider) while this plugin is loaded; a
throwing or misbehaving provider here falls back to that built-in chain instead of failing the
`websearch` tool call outright, and unloading the plugin restores the built-ins. Copy `src/index.ts`
as a starting point for wrapping any other search API behind the same `SearchProvider` port.
