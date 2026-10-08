import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FileTreePage,
  ProviderEvent,
  SessionChange,
  UiBlock,
  WorkspaceInfo,
} from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  fakeProvider,
  newSession,
  reply,
  settled,
  startTestServer,
  type TestServer,
} from "./server-helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};

async function server() {
  t = await startTestServer();
  const [ws] = (await t.api.get("/api/workspaces")).json<WorkspaceInfo[]>();
  if (!ws) throw new Error("no workspace");
  return { t, wid: ws.id };
}
const q = (path: string) => encodeURIComponent(path);

describe("GET /api/workspaces/:wid/tree (T-11)", () => {
  it("lists directories first, then files, with sizes; hides .git", async () => {
    const { t, wid } = await server();
    await mkdir(join(t.workspace, "src"));
    await mkdir(join(t.workspace, ".git"));
    await writeFile(join(t.workspace, "b.txt"), "bb");
    await writeFile(join(t.workspace, "a.txt"), "a");
    await writeFile(join(t.workspace, "src", "x.ts"), "x");
    const root = (await t.api.get(`/api/workspaces/${wid}/tree`)).json<FileTreePage>();
    expect(root.entries.map((e) => [e.name, e.type])).toEqual([
      ["src", "dir"],
      ["a.txt", "file"],
      ["b.txt", "file"],
    ]);
    expect(root.entries[2]).toMatchObject({ path: "b.txt", size: 2 });
    expect(root.next).toBeUndefined();
    const src = (await t.api.get(`/api/workspaces/${wid}/tree?path=src`)).json<FileTreePage>();
    expect(src.entries).toEqual([expect.objectContaining({ name: "x.ts", path: "src/x.ts" })]);
  });

  it("pages large directories at 1 000 entries", async () => {
    const { t, wid } = await server();
    const dir = join(t.workspace, "many");
    await mkdir(dir);
    await Promise.all(
      Array.from({ length: 1050 }, (_, i) =>
        writeFile(join(dir, `f${String(i).padStart(4, "0")}`), ""),
      ),
    );
    const first = (await t.api.get(`/api/workspaces/${wid}/tree?path=many`)).json<FileTreePage>();
    expect(first.entries).toHaveLength(1000);
    expect(first.next).toBeTruthy();
    const second = (
      await t.api.get(`/api/workspaces/${wid}/tree?path=many&cursor=${q(first.next ?? "")}`)
    ).json<FileTreePage>();
    expect(second.entries).toHaveLength(50);
    expect(second.entries[0]?.name).toBe("f1000");
    expect(second.next).toBeUndefined();
  });

  it.skipIf(!gitAvailable)("respects .gitignore in git repositories", async () => {
    const { t, wid } = await server();
    git(t.workspace, "init", "-q");
    await writeFile(join(t.workspace, ".gitignore"), "dist/\n*.log\n");
    await mkdir(join(t.workspace, "dist"));
    await writeFile(join(t.workspace, "app.log"), "");
    await writeFile(join(t.workspace, "keep.ts"), "");
    const names = (await t.api.get(`/api/workspaces/${wid}/tree`))
      .json<FileTreePage>()
      .entries.map((e) => e.name);
    expect(names).toEqual([".gitignore", "keep.ts"]);
  });

  it("refuses traversal, absolute paths and symlinks that leave the workspace (403)", async () => {
    const { t, wid } = await server();
    const outside = await mkdtemp(join(tmpdir(), "alisio-outside-"));
    await writeFile(join(outside, "secret.txt"), "top secret");
    await symlink(outside, join(t.workspace, "escape"));
    await symlink(join(outside, "secret.txt"), join(t.workspace, "secret-link.txt"));
    for (const path of ["../..", "../../etc/passwd", "/etc", outside, "escape", "escape/"]) {
      const res = await t.api.get(`/api/workspaces/${wid}/tree?path=${q(path)}`);
      expect(res.status, path).toBe(403);
      expect(res.json(), path).toMatchObject({ error: { code: "path_outside_workspace" } });
    }
    for (const path of [
      "../../etc/passwd",
      "/etc/passwd",
      "escape/secret.txt",
      "secret-link.txt",
    ]) {
      const res = await t.api.get(`/api/workspaces/${wid}/file?path=${q(path)}`);
      expect(res.status, path).toBe(403);
      expect(res.text).not.toContain("top secret");
    }
    const listed = (await t.api.get(`/api/workspaces/${wid}/tree`)).json<FileTreePage>();
    expect(listed.entries.find((e) => e.name === "escape")?.type).toBe("symlink");
  });

  it("answers 404 for unknown workspaces and missing paths", async () => {
    const { t, wid } = await server();
    expect((await t.api.get("/api/workspaces/nope/tree")).status).toBe(404);
    expect((await t.api.get(`/api/workspaces/${wid}/tree?path=missing`)).status).toBe(404);
    expect((await t.api.get(`/api/workspaces/${wid}/file?path=missing.txt`)).status).toBe(404);
  });
});

