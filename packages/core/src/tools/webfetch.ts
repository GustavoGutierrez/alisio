/**
 * `webfetch`: read a URL as text/markdown/html. Node-native `fetch` only (no extra HTTP client
 * dependency); HTML conversion uses `turndown` (a small, widely used converter whose only runtime
 * dependency is `@mixmark-io/domino`, a pure-JS DOM implementation — no jsdom, no headless
 * browser). This mirrors the vetted approach opencode itself uses for the same job.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import domino from "@mixmark-io/domino";
import TurndownService from "turndown";
import { safePath } from "../runtime/paths.ts";

export type WebfetchFormat = "markdown" | "text" | "html";
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MiB, matching the size cap other well-known fetch tools use.
export const MAX_TIMEOUT_SECONDS = 120;
export const DEFAULT_TIMEOUT_SECONDS = 30;
/** Characters embedded directly in the tool result before the rest is only available via `read_file`. */
export const MAX_EMBEDDED_CHARS = 20_000;

const TEXTUAL_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/atom+xml",
  "application/rss+xml",
]);
export function isTextualContentType(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return type.startsWith("text/") || TEXTUAL_TYPES.has(type);
}

function htmlToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
  });
  turndown.remove(["script", "style", "noscript", "meta", "link"]);
  return turndown.turndown(html).trim();
}
function htmlToText(html: string): string {
  const document = domino.createDocument(html);
  for (const el of [...document.querySelectorAll("script, style, noscript")]) el.remove();
  const text = document.body?.textContent ?? document.documentElement?.textContent ?? "";
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

export interface WebfetchResult {
  url: string;
  status: number;
  contentType: string;
  format: WebfetchFormat;
  content: string;
  truncated: boolean;
  /** Present only when `truncated`: a workspace-relative path with the full converted text, readable via `read_file`. */
  fullTextPath?: string;
  bytes: number;
}
/**
 * Fetches `url` and returns it as text/markdown/html. Redirects are followed by `fetch` itself
 * (capped at the runtime's own default, ~20 hops). Non-textual responses (images, binaries) are
 * refused with a clear error rather than returned as garbage. When the converted text is larger
 * than `MAX_EMBEDDED_CHARS`, the full text is written to a workspace-scoped cache file
 * (`.alisio/cache/webfetch/<hash>.<ext>`) so a follow-up `read_file` is never lossy.
 */
export async function webfetch(
  workspace: string,
  url: string,
  format: WebfetchFormat = "markdown",
  timeoutSeconds: number = DEFAULT_TIMEOUT_SECONDS,
  signal: AbortSignal,
): Promise<WebfetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`webfetch: not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error(`webfetch only supports http(s) URLs, got: ${parsed.protocol}`);
  const seconds = Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, timeoutSeconds));
  const combined = AbortSignal.any([signal, AbortSignal.timeout(seconds * 1000)]);
  const res = await fetch(parsed, {
    signal: combined,
    redirect: "follow",
    headers: {
      // A default fetch UA is blocked by some sites; a browser-like UA matches common practice
      // for this exact kind of tool (opencode does the same) without impersonating a real user.
      "User-Agent":
        "Mozilla/5.0 (compatible; AlisioAgent/1.0; +https://github.com/GustavoGutierrez/alisio)",
      Accept: format === "html" ? "text/html,*/*;q=0.8" : "text/html,text/plain,*/*;q=0.8",
    },
  });
  const contentType = res.headers.get("content-type") ?? "";
  const declaredLength = Number(res.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_RESPONSE_BYTES)
    throw new Error(
      `webfetch: response too large (${declaredLength} bytes, limit ${MAX_RESPONSE_BYTES})`,
    );
  if (!isTextualContentType(contentType))
    throw new Error(
      `webfetch only supports textual content (text/*, JSON, XML); got content-type ` +
        `"${contentType || "unknown"}". Binary and image responses are refused.`,
    );
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > MAX_RESPONSE_BYTES)
    throw new Error(
      `webfetch: response too large (${buffer.byteLength} bytes, limit ${MAX_RESPONSE_BYTES})`,
    );
  const raw = Buffer.from(buffer).toString("utf8");
  const isHtml = contentType.includes("html");
  const converted =
    format === "html"
      ? raw
      : isHtml
        ? format === "text"
          ? htmlToText(raw)
          : htmlToMarkdown(raw)
        : raw;
  const truncated = converted.length > MAX_EMBEDDED_CHARS;
  let fullTextPath: string | undefined;
  if (truncated) {
    const ext = format === "html" ? "html" : format === "text" ? "txt" : "md";
    const hash = createHash("sha256").update(`${url}\n${format}`).digest("hex").slice(0, 24);
    const relative = join(".alisio", "cache", "webfetch", `${hash}.${ext}`);
    const path = await safePath(workspace, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, converted, "utf8");
    fullTextPath = relative;
  }
  return {
    url: parsed.toString(),
    status: res.status,
    contentType,
    format,
    content: converted.slice(0, MAX_EMBEDDED_CHARS),
    truncated,
    ...(fullTextPath ? { fullTextPath } : {}),
    bytes: buffer.byteLength,
  };
}
