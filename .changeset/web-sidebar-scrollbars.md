---
"@alisio/server": patch
---

Web UI: the sidebar Apps list shows five apps with a "Show all (N)" toggle and scrolls inside its own area, so New session, Plugins, Projects and Settings & tools stay reachable with many apps (also in the rail and on mobile). Scrollbars across the UI are thin, rounded, auto-hiding overlays (OverlayScrollbars, loaded lazily after the first paint, with a thin CSS-only fallback); the chat's follow-the-stream scrolling and jump-to-latest are unchanged.
