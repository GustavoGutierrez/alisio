import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  inspectPluginTarball,
  MAX_TARBALL_BYTES,
  readTarballPackageJson,
} from "../packages/core/src/index.ts";
import { pluginManifest, pluginTarball, tar, tgz } from "./tarball-helpers.ts";

const read = (buffer: Buffer, limits?: Parameters<typeof readTarballPackageJson>[1]) =>
  readTarballPackageJson(Readable.from([buffer]), limits);

async function file(buffer: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "alisio-tgz-"));
  const path = join(dir, "x.tgz");
  await writeFile(path, buffer);
  return path;
}

describe("readTarballPackageJson (ustar reader)", () => {
  it("reads package/package.json even after larger entries", async () => {
    const buffer = tgz([
      { name: "package/dist/big.js", data: "x".repeat(5000) },
      { name: "package/README.md", data: "hello" },
      { name: "package/package.json", data: '{"name":"a","version":"1.0.0"}' },
    ]);
    expect(await read(buffer)).toMatchObject({
      packageJson: { name: "a", version: "1.0.0" },
      entries: 3,
    });
  });

  it("applies a pax path header to the next entry", async () => {
    const long = `package/${"d/".repeat(60)}package.json`;
    const pax = `${String(` path=${long}\n`.length + 3)} path=${long}\n`;
    const buffer = tgz([
      { name: "PaxHeader", type: "x", data: pax },
      { name: "package/ignored", data: '{"name":"not-me"}' },
      { name: "package/package.json", data: '{"name":"a","version":"1.0.0"}' },
    ]);
    expect((await read(buffer)).packageJson).toEqual({ name: "a", version: "1.0.0" });
  });

  it("rejects path traversal and absolute entries", async () => {
    for (const name of ["package/../evil", "../evil", "/etc/passwd", "package/a/../../b"])
      await expect(
        read(
          tgz([
            { name, data: "x" },
            { name: "package/package.json", data: "{}" },
          ]),
        ),
      ).rejects.toThrow(/unsafe path/);
  });

  it("rejects a tarball without package/package.json", async () => {
    await expect(read(tgz([{ name: "package/index.js", data: "x" }]))).rejects.toThrow(
      /package\/package\.json/,
    );
    await expect(read(tgz([{ name: "other/package.json", data: "{}" }]))).rejects.toThrow(
      /package\/package\.json/,
    );
  });

  it("rejects an oversized package.json", async () => {
    const buffer = tgz([{ name: "package/package.json", data: `{"a":"${"x".repeat(2000)}"}` }]);
    await expect(read(buffer, { maxPackageJsonBytes: 1000 })).rejects.toThrow(/too large/);
  });

  it("stops after too many entries", async () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ name: `package/f${i}`, data: "x" }));
    await expect(
      read(tgz([...entries, { name: "package/package.json", data: "{}" }]), { maxEntries: 10 }),
    ).rejects.toThrow(/too many entries/);
  });

  it("bounds the decompressed size (gzip bombs)", async () => {
    const buffer = tgz([{ name: "package/blob", data: "0".repeat(200_000) }]);
    await expect(read(buffer, { maxExpandedBytes: 50_000 })).rejects.toThrow(/expands/);
  });

  it("rejects data that is not gzip, and invalid package.json", async () => {
    await expect(read(Buffer.from("this is not gzip at all"))).rejects.toThrow(/gzip/);
    await expect(read(gzipSync(Buffer.from("plain text, not a tar archive")))).rejects.toThrow();
    await expect(read(tgz([{ name: "package/package.json", data: "{not json" }]))).rejects.toThrow(
      /valid JSON/,
    );
  });

  it("rejects a corrupted header checksum", async () => {
    const raw = tar([{ name: "package/package.json", data: "{}" }]);
    raw[10] = 0x41;
    await expect(read(gzipSync(raw))).rejects.toThrow(/checksum|corrupt/);
  });
});

describe("inspectPluginTarball", () => {
  it("accepts an ica-like private plugin and reports its facts", async () => {
    const buffer = pluginTarball();
    const info = await inspectPluginTarball(await file(buffer));
    expect(info).toMatchObject({
      isAlisioPlugin: true,
      reasons: [],
      name: "@alisio/plugin-ica",
      version: "0.1.0",
      description: "Private demo plugin",
      author: "Alisio",
      license: "MIT",
      sdkRange: "^0.5.1",
      lifecycleScripts: [],
      size: buffer.length,
    });
  });

  it("reads an author object and a main entry point", async () => {
    const info = await inspectPluginTarball(
      await file(pluginTarball({ author: { name: "Ada" }, exports: undefined, main: "index.js" })),
    );
    expect(info.author).toBe("Ada");
    expect(info.isAlisioPlugin).toBe(true);
  });

  it.each([
    ["no alisio-plugin keyword", { keywords: ["other"] }, /alisio-plugin/],
    ["no keywords", { keywords: undefined }, /alisio-plugin/],
    ["invalid name", { name: "../evil" }, /name/],
    ["invalid version", { version: "latest" }, /version/],
    ["no entry point", { exports: undefined }, /entry point/],
  ])("rejects: %s", async (_label, over, reason) => {
    const info = await inspectPluginTarball(await file(pluginTarball(over)));
    expect(info.isAlisioPlugin).toBe(false);
    expect(info.reasons.join(" ")).toMatch(reason);
  });

  it("lists lifecycle scripts", async () => {
    const info = await inspectPluginTarball(
      await file(
        pluginTarball({ scripts: { postinstall: "node x.js", test: "vitest", preinstall: "y" } }),
      ),
    );
    expect(info.lifecycleScripts).toEqual(["preinstall", "postinstall"]);
    expect(info.isAlisioPlugin).toBe(true);
  });

  it("reports an unreadable tarball as not a plugin instead of throwing", async () => {
    const info = await inspectPluginTarball(await file(Buffer.from("nope")));
    expect(info.isAlisioPlugin).toBe(false);
    expect(info.reasons[0]).toMatch(/gzip/);
  });

  it("enforces the size cap before reading", async () => {
    const path = await file(Buffer.alloc(16));
    const info = await inspectPluginTarball(path, { maxBytes: 8 });
    expect(info.reasons.join(" ")).toMatch(/larger than/);
    expect(MAX_TARBALL_BYTES).toBe(50 * 1024 * 1024);
  });

  it("includes the manifest shape helper used by the other suites", () => {
    expect(pluginManifest().name).toBe("@alisio/plugin-ica");
  });
});
