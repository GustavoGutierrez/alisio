import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  inspectPluginTarball,
  packDirectory,
  TarballWriteError,
  writeTarGz,
} from "../packages/core/src/index.ts";

/** Lists `{name, mode, size, type, data}` of every entry of a plain ustar archive (test side). */
function entries(tgz: Buffer) {
  const tar = gunzipSync(tgz);
  const out: Array<{ name: string; mode: number; type: string; data: string; mtime: number }> = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break;
    const field = (start: number, length: number) => {
      const slice = block.subarray(start, start + length);
      const end = slice.indexOf(0);
      return slice.subarray(0, end < 0 ? length : end).toString("utf8");
    };
    const own = field(0, 100);
    const prefix = field(345, 155);
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const data = tar.subarray(offset + 512, offset + 512 + size).toString("utf8");
    out.push({
      name: prefix ? `${prefix}/${own}` : own,
      mode: Number.parseInt(field(100, 8).trim(), 8),
      type: field(156, 1) || "0",
      mtime: Number.parseInt(field(136, 12).trim(), 8),
      data,
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "alisio-pack-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

const manifest = {
  name: "alisio-plugin-hello",
  version: "0.1.0",
  type: "module",
  keywords: ["alisio-plugin"],
  exports: { ".": "./src/index.js" },
  files: ["src"],
  peerDependencies: { "@alisio/sdk": "^0.11.0" },
};

describe("writeTarGz (gzip + ustar writer)", () => {
  it("round-trips through the plugin tarball reader with a package/ prefix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alisio-tgz-w-"));
    const out = join(dir, "x.tgz");
    await writeTarGz(out, [
      { path: "package.json", data: Buffer.from(JSON.stringify(manifest)) },
      { path: "src/index.js", data: Buffer.from("export default {};\n") },
    ]);
    const info = await inspectPluginTarball(out);
    expect(info).toMatchObject({
      isAlisioPlugin: true,
      name: "alisio-plugin-hello",
      version: "0.1.0",
      sdkRange: "^0.11.0",
    });
    const listed = entries(await readFile(out));
    expect(listed.map((e) => e.name)).toEqual(["package/package.json", "package/src/index.js"]);
    expect(listed.every((e) => e.mode === 0o644 && e.type === "0")).toBe(true);
  });

  it("is deterministic: the same input gives the same bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alisio-tgz-d-"));
    const input = [
      { path: "b.js", data: Buffer.from("b") },
      { path: "a.js", data: Buffer.from("a") },
    ];
    await writeTarGz(join(dir, "1.tgz"), input);
    await writeTarGz(join(dir, "2.tgz"), [...input].reverse());
    expect(await readFile(join(dir, "1.tgz"))).toEqual(await readFile(join(dir, "2.tgz")));
  });

  it("stores long paths through the ustar prefix field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alisio-tgz-l-"));
    const long = `${"deep/".repeat(25)}file.js`;
    await writeTarGz(join(dir, "x.tgz"), [{ path: long, data: Buffer.from("x") }]);
    expect(entries(await readFile(join(dir, "x.tgz")))[0]?.name).toBe(`package/${long}`);
  });

  it("rejects unsafe paths and over-limit inputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alisio-tgz-r-"));
    const out = join(dir, "x.tgz");
    for (const path of ["../evil.js", "/abs.js", "a/../../b.js", "a\\b.js", "C:/x.js", ""])
      await expect(writeTarGz(out, [{ path, data: Buffer.from("x") }])).rejects.toBeInstanceOf(
        TarballWriteError,
      );
    await expect(
      writeTarGz(out, [{ path: "a.js", data: Buffer.alloc(10) }], { maxBytes: 5 }),
    ).rejects.toThrow(/too large/);
    await expect(
      writeTarGz(
        out,
        [
          { path: "a.js", data: Buffer.from("a") },
          { path: "b.js", data: Buffer.from("b") },
        ],
        { maxEntries: 1 },
      ),
    ).rejects.toThrow(/too many/);
    await expect(
      writeTarGz(out, [
        { path: "a.js", data: Buffer.from("a") },
        { path: "a.js", data: Buffer.from("b") },
      ]),
    ).rejects.toThrow(/duplicate/i);
  });
});

describe("packDirectory (npm-like file selection)", () => {
  it("packs package.json, README/LICENSE and the `files` entries only", async () => {
    const dir = await project({
      "package.json": JSON.stringify(manifest),
      "README.md": "# Hello",
      LICENSE: "MIT",
      "src/index.js": "export default {};",
      "src/lib/util.js": "export const x = 1;",
      "test/plugin.test.js": "// not shipped",
      ".secret": "nope",
      "src/.hidden.js": "nope",
    });
    const out = join(dir, "..", "out.tgz");
    const result = await packDirectory(dir, out);
    expect(result.files).toEqual([
      "LICENSE",
      "README.md",
      "package.json",
      "src/index.js",
      "src/lib/util.js",
    ]);
    expect(result.bytes).toBeGreaterThan(0);
    expect((await inspectPluginTarball(out)).isAlisioPlugin).toBe(true);
  });

  it("refuses symlinks inside the packed files", async () => {
    const dir = await project({
      "package.json": JSON.stringify(manifest),
      "src/index.js": "export default {};",
    });
    await symlink("/etc/hosts", join(dir, "src", "link.js"));
    await expect(packDirectory(dir, join(dir, "..", "o.tgz"))).rejects.toThrow(/symbolic link/i);
  });

  it("refuses `files` entries that climb out of the project", async () => {
    const dir = await project({
      "package.json": JSON.stringify({ ...manifest, files: ["../outside"] }),
    });
    await expect(packDirectory(dir, join(dir, "..", "o.tgz"))).rejects.toBeInstanceOf(
      TarballWriteError,
    );
  });
});
