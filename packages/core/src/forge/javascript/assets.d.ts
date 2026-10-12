declare module "quickjs-wasi/quickjs.wasm" {
  /** Bun `with { type: "file" }`: the path of the embedded or real file. */
  const path: string;
  export default path;
}
