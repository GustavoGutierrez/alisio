import type { IncomingMessage } from "node:http";
import { HttpError } from "./errors.ts";

/** Default JSON body limit (§11.1: JSON bodies ≤ 1 MB). */
export const MAX_JSON_BYTES = 1024 * 1024;

/** Reads the whole request body, failing with 413 as soon as it exceeds `limit` bytes. */
export async function readBody(req: IncomingMessage, limit = MAX_JSON_BYTES): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit)
    throw new HttpError("payload_too_large", `Request body exceeds ${limit} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) {
      req.resume();
      throw new HttpError("payload_too_large", `Request body exceeds ${limit} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Reads and parses a JSON body; an empty body is `{}`. Malformed JSON is a 400. */
export async function readJson(req: IncomingMessage, limit = MAX_JSON_BYTES): Promise<unknown> {
  const raw = await readBody(req, limit);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError("validation_failed", "Request body is not valid JSON");
  }
}
