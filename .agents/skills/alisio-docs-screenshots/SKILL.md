---
name: alisio-docs-screenshots
description: "How to capture and place a Web UI screenshot in the Alisio docs (Playwright against a built `alisio serve` with a scripted fake provider, WebP under ~150 KB, EN and ES pages). Use this skill whenever you document, add or change a Web UI feature, or add or update an image under docs/assets/web-ui, even if the user only says 'document this feature'."
---

# Web UI screenshots in the docs

Whenever you document or change a Web UI feature, take a real screenshot and put it in the docs.
Why: a real image proves the feature works and gives both language pages the same visual anchor;
fake data keeps private titles, e-mails and tokens out of the public docs.
Related: `alisio-pkg-web` (the UI), `alisio-coding-standards` (docs parity).

1. Finish the feature first; make sure it works.
2. Build, then capture with Playwright against a built `alisio serve` using a scripted fake
   provider. Use realistic sample data; never real session titles, e-mails or tokens.
3. Convert to WebP, under ~150 KB. Save as `docs/assets/web-ui/<feature>_web_ui.webp`.
4. Delete temporary files and `.playwright-mcp/`.
5. Place it next to the paragraph it illustrates in BOTH the English and Spanish pages, with alt
   text and a caption in each page's language.
6. Reuse an existing screenshot when it already shows the feature; never rename existing ones;
   never use them in TUI sections; do not repeat one image more than twice on a page.
7. `pnpm docs:check` validates that the images exist and both languages stay in parity.

Markup: copy the `<figure>`/`<img>` block of an existing screenshot (see `docs/web.md`, e.g.
`compacting_web_ui.webp`; the Spanish page uses `../assets/web-ui/...`): relative `src`, a
descriptive `alt`, `width`/`height`, `loading="lazy"`, plus a caption in the page's language.
