import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { inflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { crc32, writeZip } from "../packages/core/src/runtime/zip.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function zipToBuffer(entries: Parameters<typeof writeZip>[0]): Promise<Buffer> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on("data", (chunk: Buffer) => chunks.push(chunk));
  await writeZip(entries, sink);
  sink.end();
  return Buffer.concat(chunks);
}

/** Reads the central directory: name, CRC, sizes and the inflated bytes of every entry. */
function readZip(zip: Buffer) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries: Array<{ name: string; flags: number; data: Buffer; crc: number }> = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const flags = zip.readUInt16LE(at + 8);
    const crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const localName = zip.readUInt16LE(local + 26);
    const dataStart = local + 30 + localName;
    const data = inflateRawSync(zip.subarray(dataStart, dataStart + compressed));
    entries.push({ name, flags, data, crc });
    at += 46 + nameLength;
  }
  return entries;
}

describe("writeZip", () => {
  it("round-trips files and in-memory entries with correct CRCs and UTF-8 names", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-zip-"));
    roots.push(root);
    const file = join(root, "informe año.txt");
    const big = Buffer.alloc(300_000, "abcdefghij");
    await writeFile(file, big);
    const zip = await zipToBuffer([
      { name: "informe año.txt", source: file },
      { name: "assets/data.json", data: Buffer.from('{"a":1}') },
      { name: "empty.txt", data: new Uint8Array() },
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual([
      "informe año.txt",
      "assets/data.json",
      "empty.txt",
    ]);
    expect(entries[0]?.data.equals(big)).toBe(true);
    expect(entries[0]?.crc).toBe(crc32(big));
    expect(entries[1]?.data.toString()).toBe('{"a":1}');
    expect(entries[2]?.data.length).toBe(0);
    for (const entry of entries) expect(entry.flags & 0x0800).toBe(0x0800);
  });

  it("computes the standard CRC-32", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  const python = ["python3", "python"].find(
    (cmd) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0,
  );
  it.skipIf(!python)(
    "passes `python -m zipfile -t` (skipped when Python is not installed)",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "alisio-zip-"));
      roots.push(root);
      const archive = join(root, "out.zip");
      await writeFile(
        archive,
        await zipToBuffer([
          { name: "ñandú/índice.html", data: Buffer.from("<h1>hola</h1>") },
          { name: "b.bin", data: Buffer.alloc(70_000, 7) },
        ]),
      );
      const result = spawnSync(python as string, ["-m", "zipfile", "-t", archive], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const listed = spawnSync(python as string, ["-m", "zipfile", "-l", archive], {
        encoding: "utf8",
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
      expect(listed.stdout).toContain("ñandú/índice.html");
    },
  );
});
