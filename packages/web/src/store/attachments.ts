/**
 * Composer image attachments (RF-06): client-side checks that mirror the server's (10 MB,
 * PNG/JPEG/GIF/WebP; the server still sniffs the bytes) and the pending-upload list. Pure.
 */
import type { BlobRef } from "@alisio/sdk";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export type Rejection = "too-large" | "unsupported" | "too-many" | "empty";

export interface PendingAttachment {
  id: string;
  name: string;
  /** Object URL of the local file (thumbnail). */
  url: string;
  bytes: number;
  status: "uploading" | "ready" | "failed";
  ref?: BlobRef;
  error?: string;
}

/** Why a file cannot be attached (undefined when it can). */
export function checkFile(
  file: { size: number; type: string },
  count: number,
): Rejection | undefined {
  if (count >= MAX_ATTACHMENTS) return "too-many";
  if (!IMAGE_TYPES.includes(file.type)) return "unsupported";
  if (file.size === 0) return "empty";
  if (file.size > MAX_ATTACHMENT_BYTES) return "too-large";
  return undefined;
}

export const updateAttachment = (
  list: PendingAttachment[],
  id: string,
  patch: Partial<PendingAttachment>,
): PendingAttachment[] => list.map((a) => (a.id === id ? { ...a, ...patch } : a));

export const readyRefs = (list: PendingAttachment[]): BlobRef[] =>
  list.flatMap((a) => (a.status === "ready" && a.ref ? [a.ref] : []));

/** Text or at least one uploaded image, and no upload still running. */
export const canSend = (text: string, list: PendingAttachment[]): boolean =>
  !list.some((a) => a.status === "uploading") &&
  (text.trim().length > 0 || readyRefs(list).length > 0);
