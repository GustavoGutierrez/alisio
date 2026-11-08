import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { documentEngineStatus } from "../packages/core/src/index.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alisio-doc-status-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("documentEngineStatus (DOC-AC-31)", () => {
  it("reports ready with the version for a modern browser", async () => {
    const fake = join(dir, "chrome");
    await writeFile(fake, "#!/bin/sh\necho 'Chromium 140.0.7000.1'\n");
    await chmod(fake, 0o755);
    const [chromium] = await documentEngineStatus({ explicitPath: fake });
    expect(chromium).toMatchObject({
      id: "chromium",
      ready: true,
      version: "Chromium 140.0.7000.1",
    });
  });

  it("reports why not and how to fix: missing browser and a too old one", async () => {
    const [none] = await documentEngineStatus({ explicitPath: join(dir, "missing") });
    expect(none).toMatchObject({
      ready: false,
      reason: expect.stringMatching(/chromiumPath/),
      fix: expect.stringMatching(/chromiumPath/),
    });
    const old = join(dir, "old");
    await writeFile(old, "#!/bin/sh\necho 'Chromium 110.0.1.1'\n");
    await chmod(old, 0o755);
    const [stale] = await documentEngineStatus({ explicitPath: old });
    expect(stale).toMatchObject({
      ready: false,
      reason: expect.stringMatching(/older than Chromium 131/),
    });
  });

  it("finds no browser through PATH, env and known paths when none exists", async () => {
    const [r] = await documentEngineStatus({
      detect: { platform: "linux", env: { PATH: dir }, exists: async () => false },
    });
    expect(r).toMatchObject({ ready: false, fix: expect.stringMatching(/package manager/) });
    const [w] = await documentEngineStatus({
      detect: { platform: "win32", env: {}, exists: async () => false },
    });
    expect(w?.fix).toMatch(/Edge/);
  });
});
