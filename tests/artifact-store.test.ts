import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore, slugify } from "../packages/core/src/artifacts/store.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

let root: string;
let staging: string;
let db: SQLiteStore;
let store: ArtifactStore;
const owner = {
  sessionId: "child-1",
  rootSessionId: "root-1",
  workspace: "/work/space",
  runId: "run-1",
  callId: "call-1",
  executionId: "exec_1",
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alisio-artifacts-"));
  staging = join(root, "job", "staging");
  await mkdir(staging, { recursive: true });
  db = new SQLiteStore(join(root, "state", "sessions.sqlite"));
  db.db
    .prepare(
      `INSERT INTO analysis_executions(id,session,root_session,workspace,runtime,status,script_sha256,rel_dir,created_at)
       VALUES('exec_1','child-1','root-1','/work/space','managed','completed','x','j',1)`,
    )
    .run();
  store = new ArtifactStore({ root: join(root, "state"), db: db.db });
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

/** Every file under a directory, relative, sorted. */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, prefix: string) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(d, entry.name), rel);
      else out.push(rel);
    }
  };
  await walk(dir, "").catch(() => {});
  return out.sort();
}
const rows = () => db.db.prepare("SELECT count(*) AS n FROM artifacts").get() as { n: number };

describe("ArtifactStore.publishOutputs", () => {
  it("publishes each top-level file as a byte-identical copy, outside the job folder", async () => {
    await writeFile(join(staging, "report.md"), "# Report\n");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
    await writeFile(join(staging, "chart.svg"), svg);
    const published = await store.publishOutputs(staging, owner);
    expect(published.map((p) => [p.artifact.fileName, p.artifact.kind])).toEqual([
      ["chart.svg", "image"],
      ["report.md", "document"],
    ]);
    for (const p of published) {
      expect(p.artifact.status).toBe("ready");
      expect(p.artifact.sessionId).toBe("root-1");
      expect(p.path.startsWith(join(root, "state", "artifacts"))).toBe(true);
    }
    expect(await readFile(published[1]?.path ?? "", "utf8")).toBe("# Report\n");
    expect(await readFile(published[0]?.path ?? "", "utf8")).toBe(svg);
    expect(rows().n).toBe(2);
    const files = await tree(join(root, "state", "artifacts"));
    expect(files.filter((f) => /\.py$|\.log$|job\.json$/.test(f))).toEqual([]);
    expect(files.filter((f) => f.endsWith("manifest.json"))).toHaveLength(2);
    const manifest = JSON.parse(
      await readFile(join(published[1]?.path ?? "", "..", "..", "manifest.json"), "utf8"),
    );
    expect(manifest).toMatchObject({ schemaVersion: 1, kind: "document", fileName: "report.md" });
    expect(JSON.stringify(manifest)).not.toContain(root);
  });

  it("publishes a folder with index.html and assets as one multi-file dashboard", async () => {
    await mkdir(join(staging, "sales-dashboard", "assets"), { recursive: true });
    await writeFile(
      join(staging, "sales-dashboard", "index.html"),
      '<script src="assets/app.js"></script><img src="assets/missing.png">',
    );
    await writeFile(join(staging, "sales-dashboard", "assets", "app.js"), "1");
    const [published] = await store.publishOutputs(staging, owner);
    expect(published?.artifact).toMatchObject({
      kind: "dashboard",
      fileCount: 2,
      fileName: "sales-dashboard.zip",
      mimeType: "text/html; charset=utf-8",
    });
    expect(published?.path.endsWith(join("files", "index.html"))).toBe(true);
    expect(published?.warnings.join()).toContain("assets/missing.png");
    const record = store.get(published?.artifact.id ?? "");
    expect((await store.files(record as never)).map((f) => f.path)).toEqual([
      "assets/app.js",
      "index.html",
    ]);
  });

  it("archives a folder without an entry as one ZIP", async () => {
    await mkdir(join(staging, "csvs"));
    await writeFile(join(staging, "csvs", "a.csv"), "a\n1\n");
    const [published] = await store.publishOutputs(staging, owner);
    expect(published?.artifact).toMatchObject({ kind: "archive", fileName: "csvs.zip" });
  });

  it("honors outputs.json titles and entries and publishes only what it lists", async () => {
    await writeFile(join(staging, "summary.md"), "x");
    await writeFile(join(staging, "scratch.txt"), "not listed");
    await writeFile(
      join(staging, "outputs.json"),
      JSON.stringify({ artifacts: [{ path: "summary.md", title: "Executive summary" }] }),
    );
    const published = await store.publishOutputs(staging, owner);
    expect(published.map((p) => p.artifact.title)).toEqual(["Executive summary"]);
    expect(published[0]?.path).toContain("executive-summary--art_");
  });

  it("does not duplicate a republished execution", async () => {
    await writeFile(join(staging, "a.md"), "x");
    const first = await store.publishOutputs(staging, owner);
    const second = await store.publishOutputs(staging, owner);
    expect(second[0]?.artifact.id).toBe(first[0]?.artifact.id);
    expect(rows().n).toBe(1);
  });

  const rejects = async (message: RegExp) => {
    await expect(store.publishOutputs(staging, owner)).rejects.toThrow(message);
    expect(rows().n).toBe(0);
    expect(
      (await tree(join(root, "state", "artifacts"))).filter((f) => !f.startsWith(".")),
    ).toEqual([]);
  };

  // Creating symbolic links needs extra privileges on Windows.
  it.skipIf(process.platform === "win32")(
    "rejects a symbolic link and publishes nothing",
    async () => {
      await writeFile(join(staging, "ok.md"), "fine");
      await writeFile(join(root, "secret.txt"), "secret");
      await symlink(join(root, "secret.txt"), join(staging, "leak.txt"));
      await rejects(/symbolic links/);
    },
  );

  it("rejects hard links", async () => {
    await writeFile(join(root, "outside.txt"), "x");
    await link(join(root, "outside.txt"), join(staging, "hard.txt"));
    await rejects(/hard-linked/);
  });

  it("rejects .. in outputs.json", async () => {
    await writeFile(
      join(staging, "outputs.json"),
      JSON.stringify({ artifacts: [{ path: "../escape.md" }] }),
    );
    await rejects(/relative path components/);
  });

  it("rejects exceeding maxFiles or maxFileBytes as a whole", async () => {
    store = new ArtifactStore({
      root: join(root, "state"),
      db: db.db,
      limits: { maxFiles: 2, maxFileBytes: 10 },
    });
    await writeFile(join(staging, "a.md"), "1");
    await writeFile(join(staging, "b.md"), "2");
    await writeFile(join(staging, "c.md"), "3");
    await rejects(/maxFiles/);
    await rm(join(staging, "c.md"));
    await writeFile(join(staging, "b.md"), "this is longer than ten bytes");
    await rejects(/maxFileBytes/);
  });

  it("classifies a file whose bytes contradict its extension as download-only", async () => {
    await writeFile(join(staging, "image.png"), "<script>alert(1)</script>");
    const [published] = await store.publishOutputs(staging, owner);
    expect(published?.artifact).toMatchObject({ kind: "file", previewable: false });
  });
});

