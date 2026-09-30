import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

/**
 * Default location of the web UI build: `dist/web` next to the compiled server
 * (`packages/server/dist/web`, filled by the `@alisio/web` build in phase 3).
 */
export function defaultWebRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "web");
}

/** Served when the web UI assets are not installed (source checkouts, standalone binary). */
export const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Alisio</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem">
<h1>Alisio server is running</h1>
<p>The web UI assets are not installed in this build, so only the HTTP API is available
(<a href="/api/health">/api/health</a>). Install the npm package <code>@alisio/alisio-code</code>
to get the web UI.</p>
</body>
</html>
`;

/** SHA-256 CSP sources for every inline `<script>` of an HTML document. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = match[1] ?? "";
    if (body.trim())
      hashes.push(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
  }
  return hashes;
}

/** The Content-Security-Policy of §11.1, allowing the given inline script hashes. */
export function contentSecurityPolicy(scriptHashes: string[] = []): string {
  return [
    "default-src 'self'",
    `script-src ${["'self'", ...scriptHashes].join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Serves the web UI build with an SPA fallback to `index.html`. Paths are confined to the root
 * (resolved and realpath-checked); a missing build serves {@link PLACEHOLDER_HTML}.
 */
export class StaticAssets {
  readonly root: string;
  readonly installed: boolean;
  readonly index: string;
  readonly csp: string;

  constructor(root = defaultWebRoot()) {
    this.root = resolve(root);
    const indexPath = join(this.root, "index.html");
    this.installed = existsSync(indexPath);
    this.index = this.installed ? readFileSync(indexPath, "utf8") : PLACEHOLDER_HTML;
    this.csp = contentSecurityPolicy(inlineScriptHashes(this.index));
  }

  /** Serves a GET/HEAD for a non-API path. */
  async serve(res: ServerResponse, pathname: string, head = false): Promise<void> {
    const file = this.installed ? await this.resolveFile(pathname) : undefined;
    if (!file) {
      if (extname(pathname) && pathname !== "/index.html") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(head ? undefined : "Not found");
        return;
      }
      this.send(res, 200, MIME[".html"] as string, Buffer.from(this.index), "no-store", head);
      return;
    }
    const bytes = await readFile(file);
    const immutable = pathname.startsWith("/assets/");
    this.send(
      res,
      200,
      MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      bytes,
      immutable ? "public, max-age=31536000, immutable" : "no-cache",
      head,
    );
  }

  private async resolveFile(pathname: string): Promise<string | undefined> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return undefined;
    }
    if (decoded.includes("\0")) return undefined;
    const candidate = resolve(this.root, `.${decoded}`);
    if (candidate !== this.root && !candidate.startsWith(this.root + sep)) return undefined;
    try {
      const [real, rootReal] = await Promise.all([realpath(candidate), realpath(this.root)]);
      if (!real.startsWith(rootReal + sep)) return undefined;
      return (await stat(real)).isFile() ? real : undefined;
    } catch {
      return undefined;
    }
  }

  private send(
    res: ServerResponse,
    status: number,
    type: string,
    bytes: Buffer,
    cache: string,
    head: boolean,
  ) {
    res.writeHead(status, {
      "Content-Type": type,
      "Content-Length": bytes.length,
      "Cache-Control": cache,
    });
    res.end(head ? undefined : bytes);
  }
}
