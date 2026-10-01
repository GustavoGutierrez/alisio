/**
 * Artifact type registry: the kind, the served MIME type and whether a rich client may preview a
 * published file. The type comes from the extension AND the leading bytes; when they disagree the
 * most restrictive type wins (`file`, download only). The served `Content-Type` always comes from
 * here, never from the script that wrote the file.
 */
import type { ArtifactKind } from "@alisio/sdk";

export interface ArtifactType {
  kind: ArtifactKind;
  mimeType: string;
}

type Magic = "text" | "delimited" | "pdf" | "png" | "jpeg" | "gif" | "webp" | "zip";

interface Rule extends ArtifactType {
  magic: Magic;
  /** Largest size a rich client may preview; absent = never previewable. */
  previewMax?: number;
}

const MB = 1024 * 1024;
const TEXT_PREVIEW = 2 * MB;
/** Tables are read through paged queries, not loaded whole: the limit is the ingestion limit. */
const TABLE_PREVIEW = 200 * MB;
const UTF8 = "; charset=utf-8";
const OOXML = "application/vnd.openxmlformats-officedocument";

const text = (kind: ArtifactKind, mimeType: string, previewMax = TEXT_PREVIEW): Rule => ({
  kind,
  mimeType,
  magic: "text",
  previewMax,
});

const RULES: Record<string, Rule> = {
  html: text("dashboard", `text/html${UTF8}`, 20 * MB),
  htm: text("dashboard", `text/html${UTF8}`, 20 * MB),
  md: text("document", `text/markdown${UTF8}`),
  markdown: text("document", `text/markdown${UTF8}`),
  pdf: { kind: "document", mimeType: "application/pdf", magic: "pdf", previewMax: 50 * MB },
  docx: { kind: "document", mimeType: `${OOXML}.wordprocessingml.document`, magic: "zip" },
  pptx: { kind: "document", mimeType: `${OOXML}.presentationml.presentation`, magic: "zip" },
  odt: { kind: "document", mimeType: "application/vnd.oasis.opendocument.text", magic: "zip" },
  // Tables open in SpreadsheetView (phase 3): CSV/TSV may be windows-1252 or UTF-16, which the
  // ingestion decodes, so their bytes only have to look like delimited text, not like UTF-8.
  csv: {
    kind: "spreadsheet",
    mimeType: `text/csv${UTF8}`,
    magic: "delimited",
    previewMax: TABLE_PREVIEW,
  },
  tsv: {
    kind: "spreadsheet",
    mimeType: `text/tab-separated-values${UTF8}`,
    magic: "delimited",
    previewMax: TABLE_PREVIEW,
  },
  xlsx: {
    kind: "spreadsheet",
    mimeType: `${OOXML}.spreadsheetml.sheet`,
    magic: "zip",
    previewMax: TABLE_PREVIEW,
  },
  png: { kind: "image", mimeType: "image/png", magic: "png", previewMax: 20 * MB },
  jpg: { kind: "image", mimeType: "image/jpeg", magic: "jpeg", previewMax: 20 * MB },
  jpeg: { kind: "image", mimeType: "image/jpeg", magic: "jpeg", previewMax: 20 * MB },
  gif: { kind: "image", mimeType: "image/gif", magic: "gif", previewMax: 20 * MB },
  webp: { kind: "image", mimeType: "image/webp", magic: "webp", previewMax: 20 * MB },
  svg: text("image", "image/svg+xml", 20 * MB),
  json: text("data", "application/json"),
  geojson: text("data", "application/json"),
  zip: { kind: "archive", mimeType: "application/zip", magic: "zip" },
};
for (const ext of ["txt", "log", "sql", "yaml", "yml", "xml", "py", "js", "ts", "r"])
  RULES[ext] = text("code", `text/plain${UTF8}`);

export const DOWNLOAD_ONLY: ArtifactType = { kind: "file", mimeType: "application/octet-stream" };

