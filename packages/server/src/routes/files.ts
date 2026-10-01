/**
 * Workspace files for the web dock (RF-12, spec §8.2/§9.4): lazy tree, bounded file reads,
 * git diffs and the files a session changed. Every path is confined to the workspace with the
 * core's `safePath` rules (resolve against the canonical root, no symlink segment) and then
 * re-checked on its `realpath`, so neither `..` nor a symlink ever leaves the workspace (403).
 */
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import {
  clipLines,
  exportedPaths,
  inside,
  type SQLiteStore,
  safePath,
  unifiedPatch,
} from "@alisio/core";
import type { FileEntry, FileTreePage, SessionChange, UiBlock } from "@alisio/sdk";
import { gitIgnored, gitRoot, gitStatus, runGit } from "../host/git.ts";
import type { SessionService } from "../host/sessions.ts";
import type { WorkspaceHost } from "../host/workspace-host.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { sniffImage } from "./images.ts";

/** Entries per tree page (RF-12). */
export const TREE_PAGE = 1000;
/** Default and maximum bytes of a previewed file (RF-12: larger files are truncated). */
export const FILE_PREVIEW_BYTES = 2 * 1024 * 1024;
const DIFF_LIMIT = 200 * 1024;

const toPosix = (path: string) => path.split(sep).join("/");
const errno = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

/**
 * Resolves a workspace-relative (or absolute) path inside `root`. `mustExist` also requires the
 * target to exist (404 otherwise); either way its realpath must stay inside the root (403).
 */
export async function confine(
  root: string,
  path: string,
  mustExist = true,
): Promise<{ abs: string; rel: string }> {
  let canonical: string;
  let target: string;
  try {
    canonical = await realpath(root);
    target = await safePath(canonical, path || ".");
  } catch (error) {
    if (errno(error) === "ENOENT")
      throw new HttpError("workspace_missing", `Workspace folder not found: ${root}`, {
        path: root,
      });
    throw new HttpError("path_outside_workspace", "The path is outside the workspace");
  }
  let real = target;
  try {
    real = await realpath(target);
  } catch (error) {
    if (mustExist || errno(error) !== "ENOENT") throw new HttpError("not_found", "File not found");
  }
  if (!inside(canonical, real))
    throw new HttpError("path_outside_workspace", "The path is outside the workspace");
  return { abs: real, rel: toPosix(relative(canonical, real)) };
}

const kindOf = (entry: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): FileEntry["type"] =>
  entry.isSymbolicLink()
    ? "symlink"
    : entry.isDirectory()
      ? "dir"
      : entry.isFile()
        ? "file"
        : "other";

