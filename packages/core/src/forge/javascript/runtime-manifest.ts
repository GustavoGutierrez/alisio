/**
 * What the JavaScript engine is allowed to run (spec D17, D-22): the exact `quickjs-wasi` build
 * and the hash of its WASM. A TypeScript constant on purpose (`tsc` does not copy JSON to `dist`).
 * `wasm.ts` hashes the bytes it read before compiling anything and refuses a mismatch; the hash is
 * checked again inside the isolate process.
 */
export const QUICKJS_WASI_VERSION = "3.6.2";
export const QUICKJS_WASM_SHA256 =
  "d4c9375f2b1ca4dc95f72c8aa2982a7a9951ac8011490d79c6582df732b4bbd9";
export const QUICKJS_WASM_BYTES = 637_405;
/** Version of the host/guest message schema (`Envelope.protocol`). */
export const FORGE_PROTOCOL_VERSION = 1;
/** Bump whenever `prelude.ts` changes in a way that matters to a guest. */
export const PRELUDE_VERSION = 2;

export const JAVASCRIPT_ENGINE_VERSION = `quickjs-wasi@${QUICKJS_WASI_VERSION}`;
