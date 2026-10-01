/**
 * Pure helpers of the artifact cards (spec §15.1–15.2): artifacts carried by tool results,
 * reconciliation by id with the session list (deleted/expired/loading states) and the card's
 * primary action. No DOM or signals, so they are tested in Node.
 */
import type { ArtifactKind, ArtifactRef, ToolResult } from "@alisio/sdk";

export type CardState = "loading" | "ready" | "deleted" | "expired";

/** The artifacts a persisted tool result announced, in publication order. */
export function artifactsOfResult(result: ToolResult | undefined): ArtifactRef[] {
  const out: ArtifactRef[] = [];
  for (const part of result?.content ?? [])
    if (part.type === "ui" && part.block.kind === "artifact" && part.block.artifact?.id)
      out.push(part.block.artifact);
  return out;
}

/** Merges `incoming` into a session list: one entry per id, newest first. */
export function mergeArtifacts(list: ArtifactRef[], incoming: ArtifactRef[]): ArtifactRef[] {
  const byId = new Map(list.map((artifact) => [artifact.id, artifact]));
  for (const artifact of incoming) byId.set(artifact.id, artifact);
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

/**
 * A card's artifact as the session list knows it now. Before the list loads the card is
 * `loading`; an artifact missing from a loaded list keeps the card's own data (the list is
 * paged), and a listed one wins (it carries `deleted`/`expired`).
 */
export function reconcile(
  card: ArtifactRef,
  list: ArtifactRef[] | undefined,
): { artifact: ArtifactRef; state: CardState } {
  if (!list) return { artifact: card, state: "loading" };
  const known = list.find((artifact) => artifact.id === card.id);
  const artifact = known ?? card;
  return { artifact, state: artifact.status };
}

/** What the card's main button does: previewable, ready artifacts open the panel (phase 2). */
export const primaryAction = (artifact: ArtifactRef): "open" | "download" =>
  artifact.previewable && artifact.status === "ready" ? "open" : "download";

/** Whether hover/focus may show "Open file". */
export const showsOpenFile = (artifact: ArtifactRef): boolean => primaryAction(artifact) === "open";

export const downloadUrl = (id: string): string =>
  `/api/artifacts/${encodeURIComponent(id)}/download`;

/** Icon per kind (`components/icons.tsx` names). */
export const ARTIFACT_ICONS: Record<ArtifactKind, string> = {
  dashboard: "fileChart",
  document: "fileText",
  spreadsheet: "fileTable",
  image: "fileImage",
  data: "fileCode",
  code: "fileCode",
  archive: "fileArchive",
  file: "file",
};

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