async function readHeadBytes(path: string, max: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(max);
    const { bytesRead } = await handle.read(buffer, 0, max, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const looksBinary = (bytes: Buffer) => bytes.subarray(0, 8192).includes(0);

export function registerFileRoutes(
  router: Router,
  ctx: { workspaces: WorkspaceHost; catalog: SQLiteStore; sessions: SessionService },
): void {
  const { workspaces, catalog, sessions } = ctx;
  const rootOf = async (wid: string | undefined) => {
    const path = await workspaces.pathOf(wid ?? "");
    if (!path) throw new HttpError("not_found", "Workspace not found");
    return path;
  };

  router.get("/api/workspaces/:wid/tree", async ({ params, url }) => {
    const root = await rootOf(params.wid);
    const { abs, rel } = await confine(root, url.searchParams.get("path") ?? "");
    if (!(await stat(abs)).isDirectory())
      throw new HttpError("validation_failed", "path is not a directory", { fields: ["path"] });
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("cursor") ?? "0", 10) || 0);
    const dirents = (await readdir(abs, { withFileTypes: true })).filter((d) => d.name !== ".git");
    const prefix = rel ? `${rel}/` : "";
    const all = dirents
      .map((d) => ({ name: d.name, path: `${prefix}${d.name}`, type: kindOf(d) }))
      .sort((a, b) =>
        (a.type === "dir") !== (b.type === "dir")
          ? a.type === "dir"
            ? -1
            : 1
          : a.name < b.name
            ? -1
            : a.name > b.name
              ? 1
              : 0,
      );
    const page = all.slice(offset, offset + TREE_PAGE);
    // `.gitignore` applies when git is available; ignored entries of this page are hidden.
    const ignored = await gitIgnored(
      abs,
      page.map((e) => (e.type === "dir" ? `${e.name}/` : e.name)),
    );
    const entries: FileEntry[] = [];
    for (const entry of page) {
      if (ignored.has(entry.name) || ignored.has(`${entry.name}/`)) continue;
      const info: FileEntry = { ...entry };
      if (entry.type === "file")
        try {
          const s = await lstat(resolve(abs, entry.name));
          info.size = s.size;
          info.mtime = Math.round(s.mtimeMs);
        } catch {
          /* vanished meanwhile */
        }
      entries.push(info);
    }
    const next = offset + TREE_PAGE < all.length ? String(offset + TREE_PAGE) : undefined;
    return { body: { entries, ...(next ? { next } : {}) } satisfies FileTreePage };
  });

  router.get("/api/workspaces/:wid/file", async ({ params, url, res }) => {
    const root = await rootOf(params.wid);
    const { abs } = await confine(root, url.searchParams.get("path") ?? "");
    const info = await stat(abs);
    if (!info.isFile())
      throw new HttpError("validation_failed", "path is not a file", { fields: ["path"] });
    const name = basename(abs).replace(/["\\\r\n]/g, "_");
    if (url.searchParams.get("download") === "1") {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": info.size,
        "Content-Disposition": `attachment; filename="${name}"`,
      });
      const handle = await open(abs, "r");
      try {
        for await (const chunk of handle.createReadStream()) res.write(chunk);
      } finally {
        await handle.close().catch(() => {});
      }
      res.end();
      return undefined;
    }
    const requested = Number.parseInt(url.searchParams.get("maxBytes") ?? "", 10);
    const max =
      Number.isFinite(requested) && requested > 0
        ? Math.min(requested, FILE_PREVIEW_BYTES)
        : FILE_PREVIEW_BYTES;
    const bytes = await readHeadBytes(abs, Math.min(max, info.size));
    const image = sniffImage(bytes);
    const type = image
      ? image.mimeType
      : looksBinary(bytes)
        ? "application/octet-stream"
        : "text/plain; charset=utf-8";
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": bytes.length,
      "Content-Disposition": `${type === "application/octet-stream" ? "attachment" : "inline"}; filename="${name}"`,
      "X-Truncated": String(bytes.length < info.size),
      "X-File-Size": String(info.size),
    });
    res.end(bytes);
    return undefined;
  });

  router.get("/api/workspaces/:wid/diff", async ({ params, url }) => {
    const root = await rootOf(params.wid);
    const { abs, rel } = await confine(root, url.searchParams.get("path") ?? "", false);
    const top = await gitRoot(root);
    if (!top) throw new HttpError("not_a_git_repo", "The workspace is not a git repository");
    const canonical = await realpath(root);
    let patch = "";
    const tracked = await runGit(canonical, ["ls-files", "--error-unmatch", "--", rel], {
      literal: true,
    });
    if (tracked.code === 0) {
      const diff = await runGit(
        canonical,
        ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--", rel],
        { literal: true },
      );
      patch = diff.code === 0 ? diff.stdout : "";
    } else {
      // Untracked (or a repository without commits): the whole file is new.
      try {
        const bytes = await readHeadBytes(abs, 1024 * 1024);
        patch = looksBinary(bytes) ? "" : unifiedPatch(rel, undefined, bytes.toString("utf8"));
      } catch {
        throw new HttpError("not_found", "File not found");
      }
    }
    const { text, clipped } = clipLines(patch, DIFF_LIMIT);
    const lang = extname(rel).slice(1).toLowerCase();
    return {
      body: {
        kind: "diff",
        path: rel,
        patch: text,
        ...(lang ? { lang } : {}),
        ...(clipped ? { caption: `${rel} (diff truncated to 200 KB)` } : {}),
      } satisfies UiBlock,
    };
  });

  router.get("/api/sessions/:sid/changes", async ({ params }) => {
    const session = sessions.get(params.sid ?? "");
    const workspace = await realpath(session.workspace).catch(() => session.workspace);
    // The session and its children (subagents write too), depth-first.
    const ids: string[] = [];
    const walk = (id: string) => {
      ids.push(id);
      for (const child of catalog.children(id)) walk(child.id);
    };
    walk(session.id);
    const latest = new Map<string, { runId?: string; at: number }>();
    for (const id of ids) {
      const calls = catalog.effectCalls(id, "write");
      if (!calls.length) continue;
      const wanted = new Map(calls.map((c) => [c.callId, c]));
      let after = -1;
      for (;;) {
        const page = catalog.messagesPage(id, { after, limit: 500, compacted: true });
        for (const { message } of page.items) {
          if (message.role !== "assistant") continue;
          for (const call of message.calls) {
            const meta = wanted.get(call.id);
            if (!meta) continue;
            const paths: string[] = [];
            if (call.name === "artifact_export")
              // A copied artifact can write several files: its result lists them.
              paths.push(...exportedPaths(catalog.callResult(id, call.id)));
            else {
              let path: unknown;
              try {
                path = (JSON.parse(call.arguments) as Record<string, unknown>).path;
              } catch {
                continue;
              }
              if (typeof path === "string" && path) paths.push(path);
            }
            for (const path of paths) {
              const absolute = resolve(workspace, path);
              if (!inside(workspace, absolute)) continue;
              const rel = toPosix(relative(workspace, absolute));
              const at = meta.startedAt ?? 0;
              const prev = latest.get(rel);
              if (!prev || at >= prev.at)
                latest.set(rel, { ...(meta.runId ? { runId: meta.runId } : {}), at });
            }
          }
        }
        const last = page.items.at(-1);
        if (!page.hasMore || !last) break;
        after = last.seq;
      }
    }
    const top = latest.size ? await gitRoot(workspace) : undefined;
    const marks = top ? await gitStatus(workspace, top) : new Map<string, string>();
    const files: SessionChange[] = [...latest.entries()]
      .sort((a, b) => b[1].at - a[1].at || (a[0] < b[0] ? -1 : 1))
      .map(([path, meta]) => ({
        path,
        ...(meta.runId ? { lastRunId: meta.runId } : {}),
        effect: "write" as const,
        ...(marks.has(path) ? { gitStatus: marks.get(path) } : {}),
      }));
    return { body: { files } };
  });
}
