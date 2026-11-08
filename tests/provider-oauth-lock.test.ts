import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileLockTimeoutError,
  isStaleLock,
  ProviderSettingsStore,
  withFileLock,
} from "../packages/core/src/index.ts";

const dir = () => mkdtemp(join(tmpdir(), "alisio-oauth-lock-"));
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const CHILD = join(import.meta.dirname, "provider-oauth-child.ts");

function child(job: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        "--conditions=alisio-source",
        "--disable-warning=ExperimentalWarning",
        CHILD,
        JSON.stringify(job),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    proc.stdout.on("data", (chunk) => {
      out += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      err += chunk;
    });
    proc.on("close", () => {
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() ?? ""));
      } catch {
        reject(new Error(`child failed: ${err || out}`));
      }
    });
  });
}
/** A moment all children wait for, so they really race (process start-up takes a while). */
const startAt = () => Date.now() + 800;

async function staleLock(path: string, ageMs: number, owner = "someone-else") {
  await writeFile(path, owner);
  const at = new Date(Date.now() - ageMs);
  await utimes(path, at, at);
}

describe("isStaleLock", () => {
  it("is stale only strictly beyond the threshold", () => {
    expect(isStaleLock(0, 30_001)).toBe(true);
    expect(isStaleLock(0, 30_000)).toBe(false);
    expect(isStaleLock(0, 29_000)).toBe(false);
  });
});

describe("withFileLock (OA-AC-06, OA-AC-48)", () => {
  it("runs the section exclusively and leaves no lock file behind", async () => {
    const root = await dir();
    const path = join(root, "x.lock");
    let inside = 0;
    let overlap = false;
    await Promise.all(
      [1, 2, 3].map(() =>
        withFileLock(path, { waitMs: 5000 }, async () => {
          inside++;
          if (inside > 1) overlap = true;
          await new Promise((resolve) => setTimeout(resolve, 20));
          inside--;
        }),
      ),
    );
    expect(overlap).toBe(false);
    expect(await exists(path)).toBe(false);
  });

  it("takes over a lock older than 30 s, but not one of 29 s", async () => {
    const root = await dir();
    const old = join(root, "old.lock");
    await staleLock(old, 31_000);
    await expect(withFileLock(old, { waitMs: 200 }, async () => "ran")).resolves.toBe("ran");
    expect(await exists(old)).toBe(false);

    const recent = join(root, "recent.lock");
    await staleLock(recent, 29_000);
    await expect(withFileLock(recent, { waitMs: 150 }, async () => "ran")).rejects.toMatchObject({
      code: "CREDENTIAL_LOCK_TIMEOUT",
    });
    expect(await readFile(recent, "utf8")).toBe("someone-else");
  });

  it("times out on a live lock with the requested code and leaves no file of its own", async () => {
    const root = await dir();
    const path = join(root, "live.lock");
    await writeFile(path, "live-owner");
    const started = Date.now();
    const failure = await withFileLock(
      path,
      { waitMs: 250, timeoutCode: "OAUTH_REFRESH_BUSY" },
      async () => 1,
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(FileLockTimeoutError);
    expect(failure.code).toBe("OAUTH_REFRESH_BUSY");
    expect(failure.retryable).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await readFile(path, "utf8")).toBe("live-owner");
    expect(await readdir(root)).toEqual(["live.lock"]);
  });

  it("the credentials lock gives up after 5 s by default (simulated clock)", async () => {
    const root = await dir();
    const store = new ProviderSettingsStore(root);
    await writeFile(store.lockPath, "live-owner");
    let clock = 0;
    const slept: number[] = [];
    store.lockTiming = {
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      random: () => 0,
    };
    // mtime is real, `now` is simulated near zero: the lock never looks stale.
    await expect(store.setCredentials("p", { apiKey: "k" })).rejects.toMatchObject({
      code: "CREDENTIAL_LOCK_TIMEOUT",
    });
    expect(clock).toBeGreaterThanOrEqual(5000);
    expect(clock).toBeLessThan(5100);
    expect(slept.every((ms) => ms === 50)).toBe(true);
    expect(await readFile(store.lockPath, "utf8")).toBe("live-owner");
  });

  it("waits exactly waitMs with the base retry delay plus its jitter, then gives up", async () => {
    const root = await dir();
    const path = join(root, "live.lock");
    await writeFile(path, "live-owner");
    let clock = 0;
    const slept: number[] = [];
    const timing = {
      now: () => clock,
      sleep: async (ms: number) => {
        slept.push(ms);
        clock += ms;
      },
    };
    await expect(
      withFileLock(path, { waitMs: 100, ...timing, random: () => 0 }, async () => 1),
    ).rejects.toMatchObject({ code: "CREDENTIAL_LOCK_TIMEOUT" });
    expect(slept).toEqual([50, 50]);
    expect(clock).toBe(100);
    slept.length = 0;
    clock = 0;
    await expect(
      withFileLock(path, { waitMs: 100, ...timing, random: () => 0.999 }, async () => 1),
    ).rejects.toMatchObject({ code: "CREDENTIAL_LOCK_TIMEOUT" });
    expect(slept[0]).toBe(74); // 50 ms plus up to 25 ms of jitter, never less than the base
  });

  it("does not take over a lock that stopped being the abandoned one before the re-check", async () => {
    const root = await dir();
    const path = join(root, "x.lock");
    await staleLock(path, 31_000);
    let swapped = false;
    const failure = await withFileLock(
      path,
      {
        waitMs: 150,
        takeoverHooks: {
          beforeRecheck: async () => {
            if (swapped) return;
            swapped = true;
            await writeFile(path, "fresh-live-owner"); // somebody took it over meanwhile
          },
        },
      },
      async () => "ran",
    ).catch((error) => error);
    expect(failure.code).toBe("CREDENTIAL_LOCK_TIMEOUT");
    expect(await readFile(path, "utf8")).toBe("fresh-live-owner");
    expect(await readdir(root)).toEqual(["x.lock"]);
  });

  it("puts a live lock back when it was moved by mistake between the re-check and the rename", async () => {
    const root = await dir();
    const path = join(root, "x.lock");
    await staleLock(path, 31_000);
    let swapped = false;
    const failure = await withFileLock(
      path,
      {
        waitMs: 150,
        takeoverHooks: {
          beforeRename: async () => {
            if (swapped) return;
            swapped = true;
            await writeFile(path, "fresh-live-owner");
          },
        },
      },
      async () => "ran",
    ).catch((error) => error);
    expect(failure.code).toBe("CREDENTIAL_LOCK_TIMEOUT");
    expect(await readFile(path, "utf8")).toBe("fresh-live-owner");
    expect(await readdir(root)).toEqual(["x.lock"]);
  });

  it("a stale owner's release does not delete the lock that replaced it (OA-AC-48)", async () => {
    const root = await dir();
    const path = join(root, "x.lock");
    let secondEntered = false;
    let releaseFirst: () => void = () => {};
    const firstHolding = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstInside: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      firstInside = resolve;
    });
    const first = withFileLock(path, { waitMs: 1000 }, async () => {
      firstInside();
      await firstHolding;
    });
    await firstStarted;
    // First is "slow": its lock is now abandoned by age and a second process takes it over.
    const old = new Date(Date.now() - 31_000);
    await utimes(path, old, old);
    let secondHolding: () => void = () => {};
    const secondRelease = new Promise<void>((resolve) => {
      secondHolding = resolve;
    });
    const second = withFileLock(path, { waitMs: 1000 }, async () => {
      secondEntered = true;
      await secondRelease;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secondEntered).toBe(true);
    releaseFirst();
    await first;
    // First released, but the lock on disk is the second's: still there.
    expect(await exists(path)).toBe(true);
    secondHolding();
    await second;
    expect(await exists(path)).toBe(false);
  });
});

