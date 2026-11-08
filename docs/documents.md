# Designed PDFs: document_create

Ask Alisio for a PDF, a printable document or "convert this Markdown to PDF" and it produces a
designed file: a cover, a table of contents, page numbers, styled tables, callouts and code, in a
theme you pick. The model writes **content only** (Markdown or a structured document); Alisio owns
the presentation, so the result looks the same on every machine and no HTML or CSS is involved.

The PDF is published as a normal artifact: the web UI previews it, headless runs list it, and the
terminal UI lists it without a preview.

## What you need {#requirements}

A Chromium-family browser on the machine: Google Chrome, Chromium, Microsoft Edge, Brave or
Vivaldi, version 131 or newer. Alisio never downloads a browser. It looks for one in this order:
the `documents.chromiumPath` setting, the `ALISIO_CHROME_PATH`, `CHROME_PATH` and
`PUPPETEER_EXECUTABLE_PATH` environment variables, the usual install folders of your system, and
`PATH`.

```bash
alisio documents status
```

prints whether the engine is ready, its version, and if not, why and how to fix it. When no
browser is found, `document_create` answers `DOCUMENT_ENGINE_UNAVAILABLE` with the action for your
system and publishes a self-contained HTML version of the document that you can open in any browser
and print to PDF.

| System | Typical fix |
|---|---|
| Linux | Install `google-chrome`, `chromium` or `microsoft-edge` with your package manager |
| macOS | Install Google Chrome, Microsoft Edge or Chromium (for example `brew install --cask google-chrome`) |
| Windows | Install Google Chrome, or use Microsoft Edge, which ships with Windows |

The standalone binary carries no asset files, so documents need the npm install
(`npm install -g @alisio/alisio-code`); Alisio Desktop support arrives with the desktop engine.

## Themes {#themes}

| Theme | Use it for |
|---|---|
| `executive-clean` (default) | Reports, proposals and memos: serif reading text, navy cover, hairline rules |
| `data-report` | Tables, stat cards and data-heavy reports: sans type, teal accent, strong table headers |
| `technical-spec` | Specs, manuals and runbooks: numbered headings, prominent code, grid tables |

Every theme supports A4 and Letter in portrait and landscape (and Legal and A5), uses only the
bundled fonts (Inter, Source Serif 4 and JetBrains Mono, under the SIL Open Font License), and puts
the document title and page numbers in the page margins. The model calls `document_themes` first to
see the list, the blocks and the engine state.

## Content: Markdown or blocks {#content}

Markdown supports headings (h4 and deeper become level 3), lists with one nested level, tables,
quotes, fenced code, images, GitHub alerts (`> [!NOTE]`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`),
a `---pagebreak---` line and `[TOC]`. Front matter sets `title`, `subtitle`, `author`, `date`,
`organization`, `theme`, `lang` and `toc: true`; a `title` adds a cover.

Without front matter, the first `#` heading becomes the cover title and the bold `**Key:** value`
lines right under it (version, date, author; a `Subtitle` line sets the subtitle) become the cover
details, so the body starts on page 2. Pass `cover: false` (or `cover: false` in the front matter)
to build no cover at all. The `technical-spec` theme numbers its headings automatically, unless
the document already numbers them (`## 02. History`, `### 2.1 Origin`): then it leaves them as
written.

For finer control the model sends a `spec` of blocks: `cover`, `heading`, `paragraph`, `bullets`,
`table`, `image`, `quote`, `callout`, `code`, `stat_grid`, `page_break` and `toc`. Text fields take
Markdown inline only (bold, italic, code and links). Raw HTML is never interpreted: it is printed
as visible text.

Images are workspace files or artifacts of the session, declared in `assets` and referenced by id.
Remote images are never fetched; the alt text is kept and a `remote_image_skipped` warning appears.
An image that cannot be used (missing file, SVG, any type other than PNG, JPEG, WebP or GIF, too
large) does not fail the document: it is replaced by a small placeholder with its alt text and an
`image_skipped` warning gives the reason. Only security violations (absolute paths, `..`, links
leaving the workspace, an untrusted project) stop the call.

## Brand colors {#brand}

`theme` accepts either a theme id or an object `{ "id": "data-report", "accent": "#b4531a", "ink": "#1a1a1a" }`
(or `accent:` and `ink:` in the front matter). The accent colors the heading rules, table headers,
callouts and cover blocks of every theme; the ink colors text and headings. Colors are hex values;
one whose contrast against the page is below 4.5:1 is darkened until it passes and an
`accent_adjusted` or `ink_adjusted` warning says so. Anything that is not a hex color is rejected
with `DOCUMENT_INPUT_INVALID`.

## Checks and automatic repair {#qa}

With `quality: "professional"` (the default) every render is checked and, when a known layout
problem is found, repaired up to two times: a table wider than the page switches the page to
landscape (unless you set an orientation) and then to a compact table density. `quality: "fast"`
checks but never repairs. The result lists every warning and every repair. The checks:

- Characters that no bundled font covers (`glyphs_missing`, with the unsupported script).
- Content wider than the text area (`overflow`) and images printed below 150 dpi.
- Fonts embedded in the PDF that are not bundled (`font_not_bundled`) and the page limit.
- An empty last page, repaired by removing the trailing page break.

A PDF with an unrepaired error is still published, with `Checks: FAILED` and the reason.

## Security {#security}

- All text is escaped; the generated page has no script, no inline style and a strict content
  security policy.
- The network is off while rendering: every request is intercepted and only the document's own
  bundle is served, so no image, font or style is fetched from anywhere.
- Asset paths must be relative to the workspace and are resolved with their real path: absolute
  paths, `..` and symbolic links that leave the workspace are denied, as is any workspace file in
  an untrusted project. Only PNG, JPEG, WebP and GIF are accepted, up to 10 MB each and 50 MB in
  total.
- Limits: 400 KB of Markdown, 2 000 blocks, 500 table rows per table, 200 pages, a 50 MB PDF, 60 s
  per render and 180 s per call, two renders at once.
- The browser runs with a temporary profile and a minimal environment (no API keys), and is killed
  on cancel or timeout. `documents.chromiumPath` is global-only: a project cannot choose the
  binary.

## Configuration {#configuration}

| Key | Default | Meaning |
|---|---|---|
| `documents.enabled` | `true` | Registers `document_create` and `document_themes`; applies at the next start |
| `documents.engine` | `auto` | `auto`, `chromium` or `weasyprint` (WeasyPrint is not available yet) |
| `documents.chromiumPath` | unset | Explicit browser path (global-only) |
| `documents.defaultPageSize` | `A4` | `A4`, `Letter`, `Legal` or `A5` |

## Limits of this version {#limits}

- Output is RGB for office, laser and digital use. It is not print-shop output: no CMYK, no PDF/X,
  no bleed or crop marks, and no claim of PDF/A or PDF/UA conformance (the PDF is tagged when the
  browser supports it).
- The table of contents lists the headings as links without page numbers.
- Latin, Greek and Cyrillic text only. Chinese, Japanese, Korean, Arabic, Hebrew and similar
  scripts are reported as missing glyphs; emoji are removed. Arrows, comparison signs and check
  marks are replaced by plain text because the bundled subsets lack them.
- Running chapter headers and page-bottom footnotes, the Desktop engine, charts, SVG images and
  visual checks are not part of this version.
- Programmatic PDFs (forms, merging, reportlab) stay with `python_run`; see [Forja](/forja).
