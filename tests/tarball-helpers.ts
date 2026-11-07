/** Builds gzip ustar tarballs in memory for tests (what `npm pack` produces, minus the extras). */
import { gzipSync } from "node:zlib";

export interface TarEntry {
  name: string;
  data?: string | Buffer;
  /** ustar type flag: "0" file (default), "5" directory, "2" symlink, "x" pax header. */
  type?: string;
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(entry: TarEntry, size: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(entry.name.slice(0, 100), 0, "utf8");
  block.write(octal(0o644, 8), 100);
  block.write(octal(0, 8), 108);
  block.write(octal(0, 8), 116);
  block.write(octal(size, 12), 124);
  block.write(octal(0, 12), 136);
  block.write("        ", 148);
  block.write(entry.type ?? "0", 156);
  block.write("ustar\0", 257);
  block.write("00", 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

export function tar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "");
    parts.push(header(entry, data.length), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export const tgz = (entries: TarEntry[]): Buffer => gzipSync(tar(entries));

/** A private-plugin-like package.json (the shape of alisio-plugin-ica-0.1.0.tgz). */
export function pluginManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "@alisio/plugin-ica",
    version: "0.1.0",
    description: "Private demo plugin",
    author: "Alisio",
    license: "MIT",
    type: "module",
    keywords: ["alisio-plugin", "alisio-private-plugin"],
    exports: { ".": "./dist/index.js" },
    peerDependencies: { "@alisio/sdk": "^0.5.1" },
    ...over,
  };
}

/** A valid plugin tarball: `package/package.json` plus an entry file. */
export function pluginTarball(over: Record<string, unknown> = {}): Buffer {
  return tgz([
    { name: "package/", type: "5" },
    { name: "package/dist/index.js", data: "export default {};\n" },
    { name: "package/package.json", data: JSON.stringify(pluginManifest(over)) },
  ]);
}
