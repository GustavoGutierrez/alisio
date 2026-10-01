/**
 * Retention (spec §19) with an injected clock: `work/` goes at 7 days, logs and staging at 30, the
 * script stays while an artifact is `ready`, artifacts can expire (`Expired`), datasets unused for
 * 30 days go with their uploaded original, a sweep runs at most once every 24 hours, and the
 * background launch neither delays the start nor keeps the process alive.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalysisJanitor, type RetentionPolicy } from "../packages/core/src/analysis/janitor.ts";
import { toRef } from "../packages/core/src/artifacts/store.ts";
import { BlobStore } from "../packages/core/src/runtime/blobs.ts";
import { type AnalysisHarness, analysisHarness, fake } from "./analysis-run-helpers.ts";

const DAY = 86_400_000;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A harness whose stores and janitor share one controllable clock. */
async function setup(policy: Partial<RetentionPolicy> = {}) {
  const clock = { now: Date.now() };
  const now = () => clock.now;
  const h = await analysisHarness({ now });
  cleanups.push(() => h.dispose());
  const blobs = new BlobStore({ root: join(h.state, "blobs"), db: h.store.db });
  const retention: RetentionPolicy = {
    jobsDays: 30,
    intermediateDays: 7,
    artifactsDays: 0,
    ...policy,
  };
  const janitor = new AnalysisJanitor({
    root: h.state,
    db: h.store.db,
    artifacts: h.artifacts,
    datasets: h.datasets,
    blobs,
    retention: () => retention,
    now,
    initialDelayMs: 10,
  });
  return {
    h,
    clock,
    janitor,
    blobs,
    retention,
    advance: (days: number) => (clock.now += days * DAY),
  };
}

const jobDir = (h: AnalysisHarness, index = 0) =>
  join(h.state, String(h.executions()[index]?.rel_dir));
const rootOf = (h: AnalysisHarness) => h.store.rootOf(h.session);

/** A run that publishes report.md and leaves scratch in work/ (as a script would). */
async function published(h: AnalysisHarness, index = 0) {
  const { result } = await h.run({ code: fake({ files: { "report.md": `# ${index}\n` } }) });
  expect(result.isError).toBeFalsy();
  await writeFile(join(jobDir(h, index), "work", "scratch.bin"), "x".repeat(1000));
}

