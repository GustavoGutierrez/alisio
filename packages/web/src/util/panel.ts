/**
 * Pure logic of the artifact panel and the right slot it shares with the Dock (spec §15.2–15.4):
 * width bounds, keyboard resizing, the stored width, exclusivity, the card subtitle, the
 * renderer per artifact, relative Markdown images and the switcher filter. No DOM or signals,
 * so it is tested in Node.
 */
import type { ArtifactRef } from "@alisio/sdk";
import { readPref } from "../store/storage.ts";
import type { CardState } from "./artifacts.ts";

/** Smallest panel width (px). */
export const PANEL_MIN = 320;
/** The chat column never gets narrower than this (px). */
export const CHAT_MIN = 360;
/** Preference key of the shared right-slot width (px). */
export const WIDTH_PREF = "alisio.rightPanel.width";
/** Preference key of the expanded artifact panel. */
export const EXPANDED_PREF = "alisio.artifactPanel.expanded";

/** `clamp(360px, 42vw, 880px)`. */
export const defaultPanelWidth = (viewport: number): number =>
  Math.round(Math.min(880, Math.max(360, viewport * 0.42)));

export interface PanelBounds {
  min: number;
  max: number;
  /** False when the panel and a 360 px chat do not fit side by side (narrow sheet). */
  fits: boolean;
}

/** Width bounds for a viewport and the sidebar width next to the chat. */
export function panelBounds(viewport: number, sidebar: number): PanelBounds {
  const max = Math.floor(viewport - sidebar - CHAT_MIN);
  return { min: PANEL_MIN, max: Math.max(PANEL_MIN, max), fits: max >= PANEL_MIN };
}

export const clampPanelWidth = (width: number, bounds: PanelBounds): number =>
  Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));

/**
 * The width after a key on the resize handle (`role="separator"`), or undefined for other keys.
 * The handle sits on the panel's left edge: ← widens the panel, → narrows it; Shift moves 64 px
 * instead of 16; Home/End go to the minimum/maximum; Enter restores `reset`.
 */
export function resizeStep(input: {
  key: string;
  shift: boolean;
  width: number;
  bounds: PanelBounds;
  reset: number;
}): number | undefined {
  const step = input.shift ? 64 : 16;
  const next =
    input.key === "ArrowLeft"
      ? input.width + step
      : input.key === "ArrowRight"
        ? input.width - step
        : input.key === "Home"
          ? input.bounds.min
          : input.key === "End"
            ? input.bounds.max
            : input.key === "Enter"
              ? input.reset
              : undefined;
  return next === undefined ? undefined : clampPanelWidth(next, input.bounds);
}

/** The stored width, or undefined (no value, garbage, or storage that throws). */
export function storedPanelWidth(
  read: (key: string) => string | undefined = readPref,
): number | undefined {
  const raw = read(WIDTH_PREF);
  if (!raw || !/^\d{1,5}$/.test(raw)) return undefined;
  const width = Number(raw);
  return width >= PANEL_MIN ? width : undefined;
}

/** What occupies the right slot: the Dock, one artifact, or nothing. */
export interface RightSlot {
  dock: boolean;
  artifact: string | undefined;
}

/** Opening one side of the slot closes the other (ADR-07). */
export function nextRightPanel(
  current: RightSlot,
  change: { dock?: boolean; artifact?: string | undefined },
): RightSlot {
  if ("artifact" in change && change.artifact !== undefined)
    return { dock: false, artifact: change.artifact };
  if (change.dock === true) return { dock: true, artifact: undefined };
  return {
    dock: change.dock ?? current.dock,
    artifact: "artifact" in change ? undefined : current.artifact,
  };
}

/**
 * The card subtitle: what shows at rest (`kind` label, or a state) and whether hover/focus may
 * swap it for "Open file" (only previewable, ready artifacts without an error).
 */