describe("GET /api/workspaces/:wid/file (T-11)", () => {
  it("serves text with its size and truncation headers", async () => {
    const { t, wid } = await server();
    await writeFile(join(t.workspace, "a.md"), "# Title\n");
    const res = await t.api.get(`/api/workspaces/${wid}/file?path=a.md`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.headers["x-truncated"]).toBe("false");
    expect(res.headers["x-file-size"]).toBe("8");
    expect(res.text).toBe("# Title\n");
    // Non-PDF files keep the app's global framing denial.
    expect(res.headers["x-frame-options"]).toBe("DENY");
    const cut = await t.api.get(`/api/workspaces/${wid}/file?path=a.md&maxBytes=3`);
    expect(cut.text).toBe("# T");
    expect(cut.headers["x-truncated"]).toBe("true");
  });

  it("truncates files over 2 MB and offers the whole file as a download", async () => {
    const { t, wid } = await server();
    await writeFile(join(t.workspace, "big.txt"), "x".repeat(3 * 1024 * 1024));
    const res = await t.api.get(`/api/workspaces/${wid}/file?path=big.txt&maxBytes=99999999`);
    expect(res.headers["x-truncated"]).toBe("true");
    expect(res.text.length).toBe(2 * 1024 * 1024);
    const full = await t.api.get(`/api/workspaces/${wid}/file?path=big.txt&download=1`);
    expect(full.text.length).toBe(3 * 1024 * 1024);
    expect(full.headers["content-disposition"]).toBe('attachment; filename="big.txt"');
    expect(full.headers["content-type"]).toBe("application/octet-stream");
  });

  it("sniffs images by their bytes and never serves binaries or SVG as active content", async () => {
    const { t, wid } = await server();
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    await writeFile(join(t.workspace, "pic.png"), png);
    await writeFile(join(t.workspace, "fake.png"), "not a png");
    await writeFile(join(t.workspace, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(t.workspace, "icon.svg"), "<svg><script>alert(1)</script></svg>");
    const image = await t.api.get(`/api/workspaces/${wid}/file?path=pic.png`);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(
      (await t.api.get(`/api/workspaces/${wid}/file?path=fake.png`)).headers["content-type"],
    ).toBe("text/plain; charset=utf-8");
    const binary = await t.api.get(`/api/workspaces/${wid}/file?path=blob.bin`);
    expect(binary.headers["content-type"]).toBe("application/octet-stream");
    expect(binary.headers["content-disposition"]).toMatch(/^attachment/);
    expect(
      (await t.api.get(`/api/workspaces/${wid}/file?path=icon.svg`)).headers["content-type"],
    ).toBe("text/plain; charset=utf-8");
  });

  it("rejects directories as files (400)", async () => {
    const { t, wid } = await server();
    await mkdir(join(t.workspace, "dir"));
    expect((await t.api.get(`/api/workspaces/${wid}/file?path=dir`)).status).toBe(400);
  });

  it("serves a PDF whole and inline so the browser's viewer can render it", async () => {
    const { t, wid } = await server();
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.from("x".repeat(3 * 1024 * 1024)), // over the 2 MB preview limit
    ]);
    await writeFile(join(t.workspace, "doc.pdf"), pdf);
    const res = await t.api.get(`/api/workspaces/${wid}/file?path=doc.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toMatch(/^inline/);
    expect(res.headers["x-truncated"]).toBe("false");
    expect(res.text.length).toBe(pdf.length);
    // The web previews the PDF in an <iframe>: it must be framable by this origin only.
    expect(res.headers["x-frame-options"]).toBeUndefined();
    expect(String(res.headers["content-security-policy"])).toContain("frame-ancestors 'self'");
    // Download still forces the attachment.
    const download = await t.api.get(`/api/workspaces/${wid}/file?path=doc.pdf&download=1`);
    expect(download.headers["content-disposition"]).toMatch(/^attachment/);
  });
});

/** Each run writes `path`, then answers "done". */
function writer(path: string, content: string) {
  return fakeProvider(async function* (request): AsyncGenerator<ProviderEvent> {
    if (request.messages.at(-1)?.role === "tool") {
      yield* reply("done");
      return;
    }
    yield {
      type: "completed",
      message: {
        role: "assistant",
        text: "",
        calls: [
          {
            id: "w1",
            name: "write_file",
            arguments: JSON.stringify({ path, content, expectedHash: null }),
          },
        ],
      },
    };
  });
}

describe("session changes and git diffs", () => {
  it.skipIf(!gitAvailable)("lists files written by the session with their git status", async () => {
    t = await startTestServer({
      provider: writer("src/new.ts", "export {};\n"),
      app: { allowWrite: true },
    });
    git(t.workspace, "init", "-q");
    const session = await newSession(t, { preset: "workspace-write" });
    const run = (
      await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "write" })
    ).json<{ runId: string }>();
    await settled(t, session.id, run.runId);
    const { files } = (await t.api.get(`/api/sessions/${session.id}/changes`)).json<{
      files: SessionChange[];
    }>();
    expect(files).toEqual([
      { path: "src/new.ts", lastRunId: run.runId, effect: "write", gitStatus: "??" },
    ]);
    expect((await t.api.get("/api/sessions/nope/changes")).status).toBe(404);
  });

  it.skipIf(!gitAvailable)(
    "returns a diff block against HEAD, and for untracked files",
    async () => {
      const { t, wid } = await server();
      git(t.workspace, "init", "-q");
      git(
        t.workspace,
        "-c",
        "user.email=a@b",
        "-c",
        "user.name=a",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "i",
      );
      await writeFile(join(t.workspace, "a.txt"), "one\n");
      git(t.workspace, "add", "a.txt");
      git(t.workspace, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "a");
      await writeFile(join(t.workspace, "a.txt"), "two\n");
      await writeFile(join(t.workspace, "new.md"), "hi\n");
      const tracked = (await t.api.get(`/api/workspaces/${wid}/diff?path=a.txt`)).json<UiBlock>();
      expect(tracked).toMatchObject({ kind: "diff", path: "a.txt" });
      expect(tracked.kind === "diff" && tracked.patch).toContain("-one\n+two");
      const untracked = (
        await t.api.get(`/api/workspaces/${wid}/diff?path=new.md`)
      ).json<UiBlock>();
      expect(untracked.kind === "diff" && untracked.patch).toContain("--- /dev/null");
      expect((await t.api.get(`/api/workspaces/${wid}/diff?path=${q("../x")}`)).status).toBe(403);
    },
  );

  it("answers 409 not_a_git_repo outside git repositories", async () => {
    const { t, wid } = await server();
    await writeFile(join(t.workspace, "a.txt"), "x");
    const res = await t.api.get(`/api/workspaces/${wid}/diff?path=a.txt`);
    expect(res.status).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "not_a_git_repo" } });
  });
});