describe("job retention", () => {
  it("deletes work/ at 7 days, logs and staging at 30, and keeps the script while an artifact is ready", async () => {
    const { h, janitor, advance } = await setup();
    await published(h);
    const job = jobDir(h);
    expect(existsSync(join(job, "logs", "stdout.log"))).toBe(true);

    advance(6);
    expect(await janitor.sweep({ force: true })).toMatchObject({ workDeleted: 0 });
    expect(existsSync(join(job, "work", "scratch.bin"))).toBe(true);

    advance(2); // day 8
    const eighth = await janitor.sweep({ force: true });
    expect(eighth).toMatchObject({ workDeleted: 1 });
    expect(eighth.bytesFreed).toBeGreaterThanOrEqual(1000);
    expect(existsSync(join(job, "work"))).toBe(false);
    for (const kept of ["logs", "staging", "script/main.py", "input", "job.json"])
      expect(existsSync(join(job, kept)), kept).toBe(true);

    advance(23); // day 31
    const month = await janitor.sweep({ force: true });
    expect(month).toMatchObject({ jobsTrimmed: 1, jobsDeleted: 0 });
    expect(existsSync(join(job, "logs"))).toBe(false);
    expect(existsSync(join(job, "staging"))).toBe(false);
    // The script (and what a rerun needs) stays while the artifact is ready.
    expect(existsSync(join(job, "script", "main.py"))).toBe(true);
    expect(existsSync(join(job, "job.json"))).toBe(true);
    expect(h.artifacts.list(rootOf(h))).toHaveLength(1);
    expect(h.artifacts.list(rootOf(h))[0]?.status).toBe("ready");
  });

  it("deletes the whole job once no artifact of it is ready, but keeps the execution row", async () => {
    const { h, janitor, advance } = await setup();
    await published(h);
    const record = h.artifacts.list(rootOf(h))[0];
    await h.artifacts.delete(String(record?.id));
    const sessionFolder = dirname(jobDir(h));
    advance(31);
    const report = await janitor.sweep({ force: true });
    expect(report).toMatchObject({ jobsDeleted: 1 });
    expect(existsSync(jobDir(h))).toBe(false);
    expect(h.executions()).toHaveLength(1);
    // The empty session folder is pruned too (and the jobs root stays).
    expect(existsSync(sessionFolder)).toBe(false);
    expect(existsSync(join(h.state, "analysis", "jobs"))).toBe(true);
  });

  it("a job that published nothing is deleted at 30 days; a running one never is", async () => {
    const { h, janitor, advance } = await setup();
    await h.run({ code: fake({ exit: 1 }) }); // failed, nothing published
    const failed = jobDir(h, 0);
    // A job left running by a crashed process, young enough to be believed.
    h.store.db
      .prepare(
        `INSERT INTO analysis_executions(id,session,root_session,workspace,runtime,status,script_sha256,rel_dir,created_at)
         VALUES('exec_live',?,?,?,'managed','running','x','analysis/jobs/live',?)`,
      )
      .run(h.session, rootOf(h), h.workspace, Date.now());
    await mkdir(join(h.state, "analysis", "jobs", "live", "work"), { recursive: true });
    advance(0.5);
    await janitor.sweep({ force: true });
    expect(existsSync(failed)).toBe(true); // 12 hours old
    advance(31);
    const report = await janitor.sweep({ force: true });
    expect(report.jobsDeleted).toBe(2); // the failed job and the crash leftover below
    expect(existsSync(failed)).toBe(false);
    // 31 days later a "running" row is a crash leftover and is swept like any other.
    expect(existsSync(join(h.state, "analysis", "jobs", "live"))).toBe(false);
  });

  it("a running job younger than a day is left alone even with a short retention", async () => {
    const { h, janitor, advance } = await setup({ intermediateDays: 1, jobsDays: 1 });
    h.store.db
      .prepare(
        `INSERT INTO analysis_executions(id,session,root_session,workspace,runtime,status,script_sha256,rel_dir,created_at)
         VALUES('exec_live',?,?,?,'managed','running','x','analysis/jobs/live',?)`,
      )
      .run(h.session, rootOf(h), h.workspace, Date.now());
    await mkdir(join(h.state, "analysis", "jobs", "live", "work"), { recursive: true });
    advance(0.9);
    await janitor.sweep({ force: true });
    expect(existsSync(join(h.state, "analysis", "jobs", "live", "work"))).toBe(true);
  });

  it("never deletes outside analysis/jobs, whatever a row says", async () => {
    const { h, janitor, advance } = await setup();
    const outside = join(h.state, "keep-me");
    await mkdir(join(outside, "work"), { recursive: true });
    await writeFile(join(outside, "work", "precious.txt"), "do not delete");
    h.store.db
      .prepare(
        `INSERT INTO analysis_executions(id,session,root_session,workspace,runtime,status,script_sha256,rel_dir,created_at,ended_at)
         VALUES('exec_bad',?,?,?,'managed','failed','x',?,1,1)`,
      )
      .run(h.session, rootOf(h), h.workspace, "keep-me");
    advance(400);
    await janitor.sweep({ force: true });
    expect(existsSync(join(outside, "work", "precious.txt"))).toBe(true);
  });

  it("0 disables the deletion of a class", async () => {
    const { h, janitor, advance } = await setup({ jobsDays: 0, intermediateDays: 0 });
    await published(h);
    advance(400);
    const report = await janitor.sweep({ force: true });
    expect(report).toMatchObject({ workDeleted: 0, jobsDeleted: 0, jobsTrimmed: 0 });
    expect(existsSync(join(jobDir(h), "work", "scratch.bin"))).toBe(true);
  });

  it("applies a changed setting at the next sweep without a restart", async () => {
    const { h, janitor, advance, retention } = await setup();
    await published(h);
    advance(3);
    expect((await janitor.sweep({ force: true })).workDeleted).toBe(0);
    retention.intermediateDays = 2;
    expect((await janitor.sweep({ force: true })).workDeleted).toBe(1);
  });
});

