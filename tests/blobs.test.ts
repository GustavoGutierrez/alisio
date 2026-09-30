import { createHash } from "node:crypto";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment, Message, ModelProvider } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplication } from "../packages/core/src/application.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { BlobStore } from "../packages/core/src/runtime/blobs.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alisio-blobs-"));
  roots.push(root);
  const store = new SQLiteStore(join(root, "sessions.sqlite"));
  const blobs = new BlobStore({ root: join(root, "blobs"), db: store.db });
  return { root, store, blobs };
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("BlobStore (T-04)", () => {
  it("stores content-addressed bytes once, with private permissions", async () => {
    const { root, store, blobs } = await fixture();
    try {
      const ref = blobs.put(PNG, "image/png", { width: 1, height: 2 });
      expect(ref).toEqual({
        hash: sha(PNG),
        mimeType: "image/png",
        bytes: PNG.length,
        width: 1,
        height: 2,
      });
      expect(blobs.put(PNG, "image/png")).toEqual(ref);
      const file = join(root, "blobs", "sha256", ref.hash.slice(0, 2), ref.hash);
      expect(blobs.path(ref.hash)).toBe(file);
      if (process.platform !== "win32") {
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(statSync(join(root, "blobs", "sha256", ref.hash.slice(0, 2))).mode & 0o777).toBe(
          0o700,
        );
      }
      // One file per hash and no temporaries left behind (atomic write + dedup).
      expect(readdirSync(join(root, "blobs", "sha256", ref.hash.slice(0, 2)))).toEqual([ref.hash]);
      const rows = store.db.prepare("SELECT * FROM blobs").all();
      expect(rows).toEqual([
        expect.objectContaining({ hash: ref.hash, mime: "image/png", size: PNG.length }),
      ]);
      expect(blobs.has(ref.hash)).toBe(true);
      expect(blobs.get(ref.hash)).toEqual({ bytes: PNG, mimeType: "image/png" });
      expect(blobs.has("0".repeat(64))).toBe(false);
      expect(blobs.get("0".repeat(64))).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("rejects malformed hashes and tampered content", async () => {
    const { store, blobs } = await fixture();
    try {
      expect(() => blobs.path("../../etc/passwd")).toThrow(/Invalid blob hash/);
      expect(blobs.has("../x")).toBe(false);
      const ref = blobs.put(PNG, "image/png");
      writeFileSync(blobs.path(ref.hash), Buffer.from("tampered"));
      expect(() => blobs.attachment(ref)).toThrow(/does not match/);
      expect(() => blobs.put(PNG, "")).toThrow(/MIME type/);
    } finally {
      store.close();
    }
  });

  it("resolves a blob reference into a provider-ready base64 attachment", async () => {
    const { store, blobs } = await fixture();
    try {
      const ref = blobs.put(PNG, "image/png", { width: 3, height: 4 });
      expect(blobs.attachment(ref)).toEqual({
        kind: "image",
        mimeType: "image/png",
        data: PNG.toString("base64"),
        bytes: PNG.length,
        width: 3,
        height: 4,
      });
      const text = blobs.put(Buffer.from("hello"), "text/plain");
      expect(() => blobs.attachment(text)).toThrow(/image/);
      expect(() => blobs.attachment({ ...ref, hash: "f".repeat(64) })).toThrow(/not found/);
    } finally {
      store.close();
    }
  });

  it("delivers blob-backed and legacy inline attachments to the provider as base64", async () => {
    const { root, store, blobs } = await fixture();
    const seen: Message[][] = [];
    const provider: ModelProvider = {
      id: "test",
      model: "m",
      async *stream(request) {
        seen.push(request.messages);
        yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
      },
    };
    const runner = new AgentRunner({
      provider,
      registry: new ToolRegistry(),
      store,
      context: new ProjectContext(root),
      workspace: root,
      policy: { write: false, process: false, external: false },
    });
    try {
      const session = store.create(root, "test", "m").id;
      const fromBlob = blobs.attachment(blobs.put(PNG, "image/png"));
      await runner.run(session, "look", undefined, { attachments: [fromBlob] });
      const legacy: Attachment = {
        kind: "image",
        mimeType: "image/png",
        data: PNG.toString("base64"),
        bytes: PNG.length,
      };
      await runner.run(session, "again", undefined, { attachments: [legacy] });
      const attachmentsOf = (messages: Message[] | undefined) =>
        (messages ?? []).flatMap((m) => (m.role === "user" ? (m.attachments ?? []) : []));
      expect(attachmentsOf(seen[0]).map((a) => a.data)).toEqual([PNG.toString("base64")]);
      expect(attachmentsOf(seen[1]).map((a) => a.data)).toEqual([
        PNG.toString("base64"),
        PNG.toString("base64"),
      ]);
    } finally {
      store.close();
    }
  });

  it("is exposed by createApplication next to the session database", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-blobs-app-"));
    roots.push(root);
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config-home"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state-home"));
    const app = await createApplication({ cwd: root, noHerdr: true });
    try {
      const ref = app.blobs.put(PNG, "image/png");
      expect(app.blobs.path(ref.hash)).toBe(
        join(root, "state-home", "blobs", "sha256", ref.hash.slice(0, 2), ref.hash),
      );
    } finally {
      await app.close();
    }
  });
});
