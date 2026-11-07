/**
 * `GET|POST /api/server/restart`: lets the UI restart the host when a supervisor (the desktop app)
 * respawns it. An update of a plugin that is already loaded only takes effect in a new process,
 * because Node keeps imported modules for the process lifetime. Without a supervisor nothing is
 * exposed beyond `available: false`: a bare `alisio serve` must be restarted by its owner.
 */
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { validate } from "../schemas.ts";

export interface RestartRouteOptions {
  /** Present only when a supervisor will respawn this process. */
  restart?: () => void;
  readOnly?: boolean;
}

export function registerRestartRoutes(router: Router, options: RestartRouteOptions): void {
  router.get("/api/server/restart", () => ({
    body: { available: !!options.restart && !options.readOnly },
  }));
  router.post("/api/server/restart", async ({ req, res }) => {
    validate(await readJson(req), { confirmed: { check: (v) => v === true, required: true } });
    if (options.readOnly)
      throw new HttpError("capability_ceiling", "Restarting is unavailable under --read-only");
    if (!options.restart)
      throw new HttpError(
        "not_manageable",
        "This server has no supervisor to restart it: restart `alisio serve` yourself",
      );
    const restart = options.restart;
    res.once("finish", () => restart());
    return { body: { restarting: true } };
  });
}
