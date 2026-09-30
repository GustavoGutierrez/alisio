/**
 * Attachment uploads (RF-06, spec §8.2/§11.1): `POST /api/blobs` takes the raw image bytes
 * (≤ 10 MB), trusts only their magic bytes (PNG, JPEG, GIF, WebP), stores them once in the
 * content-addressed `BlobStore` and answers the `BlobRef` a prompt then carries. `GET` serves
 * them back with the stored type, inline and immutable.
 */
import type { BlobStore } from "@alisio/core";
import type { BlobRef } from "@alisio/sdk";
import { readBody } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { sniffImage } from "./images.ts";

/** Per-image upload limit (spec RF-06). */
export const MAX_BLOB_BYTES = 10 * 1024 * 1024;

/** Declared types an upload may carry; the stored type always comes from the bytes. */
const DECLARED = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/octet-stream",
]);

export function registerBlobRoutes(router: Router, ctx: { blobs: BlobStore }): void {
  router.post("/api/blobs", async ({ req }) => {
    const declared = String(req.headers["content-type"] ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (!declared || !DECLARED.has(declared)) {
      req.resume();
      throw new HttpError(
        "unsupported_media_type",
        "Upload PNG, JPEG, GIF or WebP images as the raw request body",
      );
    }
    const bytes = await readBody(req, MAX_BLOB_BYTES);
    if (!bytes.length) throw new HttpError("validation_failed", "The upload is empty");
    const image = sniffImage(bytes);
    if (!image)
      throw new HttpError(
        "unsupported_media_type",
        "The file is not a PNG, JPEG, GIF or WebP image",
      );
    const { mimeType, ...dims } = image;
    return { status: 201, body: ctx.blobs.put(bytes, mimeType, dims) satisfies BlobRef };
  });

  router.get("/api/blobs/:hash", ({ params, res }) => {
    const found = ctx.blobs.get(params.hash ?? "");
    if (!found || !found.mimeType.startsWith("image/"))
      throw new HttpError("not_found", "Blob not found");
    res.writeHead(200, {
      "Content-Type": found.mimeType,
      "Content-Length": found.bytes.length,
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=31536000, immutable",
    });
    res.end(found.bytes);
    return undefined;
  });
}