describe("ArtifactStore listing, text and delete", () => {
  it("publishes text, lists newest first per root session and deletes", async () => {
    const plain = { sessionId: "root-1", rootSessionId: "root-1", workspace: "/work/space" };
    const a = await store.publishText({ fileName: "notes.md", text: "# a" }, plain);
    const b = await store.publishText(
      { fileName: "data.json", title: "Data", text: "{}" },
      { ...plain, partial: true },
    );
    await store.publishText(
      { fileName: "other.md", text: "x" },
      { ...plain, rootSessionId: "root-2", sessionId: "root-2" },
    );
    expect(b.artifact).toMatchObject({ partial: true, kind: "data", previewable: true });
    const listed = store.list("root-1");
    expect(listed.map((r) => r.id).sort()).toEqual([a.artifact.id, b.artifact.id].sort());
    expect(store.list("root-1", { kind: "data" }).map((r) => r.id)).toEqual([b.artifact.id]);
    expect(await store.delete(a.artifact.id)).toBe(true);
    expect(store.get(a.artifact.id)?.status).toBe("deleted");
    expect(store.list("root-1").map((r) => r.id)).toEqual([b.artifact.id]);
    await expect(readFile(a.path)).rejects.toThrow();
  });

  it("slugifies titles to at most 48 safe characters", () => {
    expect(slugify("Informe Año 2026: ventas!")).toBe("informe-ano-2026-ventas");
    expect(slugify("💥")).toBe("artifact");
    expect(slugify("x".repeat(80))).toHaveLength(48);
  });
});
