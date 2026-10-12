/**
 * The wasm backend never grants the real scratchpad: it grants a copy made without following
 * links. These tests pin the copy itself (the launch path is covered in the backend suite).
 */
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyScratchNoFollow } from "../packages/core/src/forge/python/scratch-copy.ts";

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "alisio-scratch-copy-"));
});
afterEach(() => rm(base, { recursive: true, force: true }));

const tree = async (dir: string, prefix = ""): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) out.push(...(await tree(join(dir, entry.name), `${name}/`)));
    else out.push(name);
  }
  return out.sort();
};

describe("copyScratchNoFollow", () => {
  it("keeps regular files and relative paths and leaves links out, however they point", async () => {
    const src = join(base, "pad");
    const outside = join(base, "outside");
    await mkdir(join(src, "sub"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await writeFile(join(src, "a.py"), "print(1)");
    await writeFile(join(src, "sub", "b.txt"), "b");
    await symlink(outside, join(src, "link"));
    await symlink(join(outside, "secret.txt"), join(src, "sub", "file-link"));
    await symlink("sub", join(src, "inner-link"));
    const dst = join(base, "copy");
    const result = await copyScratchNoFollow(src, dst);
    expect(await tree(dst)).toEqual(["a.py", "sub/b.txt"]);
    expect(await readFile(join(dst, "sub", "b.txt"), "utf8")).toBe("b");
    expect(result).toEqual({ files: 2, bytes: 9 });
  });

  it("skips what does not fit the cap and keeps the rest", async () => {
    const src = join(base, "pad");
    await mkdir(src);
    await writeFile(join(src, "big.bin"), Buffer.alloc(50));
    await writeFile(join(src, "small.txt"), "ok");
    const dst = join(base, "copy");
    await copyScratchNoFollow(src, dst, 10);
    expect(await tree(dst)).toEqual(["small.txt"]);
  });
});
