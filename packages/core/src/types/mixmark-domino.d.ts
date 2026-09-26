/**
 * `@mixmark-io/domino` ships its `.d.ts` under the ambient module name `domino` (its pre-fork
 * package name), not its actual published name. This re-declares the same shape under the real
 * import specifier so `import domino from "@mixmark-io/domino"` type-checks.
 */
declare module "@mixmark-io/domino" {
  function createDocument(html?: string, force?: boolean): Document;
  function createWindow(html?: string, address?: string): Window;
  const domino: { createDocument: typeof createDocument; createWindow: typeof createWindow };
  export default domino;
}
