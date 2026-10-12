/**
 * The scratchpad of a session over HTTP (Forja spec §9.4, §11.1): list, download one file and empty
 * it. The scratchpad belongs to the ROOT session (children share it). Responses carry names relative
 * to the folder, never a host path; downloads never follow a symlink; emptying is refused with
 * `409 runs_active` while a Forja execution of the session still runs.
 */
import { pipeline } from "node:stream/promises";
import {
  emptyScratch,
  ForgeError,
  listScratch,
  openScratchFile,
  type SQLiteStore,
} from "@alisio/core";
import type { ScratchClearResult, ScratchListing } from "@alisio/sdk";
import type { SessionService } from "../host/sessions.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { attachmentDisposition } from "./artifacts.ts";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

export function registerScratchRoutes(
  router: Router,
  ctx: { sessions: SessionService; catalog: SQLiteStore; readOnly?: boolean },
): void {
  const { sessions } = ctx;

  /**
   * The session, its application and its scratchpad folder. `available` is false when the gate of
   * the write root is closed (engine not verified, `--read-only`, Forja off); `pad` is undefined
   * until the model first writes there: looking never creates it.
   */
  async function scratchOf(sid: string) {
    const session = sessions.get(sid);
    const opened = await sessions.app(session);
    const view = opened.app.forge.scratchpadView;
    const state = view ? await view(session.id) : { available: false as const };
    return { session, opened, available: state.available, pad: state.path };
  }

  router.get("/api/sessions/:sid/scratch", async ({ params }) => {
    const { opened, available, pad } = await scratchOf(params.sid ?? "");
    const quotaBytes = opened.app.config.forge.scratch.maxBytes;
    if (!available) {
      const body: ScratchListing = { available: false, files: [], usedBytes: 0, quotaBytes };
      return { body };
    }
    if (!pad) {
      const body: ScratchListing = { available: true, files: [], usedBytes: 0, quotaBytes };
      return { body };
    }
    const { files, usedBytes, truncated } = await listScratch(pad);
    const body: ScratchListing = {
      available: true,
      files,
      usedBytes,
      quotaBytes,
      ...(truncated ? { truncated: true } : {}),
    };
    return { body };
  });

  router.get("/api/sessions/:sid/scratch/files/*", async ({ params, res }) => {
    const { pad } = await scratchOf(params.sid ?? "");
    if (!pad) throw new HttpError("not_found", "File not found");
    const opened = await openScratchFile(pad, params["*"] ?? "").catch((error) => {
      // A missing file, a link and an escape all look the same from outside.
      if (error instanceof ForgeError || (error as NodeJS.ErrnoException).code === "ENOENT")
        throw new HttpError("not_found", "File not found");
      throw error;
    });
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": opened.size,
      "Content-Disposition": attachmentDisposition(opened.name),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    });
    await pipeline(opened.handle.createReadStream(), res);
    return undefined;
  });

  router.delete("/api/sessions/:sid/scratch", async ({ params }) => {
    if (ctx.readOnly)
      throw new HttpError(
        "capability_ceiling",
        "The scratchpad cannot be emptied in read-only mode",
      );
    const { session, opened, pad } = await scratchOf(params.sid ?? "");
    const root = sessions.rootOf(session.id);
    if (
      opened.app.forge.journal.listByRoot(root).some((execution) => !TERMINAL.has(execution.status))
    )
      throw new HttpError("runs_active", "Wait for the running script to finish, then retry");
    const body: ScratchClearResult = pad ? await emptyScratch(pad) : { removed: 0, freedBytes: 0 };
    return { body };
  });
}
