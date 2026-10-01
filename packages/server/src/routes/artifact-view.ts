/**
 * The isolated artifact viewer (spec §14.2): `GET|HEAD /artifact-view/<token>/<path>`, outside
 * `/api` and without the session cookie (a sandboxed iframe never sends it). The signed token
 * names one artifact; only files listed in its manifest are served, with headers that replace
 * the app's: framable by the app origin only, an opaque origin (`sandbox`) and no network.
 */
import { createReadStream } from "node:fs";
import type { ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { type ArtifactStore, viewerContentType } from "@alisio/core";
import { verifyViewToken } from "../auth/view-token.ts";
import { HttpError } from "../http/errors.ts";
import type { RouteContext, Router } from "../http/router.ts";
import { viewable } from "./artifacts.ts";

/** Path prefix of the viewer route. */
export const VIEW_PREFIX = "/artifact-view/";

/**
 * Headers every viewer response starts with (also errors): unframable, inert and uncached. A
 * successful file response relaxes framing to the app origin with {@link viewerHeaders}.
 */
export function viewerBaseHeaders(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; sandbox");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cache-Control", "private, no-store");
}

/** The CSP of an HTML artifact (and its assets) under `origin`/`base` (§14.2). */
export function dashboardCsp(origin: string, base: string): string {
  return [
    "default-src 'none'",
    `script-src ${base} 'unsafe-inline'`,
    `style-src ${base} 'unsafe-inline'`,
    `img-src ${base} data: blob:`,
    `font-src ${base} data:`,
    `media-src ${base} data: blob:`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${origin}`,
    "sandbox allow-scripts allow-downloads",
  ].join("; ");
}

export function registerArtifactViewRoutes(
  router: Router,
  ctx: { artifacts: ArtifactStore; secret: string; now?: () => number },
): void {
  const handler = async ({ req, res, params }: RouteContext) => {
    const token = params.token ?? "";
    const check = verifyViewToken(ctx.secret, token, (ctx.now ?? Date.now)());
    if (!check.ok)
      throw new HttpError(
        "permission_denied",
        check.reason === "expired" ? "This view link expired" : "Invalid view link",
      );
    const record = ctx.artifacts.get(check.artifactId);
    if (!record || record.status !== "ready" || !viewable(record))
      throw new HttpError("artifact_not_found", "Artifact not found");
    const file = await ctx.artifacts.resolveFile(record, params["*"] ?? "");
    if (!file) throw new HttpError("artifact_not_found", "File not found in this artifact");
    // `checkHost` already validated the Host header: it names this server.
    const origin = `http://${req.headers.host ?? ""}`;
    const pdf =
      record.mimeType === "application/pdf" && file.path === (record.entry ?? record.fileName);
    res.removeHeader("X-Frame-Options");
    res.setHeader(
      "Content-Security-Policy",
      // Chromium's PDF viewer does not load in a sandboxed context (risk R6, decision D9).
      pdf
        ? `default-src 'none'; frame-ancestors ${origin}`
        : dashboardCsp(origin, `${origin}/artifact-view/${token}/`),
    );
    // The opaque-origin document must be able to load its own files.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.writeHead(200, {
      "Content-Type": pdf ? "application/pdf" : viewerContentType(file.path),
      "Content-Length": file.bytes,
    });
    if (req.method === "HEAD") res.end();
    else await pipeline(createReadStream(file.abs), res);
    return undefined;
  };
  router.get(`${VIEW_PREFIX}:token/*`, handler);
  router.add("HEAD", `${VIEW_PREFIX}:token/*`, handler);
}