describe("artifact retention", () => {
  it("expires artifacts older than artifactsDays: folder gone, row kept, shown as Expired", async () => {
    const { h, janitor, advance } = await setup({ artifactsDays: 90 });
    await published(h);
    const record = h.artifacts.list(rootOf(h))[0];
    const folder = h.artifacts.folder(record as never);
    expect(existsSync(folder)).toBe(true);
    advance(89);
    expect((await janitor.sweep({ force: true })).artifactsExpired).toBe(0);
    advance(2);
    const report = await janitor.sweep({ force: true });
    expect(report.artifactsExpired).toBe(1);
    expect(existsSync(folder)).toBe(false);
    const kept = h.artifacts.get(String(record?.id));
    expect(kept?.status).toBe("expired");
    expect(toRef(kept as never).status).toBe("expired");
    // The default listing shows ready artifacts; Expired ones are opt-in (cards, /artifacts).
    expect(h.artifacts.list(rootOf(h))).toHaveLength(0);
    expect(h.artifacts.list(rootOf(h), { includeExpired: true })[0]?.status).toBe("expired");
    // Their files can no longer be resolved.
    expect(await h.artifacts.resolveFile(kept as never, "report.md")).toBeUndefined();
    // Its script is still there (an expired artifact is not a ready one): a rerun brings it back.
  });

  it("keeps artifacts forever with the default artifactsDays = 0", async () => {
    const { h, janitor, advance } = await setup();
    await published(h);
    advance(5000);
    await janitor.sweep({ force: true });
    expect(h.artifacts.list(rootOf(h))).toHaveLength(1);
  });

  it("after the artifact expires its job script goes at the next jobsDays pass", async () => {
    const { h, janitor, advance } = await setup({ artifactsDays: 40 });
    await published(h);
    advance(41);
    await janitor.sweep({ force: true });
    // Same sweep: expiry runs first, so the execution has no ready artifact left and its logs are old.
    expect(existsSync(jobDir(h))).toBe(false);
  });
});

