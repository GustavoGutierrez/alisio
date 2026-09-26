# @alisio/plugin-opencode-go

Built-in OpenCode Go provider for Alisio. It discovers the unauthenticated Go catalog and routes
only exact model IDs in the documented endpoint table: GPT, Grok and Muse through Responses; open
compatible models through Chat Completions; MiniMax and Qwen through Anthropic Messages. Unknown
catalog entries are hidden rather than guessed.
