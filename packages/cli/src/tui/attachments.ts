/**
 * Image attachments for the TUI message composer: clipboard image paste (Ctrl+V), a bounded
 * pending list shown above the editor, and the SDK content shape sent with the next message.
 * Pure and dependency-injected so it is fully unit-testable; pi-tui APIs (native clipboard,
 * image dimensions, rendering) are wired in by apps/cli/src/tui/app.ts.
 */
import type { Attachment } from "@alisio/sdk";

/** Single image cap (raw bytes, before base64). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Attachments allowed on one outgoing message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;

export interface PendingAttachment {
  id: string;
  mimeType: string;
  /** Base64-encoded bytes, no `data:` prefix. */
  data: string;
  bytes: number;
  width?: number;
  height?: number;
}
export type AttachmentRejection = "empty" | "unsupported-format" | "too-large" | "too-many";

const MAGIC: Array<{ mime: string; test: (b: Uint8Array) => boolean }> = [
  {
    mime: "image/png",
    test: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    mime: "image/jpeg",
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: "image/gif",
    test: (b) => b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,
  },
  {
    mime: "image/webp",
    test: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
];
/** Detects PNG/JPEG/GIF/WebP by magic bytes; other formats are not supported. */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  return MAGIC.find((m) => m.test(bytes))?.mime;
}

const defaultId = () => crypto.randomUUID();
export interface BuildOptions {
  maxBytes?: number;
  /** Injected so the pure module never imports a pi-tui image decoder itself. */
  dimensions?: (base64: string, mimeType: string) => { widthPx: number; heightPx: number } | null;
  id?: () => string;
}
export function buildAttachment(
  bytes: Uint8Array,
  options: BuildOptions = {},
): { ok: true; attachment: PendingAttachment } | { ok: false; error: AttachmentRejection } {
  if (!bytes.length) return { ok: false, error: "empty" };
  if (bytes.length > (options.maxBytes ?? MAX_IMAGE_BYTES))
    return { ok: false, error: "too-large" };
  const mimeType = sniffImageMime(bytes);
  if (!mimeType) return { ok: false, error: "unsupported-format" };
  const data = Buffer.from(bytes).toString("base64");
  const dims = options.dimensions?.(data, mimeType) ?? null;
  return {
    ok: true,
    attachment: {
      id: (options.id ?? defaultId)(),
      mimeType,
      data,
      bytes: bytes.length,
      ...(dims ? { width: dims.widthPx, height: dims.heightPx } : {}),
    },
  };
}

export interface ListOptions extends BuildOptions {
  maxCount?: number;
}
/** Appends within the count limit; the input list is never mutated. */
export function addAttachment(
  list: readonly PendingAttachment[],
  bytes: Uint8Array,
  options: ListOptions = {},
): { list: PendingAttachment[]; error?: AttachmentRejection } {
  if (list.length >= (options.maxCount ?? MAX_ATTACHMENTS_PER_MESSAGE))
    return { list: [...list], error: "too-many" };
  const result = buildAttachment(bytes, options);
  if (!result.ok) return { list: [...list], error: result.error };
  return { list: [...list, result.attachment] };
}
export function removeLastAttachment(list: readonly PendingAttachment[]): {
  list: PendingAttachment[];
  removed?: PendingAttachment;
} {
  if (!list.length) return { list: [] };
  return { list: list.slice(0, -1), removed: list.at(-1) };
}

const kb = (bytes: number) => (bytes / 1024).toFixed(1);
/** `[N] image/png 1024x768, 42.0 KB` — a compact fallback for terminals without inline images. */
export function attachmentCaption(a: PendingAttachment, index: number): string {
  const dims = a.width && a.height ? `${a.width}x${a.height}, ` : "";
  return `[${index + 1}] ${a.mimeType} ${dims}${kb(a.bytes)} KB`;
}
export function rejectionMessage(error: AttachmentRejection, options: ListOptions = {}): string {
  const maxMb = (options.maxBytes ?? MAX_IMAGE_BYTES) / (1024 * 1024);
  const maxCount = options.maxCount ?? MAX_ATTACHMENTS_PER_MESSAGE;
  switch (error) {
    case "empty":
      return "The clipboard image is empty.";
    case "unsupported-format":
      return "Unsupported image format (only PNG, JPEG, GIF and WebP are recognized).";
    case "too-large":
      return `Image exceeds the ${maxMb} MB limit per attachment.`;
    case "too-many":
      return `Maximum ${maxCount} attachments per message.`;
  }
}
/** The SDK content shape sent alongside the message text. */
export function toApiAttachment(a: PendingAttachment): Attachment {
  return {
    kind: "image",
    mimeType: a.mimeType,
    data: a.data,
    bytes: a.bytes,
    ...(a.width !== undefined ? { width: a.width } : {}),
    ...(a.height !== undefined ? { height: a.height } : {}),
  };
}

export interface ClipboardImageSource {
  getImage(): Promise<Uint8Array | null | undefined>;
}
/**
 * Ctrl+V: undefined clipboard (no platform helper, e.g. plain SSH without X11/wl-clipboard) is a
 * graceful no-op; `getImage()` resolving `null` means an empty (non-image) clipboard, `undefined`
 * means the image source itself is unavailable; a rejected read is reported, never thrown.
 */
export async function pasteImageFromClipboard(
  clipboard: ClipboardImageSource | undefined,
  current: readonly PendingAttachment[],
  options: ListOptions = {},
): Promise<{ list: PendingAttachment[]; message?: string }> {
  if (!clipboard)
    return {
      list: [...current],
      message:
        "No native clipboard access here (e.g. over SSH, or without a platform clipboard helper).",
    };
  let bytes: Uint8Array | null | undefined;
  try {
    bytes = await clipboard.getImage();
  } catch (error) {
    return {
      list: [...current],
      message: `Clipboard read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (bytes === undefined)
    return {
      list: [...current],
      message: "Image clipboard access is not available on this platform or session.",
    };
  if (bytes === null) return { list: [...current], message: "Clipboard has no image." };
  const { list, error } = addAttachment(current, bytes, options);
  return error ? { list, message: rejectionMessage(error, options) } : { list };
}