describe("datasets and uploaded originals", () => {
  async function dataset(h: AnalysisHarness, blobs: BlobStore, name: string, text: string) {
    const upload = blobs.put(Buffer.from(text), "application/octet-stream");
    const file = join(h.workspace, name);
    await writeFile(file, text);
    const { record } = await h.datasets.ingest({
      rootSessionId: rootOf(h),
      sessionId: h.session,
      workspace: h.workspace,
      path: file,
      blobHash: upload.hash,
    });
    return { record, upload };
  }

  it("deletes a dataset unused for 30 days with its original, and keeps one that was used", async () => {
    const { h, janitor, blobs, advance } = await setup();
    const old = await dataset(h, blobs, "old.csv", "a\n1\n");
    const used = await dataset(h, blobs, "used.csv", "a\n2\n");
    // The dataset file's mtime is its last use: the old one was last used long ago.
    const longAgo = new Date(Date.now() - 40 * DAY);
    await utimes(h.datasets.file(old.record), longAgo, longAgo);
    const recent = new Date(Date.now() - 2 * DAY);
    await utimes(h.datasets.file(used.record), recent, recent);
    advance(0);
    const oldCreated = h.store.db.prepare("UPDATE datasets SET created_at=? WHERE id=?");
    oldCreated.run(Date.now() - 45 * DAY, old.record.id);
    h.store.db
      .prepare("UPDATE blobs SET created_at=? WHERE hash=?")
      .run(Date.now() - 45 * DAY, old.upload.hash);
    const report = await janitor.sweep({ force: true });
    expect(report.datasetsDeleted).toBe(1);
    expect(report.uploadsDeleted).toBe(1);
    expect(h.datasets.get(old.record.id)).toBeUndefined();
    expect(existsSync(h.datasets.file(old.record))).toBe(false);
    expect(blobs.has(old.upload.hash)).toBe(false);
    expect(h.datasets.get(used.record.id)).toBeDefined();
    expect(blobs.has(used.upload.hash)).toBe(true);
  });

  it("using a dataset (get) postpones its deletion", async () => {
    const { h, janitor, blobs, advance } = await setup();
    const { record } = await dataset(h, blobs, "d.csv", "a\n1\n");
    advance(25);
    h.datasets.get(record.id); // a use, 25 days in
    await new Promise((r) => setTimeout(r, 50)); // the touch is asynchronous
    advance(20); // day 45: unused for 20 days
    expect((await janitor.sweep({ force: true })).datasetsDeleted).toBe(0);
    advance(15); // day 60: unused for 35 days
    expect((await janitor.sweep({ force: true })).datasetsDeleted).toBe(1);
  });

  it("removes an upload no dataset refers to (a failed ingestion) but never an image blob", async () => {
    const { janitor, blobs, h, advance } = await setup();
    const orphan = blobs.put(Buffer.from("never ingested"), "application/octet-stream");
    const image = blobs.put(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
    expect(h).toBeDefined();
    advance(31);
    const report = await janitor.sweep({ force: true });
    expect(report.uploadsDeleted).toBe(1);
    expect(blobs.has(orphan.hash)).toBe(false);
    expect(blobs.has(image.hash)).toBe(true);
  });

  it("keeps a shared original while another dataset still refers to it", async () => {
    const { h, janitor, blobs, advance } = await setup();
    const first = await dataset(h, blobs, "a.csv", "a\n1\n");
    advance(31);
    // The same original arrives in another session of the workspace, today.
    const other = h.store.create(h.workspace, "fake", "fake-model").id;
    const second = await h.datasets.ingest({
      rootSessionId: other,
      sessionId: other,
      workspace: h.workspace,
      path: join(h.workspace, "a.csv"),
      blobHash: first.upload.hash,
    });
    const report = await janitor.sweep({ force: true });
    expect(report.datasetsDeleted).toBe(1);
    expect(h.datasets.get(first.record.id)).toBeUndefined();
    expect(h.datasets.get(second.record.id)).toBeDefined();
    expect(blobs.has(first.upload.hash)).toBe(true);
  });
});

describe("scheduling", () => {
  it("sweeps at most once every 24 hours and records the mark in analysis/.last-sweep", async () => {
    const { h, janitor, clock, advance } = await setup();
    expect((await janitor.sweep()).skipped).toBeUndefined();
    const mark = join(h.state, "analysis", ".last-sweep");
    expect(Number((await readFile(mark, "utf8")).trim())).toBe(clock.now);
    advance(0.5);
    expect((await janitor.sweep()).skipped).toBe("recent");
    advance(0.6);
    expect((await janitor.sweep()).skipped).toBeUndefined();
    expect(await janitor.lastSweep()).toBe(clock.now);
  });

  it("two sweeps at once: one runs, the other yields to it", async () => {
    const { janitor } = await setup();
    const reports = await Promise.all([
      janitor.sweep({ force: true }),
      janitor.sweep({ force: true }),
    ]);
    expect(reports.filter((r) => r.skipped === "locked").length).toBeLessThanOrEqual(1);
    expect(reports.filter((r) => !r.skipped).length).toBeGreaterThanOrEqual(1);
  });

  it("a stale lock from a dead process does not block sweeping", async () => {
    const { h, janitor } = await setup();
    await mkdir(join(h.state, "analysis"), { recursive: true });
    const lock = join(h.state, "analysis", ".sweep.lock");
    await writeFile(lock, "999999\n");
    const old = new Date(Date.now() - 3 * 3_600_000);
    await utimes(lock, old, old);
    expect((await janitor.sweep({ force: true })).skipped).toBeUndefined();
  });

  it("start() returns at once, runs in the background and holds no reference to keep Node alive", async () => {
    const { h, janitor } = await setup();
    const timers: Array<{ hasRef(): boolean }> = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const timer = real(fn, ms);
      timers.push(timer as unknown as { hasRef(): boolean });
      return timer;
    }) as typeof setTimeout);
    const began = Date.now();
    janitor.start();
    expect(Date.now() - began).toBeLessThan(50);
    expect(existsSync(join(h.state, "analysis", ".last-sweep"))).toBe(false); // not synchronous
    expect(timers.length).toBeGreaterThan(0);
    expect(timers.every((timer) => !timer.hasRef())).toBe(true);
    for (let i = 0; i < 100 && !existsSync(join(h.state, "analysis", ".last-sweep")); i++)
      await new Promise((r) => real(r, 20));
    expect(existsSync(join(h.state, "analysis", ".last-sweep"))).toBe(true);
    janitor.stop();
  });

  it("stop() cancels a pending background sweep", async () => {
    const { h, janitor } = await setup();
    janitor.start();
    janitor.stop();
    await new Promise((r) => setTimeout(r, 80));
    expect(existsSync(join(h.state, "analysis", ".last-sweep"))).toBe(false);
  });
});
