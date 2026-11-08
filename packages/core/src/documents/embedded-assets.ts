/**
 * Document assets embedded in the standalone binary (spec 026 D-28). In the repository this is a
 * stub: `scripts/binary-build.ts` swaps the compiled module for one carrying the themes and fonts
 * (base64 by relative path) just for `bun build --compile`, then restores it.
 */
export interface EmbeddedAssets {
  /** Content hash: the folder the files are extracted to. */
  version: string;
  files: Record<string, string>;
}

export const EMBEDDED_ASSETS: EmbeddedAssets | undefined = undefined;
