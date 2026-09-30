/**
 * Content-addressed attachment bytes (v4). Files live at `<root>/sha256/<hash[0..2]>/<hash>`
 * (directories 0700, files 0600, atomic temp-file + rename); metadata lives in the `blobs` table
 * of the session database. Portable `node:fs`/`node:crypto` only (Node and Bun).
 *
 * `Attachment.data` stays required in the SDK, so blobs never reach the runner by reference: the
 * host resolves a `BlobRef` into a base64 `Attachment` with `attachment()` before `runner.run`.
 * Persisted messages therefore still carry base64 (as legacy inline attachments do).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Attachment, BlobRef, SqlDatabase } from "@alisio/sdk";

const HASH = /^[0-9a-f]{64}$/;
export interface BlobStoreOptions {
  /** Directory that holds `sha256/…` (by default `<state home>/blobs`). */
  root: string;
  /** Session database with the v4 `blobs` table (e.g. `SQLiteStore.db`). */
  db: SqlDatabase;
}
export class BlobStore {
  constructor(private readonly options: BlobStoreOptions) {}
  /** Absolute file path of a blob. Throws for anything that is not a lowercase sha256 hex. */
  path(hash: string): string {
    if (!HASH.test(hash)) throw new Error(`Invalid blob hash: ${hash.slice(0, 80)}`);
    return join(this.options.root, "sha256", hash.slice(0, 2), hash);
  }
  has(hash: string): boolean {
    return HASH.test(hash) && existsSync(this.path(hash)) && !!this.row(hash);
  }
  private row(hash: string) {
    return this.options.db.prepare("SELECT * FROM blobs WHERE hash=?").get(hash) as
      | { mime: string; size: number; width: number | null; height: number | null }
      | undefined;
  }
  /** Stores bytes once per content hash and returns their reference. */
  put(
    bytes: Uint8Array,
    mimeType: string,
    dims: { width?: number; height?: number } = {},
  ): BlobRef {
    const mime = mimeType.trim();
    if (!mime || mime.length > 255) throw new Error("A blob needs a MIME type");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const file = this.path(hash);
    if (!existsSync(file)) {
      const dir = join(this.options.root, "sha256", hash.slice(0, 2));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const temp = join(dir, `.tmp-${randomUUID()}`);
      try {
        writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
        renameSync(temp, file);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
    }
    this.options.db
      .prepare(
        "INSERT OR IGNORE INTO blobs(hash,mime,size,width,height,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(hash, mime, bytes.byteLength, dims.width ?? null, dims.height ?? null, Date.now());
    const row = this.row(hash);
    return {
      hash,
      mimeType: row?.mime ?? mime,
      bytes: bytes.byteLength,
      ...(row?.width != null ? { width: Number(row.width) } : {}),
      ...(row?.height != null ? { height: Number(row.height) } : {}),
    };
  }
  get(hash: string): { bytes: Buffer; mimeType: string } | undefined {
    if (!HASH.test(hash)) return undefined;
    const row = this.row(hash);
    const file = this.path(hash);
    if (!row || !existsSync(file)) return undefined;
    return { bytes: readFileSync(file), mimeType: row.mime };
  }
  /**
   * Resolves a reference into a provider-ready image `Attachment` (base64 `data`), verifying
   * that the stored bytes still match the hash.
   */
  attachment(ref: BlobRef): Attachment {
    const found = this.get(ref.hash);
    if (!found) throw new Error(`Blob not found: ${ref.hash}`);
    if (createHash("sha256").update(found.bytes).digest("hex") !== ref.hash)
      throw new Error(`Blob content does not match its hash: ${ref.hash}`);
    if (!found.mimeType.startsWith("image/"))
      throw new Error(`Only image blobs can be attached (got ${found.mimeType})`);
    return {
      kind: "image",
      mimeType: found.mimeType,
      data: found.bytes.toString("base64"),
      bytes: found.bytes.byteLength,
      ...(ref.width !== undefined ? { width: ref.width } : {}),
      ...(ref.height !== undefined ? { height: ref.height } : {}),
    };
  }
}
