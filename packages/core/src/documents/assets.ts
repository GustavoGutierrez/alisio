/**
 * Asset resolution (spec 026 D12, §5.7.2): workspace files (realpath-contained) or artifacts of
 * the session, checked by magic bytes and size, then copied into the render bundle.
 */
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { DOCUMENT_LIMITS, DocumentError } from "./limits.ts";
import { sanitizeSvg } from "./svg-sanitize.ts";

export interface AssetRequest {
  id: string;
  path?: string | undefined;
  artifactId?: string | undefined;
  alt?: string | undefined;
}

export interface ResolvedAsset {
  id: string;
  /** Bundle-relative file, e.g. `assets/img1.png`. */
  file: string;
  mime: string;
  bytes: number;
  alt: string;
}

export interface AssetContext {
  workspaceRoot: string;
  trusted: boolean;
  /** Reads an artifact of the same session (bytes), or undefined when it is unknown. */
  readArtifact?: (id: string) => Promise<Uint8Array | undefined>;
}

/** A security violation: the whole call fails. */
const denied = (message: string) => new DocumentError("DOCUMENT_ASSET_DENIED", message);

/** An asset that cannot be used (missing, wrong type, too large): the image is skipped, not the document. */
class SkippedAsset extends DocumentError {
  constructor(message: string) {
    super("DOCUMENT_ASSET_DENIED", message);
  }
}
const skipped = (message: string) => new SkippedAsset(message);

/** Image type by magic bytes, or undefined. */
export function sniffImage(b: Uint8Array): { mime: string; ext: string } | undefined {
  const at = (i: number, s: string) => s.split("").every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length > 8 && b[0] === 0x89 && at(1, "PNG") && b[4] === 0x0d)
    return { mime: "image/png", ext: "png" };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return { mime: "image/jpeg", ext: "jpg" };
  if (b.length > 12 && at(0, "RIFF") && at(8, "WEBP")) return { mime: "image/webp", ext: "webp" };
  if (b.length > 6 && (at(0, "GIF87a") || at(0, "GIF89a")))
    return { mime: "image/gif", ext: "gif" };
  return undefined;
}

export async function readWorkspaceFile(
  path: string,
  ctx: AssetContext,
  maxBytes: number = DOCUMENT_LIMITS.assetBytes,
): Promise<Uint8Array> {
  if (!ctx.trusted) throw denied("Assets from the workspace need a trusted project");
  if (isAbsolute(path) || /^[a-z]:/i.test(path) || path.includes("\0"))
    throw denied("Asset paths must be relative to the workspace");
  const clean = normalize(path);
  if (clean === ".." || clean.startsWith(`..${sep}`) || clean.split(/[\\/]/).includes(".."))
    throw denied("Asset paths must stay inside the workspace");
  const root = await realpath(ctx.workspaceRoot);
  const target = join(root, clean);
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw skipped(`file not found: ${clean}`);
  }
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    throw denied("Asset resolves outside the workspace");
  const info = await lstat(real);
  if (!info.isFile()) throw skipped(`not a file: ${clean}`);
  if (info.size > maxBytes)
    throw skipped(`larger than ${Math.round(maxBytes / 1024)} KB: ${clean}`);
  return new Uint8Array(await readFile(real));
}

export interface SkippedImage {
  id: string;
  alt: string;
  reason: string;
}

export interface ResolvedAssets {
  assets: Map<string, ResolvedAsset>;
  /** Images left out (missing, unsupported type, too large): placeholders plus a QA warning. */
  skipped: SkippedImage[];
}

const isSvg = (b: Uint8Array) =>
  /^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(
    Buffer.from(b.subarray(0, 4000)).toString("utf8"),
  );

/**
 * Resolves and copies every asset into `<bundleDir>/assets/`. Security violations (absolute path,
 * `..`, a link leaving the workspace, an untrusted project) throw; an asset that is merely
 * missing, too large or not a supported image type is skipped and reported.
 */
export async function resolveAssets(
  requests: readonly AssetRequest[],
  bundleDir: string,
  ctx: AssetContext,
): Promise<ResolvedAssets> {
  const out = new Map<string, ResolvedAsset>();
  const skippedImages: SkippedImage[] = [];
  if (requests.length > DOCUMENT_LIMITS.assets)
    throw new DocumentError(
      "DOCUMENT_LIMIT_EXCEEDED",
      `At most ${DOCUMENT_LIMITS.assets} assets are allowed`,
    );
  let total = 0;
  const seen = new Set<string>();
  for (const req of requests) {
    if (!/^[a-z0-9_-]{1,40}$/.test(req.id)) throw denied(`Invalid asset id "${req.id}"`);
    if (seen.has(req.id)) throw denied(`Duplicate asset id "${req.id}"`);
    seen.add(req.id);
    if (!!req.path === !!req.artifactId)
      throw denied(`Asset "${req.id}" needs exactly one of path or artifactId`);
    try {
      let bytes: Uint8Array;
      if (req.path) bytes = await readWorkspaceFile(req.path, ctx);
      else {
        const found = await ctx.readArtifact?.(req.artifactId as string);
        if (!found) throw skipped("artifact not found");
        if (found.length > DOCUMENT_LIMITS.assetBytes) throw skipped("larger than 10 MB");
        bytes = found;
      }
      let kind = sniffImage(bytes);
      if (!kind && isSvg(bytes)) {
        // SVG is rebuilt from an allowlist; what cannot be made safe is skipped.
        const clean = sanitizeSvg(bytes);
        if (!clean.ok) throw skipped(`SVG image was not used (${clean.reason})`);
        bytes = Buffer.from(clean.svg, "utf8");
        kind = { mime: "image/svg+xml", ext: "svg" };
      }
      if (!kind) throw skipped("not a PNG, JPEG, WebP, GIF or SVG image");
      total += bytes.length;
      if (total > DOCUMENT_LIMITS.totalAssetBytes)
        throw new DocumentError(
          "DOCUMENT_LIMIT_EXCEEDED",
          `Assets exceed ${DOCUMENT_LIMITS.totalAssetBytes / (1024 * 1024)} MB in total`,
        );
      const file = `assets/${req.id}.${kind.ext}`;
      await mkdir(dirname(join(bundleDir, file)), { recursive: true });
      await writeFile(join(bundleDir, file), bytes);
      out.set(req.id, {
        id: req.id,
        file,
        mime: kind.mime,
        bytes: bytes.length,
        alt: req.alt ?? "",
      });
    } catch (error) {
      if (!(error instanceof SkippedAsset)) throw error;
      skippedImages.push({ id: req.id, alt: req.alt ?? "", reason: error.message });
    }
  }
  return { assets: out, skipped: skippedImages };
}
