/** Listing a scratchpad is bounded: it stops walking at the cap instead of sorting the whole tree. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listScratch } from "../packages/core/src/forge/scratch-files.ts";

let pad: string;
beforeEach(async () => {
  pad = await mkdtemp(join(tmpdir(), "alisio-scratch-list-"));
});
afterEach(() => rm(pad, { recursive: true, force: true }));

describe("listScratch (L3)", () => {
  it("stops after the cap with truncated:true, without examining the rest of the tree", async () => {
    await Promise.all(
      Array.from({ length: 3000 }, (_, i) =>
        writeFile(join(pad, `f${String(i).padStart(4, "0")}`), ""),
      ),
    );
    const result = await listScratch(pad, 10);
    expect(result.truncated).toBe(true);
    expect(result.files.map((f) => f.name)).toEqual(
      Array.from({ length: 10 }, (_, i) => `f${String(i).padStart(4, "0")}`),
    );
    // One past the cap is enough to know there is more.
    expect(result.scanned).toBeLessThanOrEqual(11);
  });

  it("keeps the order of a full sort by name (a directory sorts as 'name/')", async () => {
    await mkdir(join(pad, "a"));
    await writeFile(join(pad, "a", "x"), "1");
    await writeFile(join(pad, "a.txt"), "2");
    await writeFile(join(pad, "b"), "3");
    const result = await listScratch(pad);
    expect(result.files.map((f) => f.name)).toEqual(["a.txt", "a/x", "b"]);
    expect(result.truncated).toBe(false);
  });

  it("does not descend past a depth bound", async () => {
    let dir = pad;
    for (let i = 0; i < 40; i++) {
      dir = join(dir, "d");
      await mkdir(dir);
    }
    await writeFile(join(dir, "deep.txt"), "x");
    await writeFile(join(pad, "top.txt"), "x");
    const names = (await listScratch(pad)).files.map((f) => f.name);
    expect(names).toEqual(["top.txt"]);
  });
});
