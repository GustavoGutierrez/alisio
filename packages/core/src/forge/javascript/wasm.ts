/**
 * Loads, verifies and compiles the QuickJS WASM (spec D3, D17, D-22).
 *
 * The bytes come from the Bun asset (guarded dynamic import) or, on Node, from
 * `quickjs-wasi/quickjs.wasm`. Their SHA-256 is compared with the manifest BEFORE compiling: a
 * mismatch means the engine is not ready. The compiled `WebAssembly.Module` is cached per process
 * and reused by every execution (the memory and globals of a VM never are).
 *
 * Erasable TypeScript only (D-33): the isolate entry imports this file under Node's type stripping.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { QUICKJS_WASM_BYTES, QUICKJS_WASM_SHA256 } from "./runtime-manifest.ts";

export const sha256Hex = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

/** Why `bytes` is not the pinned WASM, or undefined when it is. */
export function wasmProblem(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength !== QUICKJS_WASM_BYTES)
    return `quickjs.wasm has ${bytes.byteLength} bytes, expected ${QUICKJS_WASM_BYTES}`;
  const actual = sha256Hex(bytes);
  if (actual !== QUICKJS_WASM_SHA256)
    return `quickjs.wasm hash ${actual} does not match the pinned ${QUICKJS_WASM_SHA256}`;
  return undefined;
}

/** The path of the WASM: the Bun asset on Bun, the package file on Node. */
export async function resolveWasmPath(): Promise<string> {
  if (process.versions.bun) {
    const asset = await import("./wasm-asset.ts");
    return asset.default;
  }
  return createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm");
}

export type WasmBytesLoader = () => Promise<Uint8Array>;

const defaultLoader: WasmBytesLoader = async () => readFile(await resolveWasmPath());

/**
 * Reads, verifies and compiles. Throws an `Error` whose message says why when the bytes are not the
 * pinned build. Not cached: see `loadQuickJsModule`.
 */
export async function compileVerifiedModule(
  loader: WasmBytesLoader = defaultLoader,
): Promise<WebAssembly.Module> {
  const bytes = await loader();
  const problem = wasmProblem(bytes);
  if (problem) throw new Error(problem);
  return WebAssembly.compile(bytes as BufferSource);
}

let cached: Promise<WebAssembly.Module> | undefined;

/** The process-wide compiled module. A failure is cached too: the engine stays not ready. */
export function loadQuickJsModule(): Promise<WebAssembly.Module> {
  cached ??= compileVerifiedModule();
  return cached;
}

/** Test seam: forgets the cached module. */
export function resetQuickJsModuleCache(): void {
  cached = undefined;
}