/** Lower-case extension without the dot (`""` when none). */
export const extensionOf = (fileName: string): string => {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

const startsWith = (bytes: Uint8Array, signature: number[], at = 0) =>
  bytes.length >= at + signature.length && signature.every((b, i) => bytes[at + i] === b);

/** Text: no NUL byte in the sampled head and the sample decodes as UTF-8. */
export function looksLikeText(head: Uint8Array): boolean {
  if (head.includes(0)) return false;
  try {
    // A cut multi-byte character at the end of the sample is not a decoding failure.
    new TextDecoder("utf-8", { fatal: true }).decode(
      head.subarray(0, Math.max(0, head.length - 3)),
    );
    return true;
  } catch {
    return false;
  }
}

function matches(magic: Magic, head: Uint8Array): boolean {
  switch (magic) {
    case "text":
      return looksLikeText(head);
    case "delimited":
      // Text in any of the encodings the ingestion reads: UTF-8, windows-1252 (no NUL bytes) or
      // UTF-16 with a BOM.
      return (
        looksLikeText(head) ||
        startsWith(head, [0xff, 0xfe]) ||
        startsWith(head, [0xfe, 0xff]) ||
        !head.includes(0)
      );
    case "pdf":
      return startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    case "png":
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "jpeg":
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case "gif":
      return startsWith(head, [0x47, 0x49, 0x46, 0x38]);
    case "webp":
      return (
        startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)
      );
    case "zip":
      return (
        startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])
      );
  }
}

/**
 * The type of a file from its name and its first bytes (at least 4 KiB is a good sample). An
 * unknown extension, or bytes that contradict the extension, yield `file` (download only).
 * An empty file keeps the type of its extension.
 */
export function classifyArtifact(fileName: string, head: Uint8Array): ArtifactType {
  const rule = RULES[extensionOf(fileName)];
  if (!rule) return DOWNLOAD_ONLY;
  if (head.length > 0 && !matches(rule.magic, head)) return DOWNLOAD_ONLY;
  return { kind: rule.kind, mimeType: rule.mimeType };
}

/** Whether a rich client may preview a file of this name, type and size. */
export function isPreviewable(fileName: string, type: ArtifactType, bytes: number): boolean {
  if (type.kind === "file" || type.kind === "archive") return false;
  const rule = RULES[extensionOf(fileName)];
  return !!rule?.previewMax && rule.mimeType === type.mimeType && bytes <= rule.previewMax;
}

/** English labels of each kind (the web localizes its own; text surfaces use these). */
export const KIND_LABELS: Record<ArtifactKind, string> = {
  dashboard: "Dashboard",
  document: "Document",
  spreadsheet: "Spreadsheet",
  image: "Image",
  data: "Data",
  code: "Text",
  archive: "Archive",
  file: "File",
};

/**
 * Content types of the files of an artifact served by the isolated viewer (spec §14.2): a
 * multi-file dashboard needs its scripts, styles and fonts with their real types (under
 * `nosniff` a script served as text never runs). Only that sandboxed route uses this table;
 * every other route serves the registry type above.
 */
const VIEWER_TYPES: Record<string, string> = {
  html: `text/html${UTF8}`,
  htm: `text/html${UTF8}`,
  css: `text/css${UTF8}`,
  js: `text/javascript${UTF8}`,
  mjs: `text/javascript${UTF8}`,
  json: `application/json${UTF8}`,
  geojson: `application/json${UTF8}`,
  csv: `text/csv${UTF8}`,
  tsv: `text/tab-separated-values${UTF8}`,
  txt: `text/plain${UTF8}`,
  md: `text/markdown${UTF8}`,
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

/** The type the sandboxed viewer serves for one file (`application/octet-stream` when unknown). */
export const viewerContentType = (fileName: string): string =>
  VIEWER_TYPES[extensionOf(fileName)] ?? "application/octet-stream";

/**
 * The registry type of one file inside an artifact (for the authenticated `files/*` route):
 * the extension and the leading bytes decide, exactly like a published file.
 */
export function fileType(fileName: string, head: Uint8Array): ArtifactType & { inline: boolean } {
  const type = classifyArtifact(fileName, head);
  // HTML never renders on the app origin; download-only kinds never render inline.
  const inline = type.kind !== "file" && type.kind !== "archive" && type.kind !== "dashboard";
  return { ...type, inline };
}
