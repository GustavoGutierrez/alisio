import { execFile as realExecFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Header, type HeaderInfo } from "../packages/cli/src/tui/components.ts";
import {
  BRANCH_MAX_LENGTH,
  BRANCH_TIMEOUT_MS,
  branchDisplay,
  createBranchCache,
  readGitBranch,
  sanitizeBranchName,
} from "../packages/cli/src/tui/git-branch.ts";
import { initialViewState } from "../packages/cli/src/tui/state.ts";

/** Hermetic git runner for fixture setup: no ambient config, no ambient repo overrides. */
const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
delete gitEnv.GIT_DIR;
delete gitEnv.GIT_WORK_TREE;
delete gitEnv.GIT_INDEX_FILE;

const git = (cwd: string, ...args: string[]) =>
  new Promise<string>((resolve, reject) => {
    realExecFile("git", args, { cwd, env: gitEnv }, (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim()),
    );
  });

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "alisio-git-branch-"));
  dirs.push(dir);
  return dir;
};
/** Empty dir that is NOT a git repository. */
const makeNonRepo = () => tempDir();
/** Fresh repository with one commit on `main` (hermetic identity via -c, never writes config). */
const makeRepo = async () => {
  const dir = tempDir();
  await git(dir, "-c", "init.defaultBranch=main", "init", "-b", "main");
  await git(
    dir,
    "-c",
    "user.name=Alisio Test",
    "-c",
    "user.email=test@alisio.dev",
    "commit",
    "--allow-empty",
    "-m",
    "init",
  );
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readGitBranch (real git)", () => {
  it("returns the branch of a repository", async () => {
    const repo = await makeRepo();
    expect(await readGitBranch(repo)).toBe("main");
  });

  it("returns the short SHA on a detached HEAD", async () => {
    const repo = await makeRepo();
    await git(repo, "checkout", "--detach");
    const expected = await git(repo, "rev-parse", "--short", "HEAD");
    const branch = await readGitBranch(repo);
    expect(branch).toMatch(/^[0-9a-f]+$/);
    expect(branch).toBe(expected);
  });

  it("returns undefined outside a git repository", async () => {
    expect(await readGitBranch(makeNonRepo())).toBeUndefined();
  });

  it("returns undefined when the workspace does not exist", async () => {
    expect(await readGitBranch(join(tmpdir(), "alisio-missing-workspace-xyz"))).toBeUndefined();
  });
});

describe("sanitizeBranchName", () => {
  it("strips control characters, ANSI escapes and surrounding whitespace", () => {
    expect(sanitizeBranchName("  feat/\u0007bad\u001b[31mred  ")).toBe("feat/badred");
    expect(sanitizeBranchName("a\u001bb")).toBe("ab");
    expect(sanitizeBranchName("main")).toBe("main");
  });

  it("truncates hostile or long names at 24 chars with an ellipsis", () => {
    const long = "x".repeat(50);
    const cut = sanitizeBranchName(long);
    expect(cut).toBe(`${"x".repeat(BRANCH_MAX_LENGTH - 1)}…`);
    expect(cut.length).toBe(BRANCH_MAX_LENGTH);
    expect(sanitizeBranchName("a".repeat(BRANCH_MAX_LENGTH))).toBe("a".repeat(BRANCH_MAX_LENGTH));
  });
});

describe("branchDisplay", () => {
  it("uses the ⎇ glyph on unicode terminals and an explicit label otherwise", () => {
    expect(branchDisplay("main", true)).toBe("⎇ main");
    expect(branchDisplay("main", false)).toBe("branch main");
    expect(branchDisplay("a1b2c3d", true)).toBe("⎇ a1b2c3d");
  });
});

