import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepDocumentTmp } from "../packages/core/src/documents/janitor.ts";
import { RenderQueue } from "../packages/core/src/documents/queue.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alisio-doc-jan-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("janitor (DOC-AC-18)", () => {
  it("removes render dirs older than one hour and keeps newer ones", async () => {
    await mkdir(join(root, "old"));
    await mkdir(join(root, "new"));
    const now = Date.now();
    await utimes(join(root, "old"), new Date(now - 2 * 3600_000), new Date(now - 2 * 3600_000));
    expect(await sweepDocumentTmp(root, now)).toBe(1);
    expect(await readdir(root)).toEqual(["new"]);
  });
  it("tolerates a missing root", async () => {
    expect(await sweepDocumentTmp(join(root, "nope"))).toBe(0);
  });
});

describe("RenderQueue (DOC-AC-19)", () => {
  it("runs two at a time, queues the rest and answers DOCUMENT_BUSY past eight queued", async () => {
    const queue = new RenderQueue(2, 8);
    let running = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const job = () =>
      new Promise<void>((resolve) => {
        running++;
        peak = Math.max(peak, running);
        gates.push(() => {
          running--;
          resolve();
        });
      });
    const calls = Array.from({ length: 10 }, () => queue.run(job));
    await new Promise((r) => setTimeout(r, 10));
    expect(running).toBe(2);
    await expect(queue.run(job)).rejects.toMatchObject({ code: "DOCUMENT_BUSY" });
    while (gates.length) {
      gates.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    await Promise.all(calls);
    expect(peak).toBe(2);
  });
});
