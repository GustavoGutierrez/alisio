import { defineConfig } from "vite";

/**
 * The web UI build. Output goes to `dist/`; the @alisio/server build copies it to its own
 * `dist/web`. Heavy renderers (shiki) are dynamic imports, so they land in their own chunks.
 */
export default defineConfig({
  base: "/",
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  resolve: { conditions: ["alisio-source"] },
  css: { modules: { localsConvention: "camelCaseOnly" } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    assetsDir: "assets",
    sourcemap: false,
    modulePreload: { polyfill: false },
    reportCompressedSize: false,
  },
});