describe("createBranchCache", () => {
  const fakeSpawn = (result: string | Error, watch?: (opts: { timeout: number }) => void) =>
    ((
      _cmd: string,
      _args: string[],
      opts: { timeout: number },
      cb: (e: Error | null, out: string) => void,
    ) => {
      watch?.(opts);
      queueMicrotask(() => (result instanceof Error ? cb(result, "") : cb(null, result)));
    }) as unknown as typeof realExecFile;

  it("caches per workspace until the TTL expires, then re-reads", async () => {
    const w = tempDir(),
      other = tempDir();
    let calls = 0;
    const cache = createBranchCache({
      ttlMs: 1_000,
      now: () => now,
      spawn: fakeSpawn("feat-x\n", () => void calls++),
    });
    let now = 0;
    expect(await cache.read(w)).toBe("feat-x");
    expect(calls).toBe(1);
    // Fresh hit: no new spawn.
    expect(await cache.read(w)).toBe("feat-x");
    expect(calls).toBe(1);
    // Expired entry re-reads and caches the new value.
    now = 1_001;
    expect(await cache.read(w)).toBe("feat-x");
    expect(calls).toBe(2);
    // A different workspace is its own entry.
    expect(await cache.read(other)).toBe("feat-x");
    expect(calls).toBe(3);
  });

  it("dedupes concurrent reads of the same workspace", async () => {
    const w = tempDir();
    let calls = 0;
    const cache = createBranchCache({
      spawn: fakeSpawn("main\n", () => void calls++),
    });
    const [a, b] = await Promise.all([cache.read(w), cache.read(w)]);
    expect([a, b]).toEqual(["main", "main"]);
    expect(calls).toBe(1);
  });

  it("caches failures as undefined instead of spawning repeatedly", async () => {
    const w = tempDir();
    let calls = 0;
    const cache = createBranchCache({
      spawn: fakeSpawn(new Error("not a repository"), () => void calls++),
    });
    expect(await cache.read(w)).toBeUndefined();
    expect(await cache.read(w)).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("passes a bounded timeout to git so a hung process can never stall the TUI", async () => {
    const w = tempDir();
    const seen: number[] = [];
    const cache = createBranchCache({ spawn: fakeSpawn("ok\n", (o) => seen.push(o.timeout)) });
    await cache.read(w);
    expect(seen).toEqual([BRANCH_TIMEOUT_MS]);
  });
});

const baseInfo = (over: Partial<HeaderInfo> = {}): HeaderInfo => ({
  version: "0.1.0",
  host: "api.example.com",
  apiMode: "chat",
  cwd: "~/proj",
  session: "abc12345",
  branch: "main",
  write: "on",
  process: "on",
  mcp: true,
  readOnly: false,
  ...over,
});

/** Forces the unicode locale so renders are deterministic regardless of the host environment. */
const withUnicodeLocale = <T>(fn: () => T): T => {
  const saved = {
    LC_ALL: process.env.LC_ALL,
    LC_CTYPE: process.env.LC_CTYPE,
    LANG: process.env.LANG,
  };
  try {
    delete process.env.LC_ALL;
    delete process.env.LC_CTYPE;
    process.env.LANG = "en_US.UTF-8";
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

describe("Header branch segment", () => {
  const line2 = (info: HeaderInfo, width: number) =>
    new Header(
      () => info,
      () => initialViewState("m1"),
    ).render(width)[1] ?? "";

  it("renders the branch after the session when provided", () => {
    withUnicodeLocale(() => {
      const rendered = line2(baseInfo(), 90);
      expect(rendered).toContain("session abc12345");
      expect(rendered).toContain("⎇ main");
    });
  });

  it("omits the branch segment when it is undefined", () => {
    withUnicodeLocale(() => {
      const rendered = line2(baseInfo({ branch: undefined }), 90);
      expect(rendered).not.toContain("⎇");
      expect(rendered).not.toContain("branch main");
      expect(rendered).toContain("session abc12345");
    });
  });

  it("drops the branch before the session on narrow terminals", () => {
    withUnicodeLocale(() => {
      const rendered = line2(baseInfo(), 60);
      expect(rendered).toContain("session abc12345");
      expect(rendered).not.toContain("⎇");
    });
  });

  it("keeps permissions when the line is very narrow and the branch is long", () => {
    withUnicodeLocale(() => {
      const rendered = line2(baseInfo({ branch: "x".repeat(30) }), 54);
      expect(rendered).not.toContain("⎇");
      expect(rendered).not.toContain("session ");
      expect(rendered).toContain("write:on");
      expect(rendered).toContain("process:on");
    });
  });

  it("falls back to an ASCII label on a C-locale terminal", () => {
    const saved = {
      LC_ALL: process.env.LC_ALL,
      LC_CTYPE: process.env.LC_CTYPE,
      LANG: process.env.LANG,
    };
    try {
      delete process.env.LC_ALL;
      delete process.env.LC_CTYPE;
      process.env.LANG = "C";
      expect(line2(baseInfo(), 90)).toContain("branch main");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("Header identity", () => {
  const line1 = (info: HeaderInfo, width = 90) =>
    new Header(
      () => info,
      () => initialViewState("m1"),
    ).render(width)[0] ?? "";

  it("renders the product name and the real running version", () => {
    withUnicodeLocale(() => {
      const rendered = line1(baseInfo({ version: "0.1.0-alpha.12" }));
      expect(rendered).toContain("◆ Alisio Code");
      expect(rendered).toContain("v0.1.0-alpha.12");
      expect(rendered).not.toContain("vdev");
    });
  });

  it("falls back to the dev marker when the version input says so", () => {
    withUnicodeLocale(() => {
      const rendered = line1(baseInfo({ version: "dev" }));
      expect(rendered).toContain("◆ Alisio Code");
      expect(rendered).toContain("vdev");
    });
  });
});
