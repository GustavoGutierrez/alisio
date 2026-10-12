/**
 * Bun-only: the WASM as an embedded asset. Imported dynamically, and only when `process.versions.bun`
 * is set (`wasm.ts`), so Node never touches it. In a compiled binary the default export is a path
 * into the binary's virtual file system that `node:fs` can read; running from sources it is the
 * real file.
 */
import path from "quickjs-wasi/quickjs.wasm" with { type: "file" };

export default path;
