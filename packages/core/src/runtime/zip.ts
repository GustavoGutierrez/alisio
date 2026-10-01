/**
 * Streaming ZIP writer on `node:zlib` (no dependency): DEFLATE entries with a data descriptor,
 * UTF-8 names (general-purpose bit 11) and no ZIP64, so archives and entries must stay below
 * 4 GiB. Used for multi-file artifact downloads and for folders published as one archive.
 */
import { createReadStream } from "node:fs";
import { createDeflateRaw } from "node:zlib";

export type ZipEntry = { name: string; source: string } | { name: string; data: Uint8Array };

let table: Uint32Array | undefined;
/** CRC-32 (IEEE) of `bytes`, continuing from `crc`. */
export function crc32(bytes: Uint8Array, crc = 0): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let value = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++)
    value = (table[(value ^ (bytes[i] as number)) & 0xff] as number) ^ (value >>> 8);
  return ~value >>> 0;
}

/** MS-DOS date and time of `date` (local time, 2-second resolution, 1980 minimum). */
function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const LIMIT = 0xffff_ffff;

/** Something to write the archive to (an HTTP response, a file stream…), honoring backpressure. */
export interface ZipSink {
  write(chunk: Buffer): boolean;
  once(event: "drain", listener: () => void): unknown;
}

/**
 * Writes `entries` as a ZIP archive to `out`, streaming file contents. Entry names use `/` and
 * must be relative; the caller validates them. Throws when the archive would need ZIP64.
 */
export async function writeZip(
  entries: ZipEntry[],
  out: ZipSink,
  options: { now?: Date; signal?: AbortSignal } = {},
): Promise<{ bytes: number }> {
  if (entries.length > 0xffff) throw new Error("ZIP archives hold at most 65535 entries");
  let offset = 0;
  const put = async (chunk: Buffer) => {
    options.signal?.throwIfAborted();
    offset += chunk.byteLength;
    if (offset > LIMIT) throw new Error("ZIP archives larger than 4 GiB are not supported");
    if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
  };
  const { time, date } = dosTime(options.now ?? new Date());
  const central: Buffer[] = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const start = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.length, 26);
    await put(local);
    await put(name);
    let crc = 0,
      size = 0,
      compressed = 0;
    const deflate = createDeflateRaw();
    const feed =
      "data" in entry
        ? (async () => {
            crc = crc32(entry.data);
            size = entry.data.byteLength;
            deflate.end(Buffer.from(entry.data));
          })()
        : new Promise<void>((resolve, reject) => {
            const input = createReadStream(entry.source);
            input.on("data", (chunk) => {
              const bytes = chunk as Buffer;
              crc = crc32(bytes, crc);
              size += bytes.byteLength;
            });
            input.once("error", (error) => {
              deflate.destroy(error);
              reject(error);
            });
            input.once("end", resolve);
            input.pipe(deflate);
          });
    for await (const chunk of deflate) {
      compressed += (chunk as Buffer).byteLength;
      await put(chunk as Buffer);
    }
    await feed;
    if (size > LIMIT || compressed > LIMIT)
      throw new Error("ZIP entries larger than 4 GiB are not supported");
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(size, 12);
    await put(descriptor);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0x0808, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(start, 42);
    central.push(header, name);
  }
  const directoryStart = offset;
  for (const part of central) await put(part);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - directoryStart, 12);
  end.writeUInt32LE(directoryStart, 16);
  await put(end);
  return { bytes: offset };
}
