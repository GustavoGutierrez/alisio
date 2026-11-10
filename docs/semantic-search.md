# Semantic search

Semantic search finds text by **meaning**, not by exact words. Alisio ships the shared capability;
the engine that does the work comes from a plugin you choose to turn on.

## What it is {#what-it-is}

A normal search looks for the words you typed. A semantic search looks for the idea behind them: a
search for "budget meeting" can find a note titled "quarterly financial review" even though they
share no words. Depending on the model the engine uses, it can also work across languages, so a
question in Spanish can find a document written in English.

## What it enables {#what-it-enables}

Semantic search is a building block. Plugins that use it can offer:

- **Chat with your own documents**, with answers that cite the passages they came from (a research
  notebook over your sources).
- **Smarter memory recall**, finding what you saved by meaning and not only by keywords.
- **Related files and notes**, so you can find what is close to what you are reading.
- **Deduplicating and grouping** similar content, such as near-identical documents or repeated notes.

## How it works in Alisio {#how-it-works}

- **Alisio defines the capability.** It provides the shared contract and the service that plugins
  use, and nothing heavier, so the app stays small.
- **A provider plugin supplies the engine**: an embedding model (turns text into numbers that
  capture meaning) and a vector store (keeps and searches them).
- **Installing a plugin never turns it on.** You activate it, and your choice is saved in your
  global configuration. Project configuration cannot activate a provider.
- **`/semantic` shows the status**: which providers are registered and active, the model and the
  health of each one.
- **It can run locally.** Whether anything leaves your computer depends on the provider you choose.

## Current status {#status}

::: warning Alisio 0.11.7 ships the capability, not an engine
No semantic search provider is bundled, so out of the box semantic search is not available. The
first provider, `@alisio/plugin-semantic`, is planned in the alisio-plugins repository and is not
published yet. It is intended to use a local LanceDB store with the multilingual-e5-small model and
to include a Notebook app to chat with your sources. Until a provider exists and you activate it,
plugins fall back to their own behavior, for example keyword search.
:::

## Privacy and limits {#privacy}

- Vectors and indexes stay wherever the provider keeps them. Check what your provider does before
  you index private documents.
- Changing the model requires indexing again: vectors from different models are not comparable, so
  existing collections are rejected until they are rebuilt.
- Each plugin has its own namespace of collections. Namespaces prevent accidental mixing; they are
  not a security sandbox, because plugins are trusted code.
- You can turn the feature off with `semantic.enabled`.

## For plugin developers {#for-developers}

Plugins can consume the capability through `context.semantic` or provide an engine through
`api.semantic`. Both members are optional, so feature-detect them and keep a fallback. See
[Semantic search providers and consumers](/plugins#semantic-search) for the API and the
[`semantic`](/configuration#semantic) configuration key for the settings.