describe("across processes (OA-AC-05, OA-AC-08, OA-AC-49)", () => {
  it("loses no write when two processes save credentials and sessions at once (20 iterations each)", async () => {
    const root = await dir();
    const at = startAt();
    const [a, b] = await Promise.all([
      child({ mode: "writes", kind: "cred", root, n: 20, startAt: at }),
      child({ mode: "writes", kind: "oauth", root, n: 20, startAt: at }),
    ]);
    expect(a).toEqual({ done: true });
    expect(b).toEqual({ done: true });
    const file = JSON.parse(await readFile(join(root, "credentials.json"), "utf8"));
    expect(Object.keys(file.providers).sort()).toHaveLength(20);
    expect(Object.keys(file.oauth)).toHaveLength(20);
    expect(file.oauthSeq).toBe(20);
  }, 20_000);

  it("never has two holders when two processes take over the same abandoned lock (20 rounds)", async () => {
    const root = await dir();
    for (let k = 0; k < 20; k++) await staleLock(join(root, `lock-${k}`), 31_000);
    const at = startAt();
    const [a, b] = await Promise.all([
      child({ mode: "lock", dir: root, rounds: 20, startAt: at }),
      child({ mode: "lock", dir: root, rounds: 20, startAt: at }),
    ]);
    expect(a).toEqual({ violations: 0, held: 20 });
    expect(b).toEqual({ violations: 0, held: 20 });
  }, 20_000);

  it("renews once between two processes: the second re-reads under the lock and reuses the result (OA-AC-08)", async () => {
    const root = await dir();
    const store = new ProviderSettingsStore(root);
    await store.setOAuth(
      "p",
      {
        type: "oauth",
        access: "old-access-abcdef",
        refresh: "old-refresh-abcdef",
        expires: Date.now() - 1000,
      },
      { method: "browser", provider: "chatgpt" },
    );
    const at = startAt();
    const [a, b] = await Promise.all([
      child({ mode: "refresh", root, startAt: at }),
      child({ mode: "refresh", root, startAt: at }),
    ]);
    expect(a).toEqual(b);
    expect((a as { access: string }).access).toBe("rotated-access-1-abcdef");
    const calls = (await readFile(join(root, "calls.log"), "utf8")).trim().split("\n");
    expect(calls).toHaveLength(1);
    const stored = await store.getOAuthEntry("p");
    expect(stored?.refresh).toBe("rotated-refresh-1-abcdef");
    expect(stored?.state).toBe("ok");
  }, 20_000);
});
