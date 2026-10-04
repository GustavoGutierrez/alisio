/** What the artifact-publishing tools show the model and the UI after a publication. */
import type { UiBlock } from "@alisio/sdk";
import type { PublishedArtifactInfo } from "../core/contracts.ts";

/** `48 KB`, `1.2 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const describeArtifact = (p: PublishedArtifactInfo) =>
  `${p.artifact.fileName} (${p.artifact.kind}, ${formatBytes(p.artifact.bytes)}, ${p.artifact.id})`;

/** One `artifact` UI block per publication (the viewer opens it). */
export const artifactBlocks = (published: PublishedArtifactInfo[]) =>
  published.map((p) => ({
    type: "ui" as const,
    block: { kind: "artifact", artifact: p.artifact } as UiBlock,
  }));
