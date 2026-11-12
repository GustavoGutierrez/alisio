---
"@alisio/core": patch
"@alisio/server": patch
"@alisio/sdk": patch
---

Plugin creator web page: a "Plugins" dropdown in the sidebar (find more plugins in the catalog, open the plugin creator) and a full creator page with My plugins, the new-request panel, live build progress with the creator session's feed and approvals, project details (overview, stats, files, data diagram), install/update, changes, download, share tutorial and delete. Projects now report their folder (`dir`) and icon path (`icon`), served by `GET /api/plugin-creator/projects/:id/icon`.
