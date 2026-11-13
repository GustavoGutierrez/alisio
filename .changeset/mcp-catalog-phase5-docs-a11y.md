---
"@alisio/server": patch
---

MCP catalog phase 5 (documentation, accessibility, regression): the web UI bundled with the server
now moves focus into the MCP access question and closes it with Escape, gives focus back to the button that
opened a confirmation dialog, always renders the Explore tab panel, uses an AA-contrast color for registry
names, keeps the text column of a Connected row readable when it has many actions and keeps the enable switch
shape. New MCP catalog guide in the docs (EN/ES) with screenshots, and an extended browser E2E (`pnpm test:e2e`).
