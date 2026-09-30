import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalDirectoryRequest, ModelProvider } from "../packages/core/src/index.ts";
import { createApplication, PathAccess, safePath } from "../packages/core/src/index.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A workspace and a sibling external directory, with the config/state homes isolated to temp. */
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "alisio-external-"));
  const workspace = join(base, "workspace");
  const external = join(base, "external");
  await mkdir(workspace, { recursive: true });
  await mkdir(external, { recursive: true });
  vi.stubEnv("ALISIO_CONFIG_HOME", join(base, "config"));
  vi.stubEnv("ALISIO_STATE_HOME", join(base, "state"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  return {
    base,
    workspace: await realpath(workspace),
    external: await realpath(external),
  };
}

/** A provider that calls the given tools once, then finishes. */
function toolCallingProvider(
  calls: Array<{ name: string; input: Record<string, unknown> }>,
): ModelProvider {
  let index = 0;
  return {
    id: "fake",
    model: "fake",
    async *stream() {
      const next = calls[index++];
      if (next)
        yield {
          type: "completed",
          message: {
            role: "assistant",
            text: "",
            calls: [{ id: `c${index}`, name: next.name, arguments: JSON.stringify(next.input) }],
          },
        };
      else yield { type: "completed", message: { role: "assistant", text: "done", calls: [] } };
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to reject");
}

function toolText(app: Awaited<ReturnType<typeof createApplication>>, sessionId: string): string {
  return app.store
    .messages(sessionId)
    .filter((message) => message.role === "tool")
    .map((message) =>
      message.result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    )
    .join("\n");
}

describe("PathAccess", () => {
  it("resolves paths inside the workspace and declared extra roots without asking", async () => {
    const { workspace, external } = await fixture();
    const asked: string[] = [];
    const access = new PathAccess({
      workspace,
      extraRoots: [external],
      approve: async (request) => {
        asked.push(request.directory);
        return "deny";
      },
    });
    expect(await access.resolve("inside.txt")).toBe(join(workspace, "inside.txt"));
    expect(await access.resolve(join(external, "outside.txt"))).toBe(join(external, "outside.txt"));
    expect(asked).toEqual([]);
  });

  it("asks for the containing directory and lets an allow-session cover its subtree", async () => {
    const { workspace, external } = await fixture();
    const nested = join(external, "sub");
    await mkdir(nested, { recursive: true });
    const asked: ExternalDirectoryRequest[] = [];
    const access = new PathAccess({
      workspace,
      approve: async (request) => {
        asked.push(request);
        return "session";
      },
    });
    await access.resolve(join(external, "a.txt"));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.directory).toBe(external);
    expect(asked[0]?.path).toBe(join(external, "a.txt"));
    // A sibling and a nested file are covered by the approved directory boundary.
    await access.resolve(join(external, "b.txt"));
    await access.resolve(join(nested, "c.txt"));
    expect(asked).toHaveLength(1);
    expect(access.approvedDirectories()).toEqual([external]);
  });

  it("keeps allow-once scoped to the requested file", async () => {
    const { workspace, external } = await fixture();
    const asked: string[] = [];
    const access = new PathAccess({
      workspace,
      approve: async (request) => {
        asked.push(request.path);
        return "once";
      },
    });
    expect(await access.resolve(join(external, "a.txt"))).toBe(join(external, "a.txt"));
    // A different file in the same directory asks again: "once" is not a directory grant.
    await access.resolve(join(external, "b.txt"));
    expect(asked).toEqual([join(external, "a.txt"), join(external, "b.txt")]);
    expect(access.approvedDirectories()).toEqual([]);
  });

  it("denies a refused directory with the resolved path and both remedies", async () => {
    const { workspace, external } = await fixture();
    const access = new PathAccess({ workspace, approve: async () => "deny" });
    const target = join(external, "a.txt");
    const error = await rejection(access.resolve(target));
    expect(error.message).toContain(target);
    expect(error.message).toContain("--add-dir");
    expect(error.message).toContain("additionalDirectories");
  });

  it("denies without a handler (non-interactive) naming the path and both remedies", async () => {
    const { workspace, external } = await fixture();
    const access = new PathAccess({ workspace });
    const target = join(external, "a.txt");
    const error = await rejection(access.resolve(target));
    expect(error.message).toContain(target);
    expect(error.message).toContain("--add-dir");
    expect(error.message).toContain("additionalDirectories");
  });

  it("never prompts when interactive is false, even with a handler bound", async () => {
    const { workspace, external } = await fixture();
    let asked = false;
    const access = new PathAccess({
      workspace,
      approve: async () => {
        asked = true;
        return "session";
      },
    });
    await expect(access.resolve(join(external, "a.txt"), { interactive: false })).rejects.toThrow(
      /cannot request a new interactive approval/,
    );
    expect(asked).toBe(false);
  });

  it("stays fully locked under --read-only: no extra roots, no prompt, actionable error", async () => {
    const { workspace, external } = await fixture();
    let asked = false;
    const access = new PathAccess({
      workspace,
      extraRoots: [external],
      readOnly: true,
      approve: async () => {
        asked = true;
        return "session";
      },
    });
    expect(access.extraRoots).toEqual([]);
    const target = join(external, "a.txt");
    const error = await rejection(access.resolve(target));
    expect(error.message).toContain(target);
    expect(error.message).toContain("--read-only");
    expect(asked).toBe(false);
  });

  it("preserves the symlink hardening and names the path in the workspace error", async () => {
    const { workspace, external } = await fixture();
    await symlink(external, join(workspace, "link"));
    const access = new PathAccess({ workspace });
    await expect(access.resolve("link/a.txt")).rejects.toThrow(/Symlinks are not allowed/);
    const target = join(external, "a.txt");
    await expect(safePath(workspace, target)).rejects.toThrow(target);
  });
});

describe("external directories in a running session", () => {
  it("reads an approved external file (allow once) without hanging", async () => {
    const { base, workspace, external } = await fixture();
    const file = join(external, "note.txt");
    await writeFile(file, "outside content");
    const requests: ExternalDirectoryRequest[] = [];
    const app = await createApplication({
      cwd: workspace,
      db: join(base, "sessions.sqlite"),
      noHerdr: true,
      provider: toolCallingProvider([{ name: "read_file", input: { path: file } }]),
      approveExternalDirectory: async (request) => {
        requests.push(request);
        return "once";
      },
    });
    try {
      const session = app.store.create(app.workspace, app.provider.id, "fake");
      await app.runner.run(session.id, "read it");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.directory).toBe(external);
      expect(toolText(app, session.id)).toContain("outside content");
    } finally {
      await app.close();
    }
  });

  it("reads an external file declared with --add-dir without asking", async () => {
    const { base, workspace, external } = await fixture();
    const file = join(external, "note.txt");
    await writeFile(file, "flag content");
    const app = await createApplication({
      cwd: workspace,
      db: join(base, "sessions.sqlite"),
      noHerdr: true,
      addDirs: [external],
      provider: toolCallingProvider([{ name: "read_file", input: { path: file } }]),
    });
    try {
      const session = app.store.create(app.workspace, app.provider.id, "fake");
      await app.runner.run(session.id, "read it");
      expect(toolText(app, session.id)).toContain("flag content");
    } finally {
      await app.close();
    }
  });

  it("reads an external file declared by the additionalDirectories config key", async () => {
    const { base, workspace, external } = await fixture();
    const file = join(external, "note.txt");
    await writeFile(file, "config content");
    const config = join(base, "explicit.json");
    await writeFile(
      config,
      JSON.stringify({ additionalDirectories: [external], provider: { model: "fake" } }),
    );
    const app = await createApplication({
      cwd: workspace,
      config,
      db: join(base, "sessions.sqlite"),
      noHerdr: true,
      provider: toolCallingProvider([{ name: "read_file", input: { path: file } }]),
    });
    try {
      const session = app.store.create(app.workspace, app.provider.id, "fake");
      await app.runner.run(session.id, "read it");
      expect(toolText(app, session.id)).toContain("config content");
    } finally {
      await app.close();
    }
  });

  it("denies an external read in a non-interactive run with the path and both remedies", async () => {
    const { base, workspace, external } = await fixture();
    const file = join(external, "note.txt");
    await writeFile(file, "secret content");
    const app = await createApplication({
      cwd: workspace,
      db: join(base, "sessions.sqlite"),
      noHerdr: true,
      provider: toolCallingProvider([{ name: "read_file", input: { path: file } }]),
    });
    try {
      const session = app.store.create(app.workspace, app.provider.id, "fake");
      // Never hangs and never throws the whole run: the tool call fails with the remedy.
      await app.runner.run(session.id, "read it");
      const text = toolText(app, session.id);
      expect(text).toContain(file);
      expect(text).toContain("--add-dir");
      expect(text).toContain("additionalDirectories");
      expect(text).not.toContain("secret content");
    } finally {
      await app.close();
    }
  });

  it("keeps --read-only locked even with --add-dir: no extra roots, no external read", async () => {
    const { base, workspace, external } = await fixture();
    const file = join(external, "note.txt");
    await writeFile(file, "locked content");
    const app = await createApplication({
      cwd: workspace,
      db: join(base, "sessions.sqlite"),
      noHerdr: true,
      readOnly: true,
      addDirs: [external],
      provider: toolCallingProvider([{ name: "read_file", input: { path: file } }]),
    });
    try {
      expect(app.pathAccess.extraRoots).toEqual([]);
      const session = app.store.create(app.workspace, app.provider.id, "fake");
      await app.runner.run(session.id, "read it");
      const text = toolText(app, session.id);
      expect(text).toContain("--read-only");
      expect(text).not.toContain("locked content");
    } finally {
      await app.close();
    }
  });

  it("asks exactly once for a relative external write approved once", async () => {
    const { base, workspace, external } = await fixture();
    const relative = `../${basename(external)}/written.txt`;
    let asked = 0;
    const app = await createApplication({
      cwd: workspace,
      db: join(base, "sessions.sqlite"),
      noHerdr: true,
      allowWrite: true,
      provider: toolCallingProvider([
        { name: "write_file", input: { path: relative, content: "hello", expectedHash: null } },
      ]),
      approveExternalDirectory: async () => {
        asked++;
        return "once";
      },
    });
    try {
      const session = app.store.create(app.workspace, app.provider.id, "fake");
      await app.runner.run(session.id, "write it");
      expect(asked).toBe(1);
      expect(await readFile(join(external, "written.txt"), "utf8")).toBe("hello");
    } finally {
      await app.close();
    }
  });

  it("treats an approved external directory as a prerequisite, not a write permission", async () => {
    const { base, workspace, external } = await fixture();
    const target = join(external, "new.txt");
    let externalAsked = false;
    const app = await createApplication({
      cwd: workspace,
      db: join(base, "sessions.sqlite"),
      noHerdr: true,
      provider: toolCallingProvider([
        { name: "write_file", input: { path: target, content: "x", expectedHash: null } },
      ]),
      approveExternalDirectory: async () => {
        externalAsked = true;
        return "session";
      },
    });
    try {
      const session = app.store.create(app.workspace, app.provider.id, "fake");
      await app.runner.run(session.id, "write it");
      // The external-directory check ran first, then the write policy still denied the write.
      expect(externalAsked).toBe(true);
      expect(toolText(app, session.id)).toContain("Capability denied: write");
      await expect(readFile(target, "utf8")).rejects.toThrow();
    } finally {
      await app.close();
    }
  });
});
