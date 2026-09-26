# @alisio/plugin-opencode

Built-in OpenCode Console (Zen) provider for Alisio. It discovers the unauthenticated model catalog, filters it to documented Responses, Chat Completions, and Anthropic Messages families, and fails closed for unknown, Gemini-native, and System One entries.

Credentials are supplied by the Alisio provider host and are never part of the non-secret profile.