export function cardSubtitle(
  artifact: ArtifactRef,
  state: CardState,
  error?: string,
): {
  rest: "kind" | "loading" | "deleted" | "expired" | "error";
  hover: boolean;
  partial: boolean;
} {
  const partial = !!artifact.partial;
  if (state === "loading") return { rest: "loading", hover: false, partial: false };
  if (state === "deleted" || state === "expired") return { rest: state, hover: false, partial };
  if (error) return { rest: "error", hover: false, partial };
  return { rest: "kind", hover: artifact.previewable && artifact.status === "ready", partial };
}

const extension = (name: string): string => {
  const base = name.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

export type RendererChoice =
  | { kind: "html" | "pdf" | "markdown" | "image" | "json" | "code" | "spreadsheet" }
  | { kind: "fallback"; reason: "noPreview" | "tooLarge" };

/** Kinds (or extensions) that preview at all, whatever their size. */
function previewableType(artifact: ArtifactRef): boolean {
  const ext = extension(artifact.fileName);
  switch (artifact.kind) {
    case "dashboard":
    case "image":
    case "data":
    case "code":
      return true;
    case "document":
      return ext === "md" || ext === "markdown" || artifact.mimeType === "application/pdf";
    case "spreadsheet":
      return ext === "csv" || ext === "tsv" || ext === "xlsx";
    default:
      return false;
  }
}

/** The renderer of an artifact (§15.3); not previewable → the download fallback and why. */
export function rendererFor(artifact: ArtifactRef): RendererChoice {
  if (!artifact.previewable)
    return { kind: "fallback", reason: previewableType(artifact) ? "tooLarge" : "noPreview" };
  if (artifact.kind === "dashboard") return { kind: "html" };
  if (artifact.mimeType === "application/pdf") return { kind: "pdf" };
  if (artifact.kind === "image") return { kind: "image" };
  if (artifact.kind === "data") return { kind: "json" };
  if (artifact.kind === "document") return { kind: "markdown" };
  if (artifact.kind === "spreadsheet") return { kind: "spreadsheet" };
  if (artifact.kind === "code") return { kind: "code" };
  return { kind: "fallback", reason: "noPreview" };
}

const LANGUAGES: Record<string, string> = {
  py: "python",
  js: "javascript",
  ts: "typescript",
  json: "json",
  geojson: "json",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  r: "r",
  csv: "csv",
  tsv: "tsv",
  md: "markdown",
  html: "html",
  log: "log",
};

/** Highlighting language of a file name (undefined = plain text). */
export const codeLanguage = (fileName: string): string | undefined =>
  LANGUAGES[extension(fileName)];

/**
 * The panel URL of an image a Markdown artifact references relatively (resolved against the
 * entry's folder), or undefined for absolute, external or escaping references.
 */
export function artifactImageUrl(
  href: string,
  artifactId: string,
  entry: string,
): string | undefined {
  const ref = href.trim();
  if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("/") || ref.startsWith("\\"))
    return undefined;
  const parts = entry.split("/").slice(0, -1);
  for (const raw of ref.split(/[?#]/)[0]?.split("/") ?? []) {
    let part: string;
    try {
      part = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (!part || part === ".") continue;
    if (part === ".." || part.includes("\\")) return undefined;
    parts.push(part);
  }
  if (!parts.length) return undefined;
  return `/api/artifacts/${encodeURIComponent(artifactId)}/files/${parts.map(encodeURIComponent).join("/")}`;
}

/** Artifacts whose name, title or kind contains every word of `query` (case-insensitive). */
export function filterArtifacts(list: ArtifactRef[], query: string): ArtifactRef[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((artifact) => {
    const haystack = `${artifact.fileName} ${artifact.title} ${artifact.kind}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** A cached viewer link while it has more than 30 s left. */
export const freshViewUrl = (
  cached: { url: string; expiresAt: number } | undefined,
  now: number,
): string | undefined => (cached && cached.expiresAt - 30_000 > now ? cached.url : undefined);
