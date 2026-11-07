/**
 * Inspection of a plugin tarball (`.tgz` from `npm pack`/`pnpm pack`) without extracting it and
 * without any external `tar`: a streaming gzip + ustar reader that only keeps `package/package.json`.
 * Everything is bounded (compressed size, expanded size, entry count, manifest size) and any entry
 * path that could escape the package directory rejects the whole archive.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { PLUGIN_KEYWORD } from "../runtime/modules.ts";
import { parsePluginSpec } from "./install.ts";
import { comparePluginVersions } from "./version-compat.ts";

export const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
export const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
export const MAX_TARBALL_ENTRIES = 20_000;
export const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_META_BYTES = 64 * 1024;
const LIFECYCLE = ["preinstall", "install", "postinstall"] as const;

export interface TarballLimits {
  maxPackageJsonBytes?: number;
  maxEntries?: number;
  maxExpandedBytes?: number;
}

export class TarballError extends Error {}

const str = (block: Buffer, start: number, length: number): string => {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? slice.length : end).toString("utf8");
};

function parseSize(block: Buffer): number {
  if ((block[124] ?? 0) & 0x80)
    throw new TarballError("The archive has an entry that is too large");
  const value = Number.parseInt(str(block, 124, 12).trim() || "0", 8);
  if (!Number.isFinite(value) || value < 0) throw new TarballError("The archive is corrupt");
  return value;
}

function checksumOk(block: Buffer): boolean {
  const stored = Number.parseInt(str(block, 148, 8).trim() || "x", 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
  return stored === sum;
}

/** Path of the `path=` record of a pax extended header, if any. */
function paxPath(data: Buffer): string | undefined {
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) return undefined;
    const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isFinite(length) || length <= 0) return undefined;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    if (record.startsWith("path=")) return record.slice(5);
    offset += length;
  }
  return undefined;
}

/** Normalized entry name; throws for anything that is absolute or climbs out with `..`. */
function safeName(raw: string): string {
  const name = raw.replace(/\/+$/, "");
  if (name.startsWith("/") || name.includes("\\") || /^[A-Za-z]:/.test(name))
    throw new TarballError(`The archive has an unsafe path: ${raw.slice(0, 80)}`);
  if (name.split("/").some((part) => part === ".."))
    throw new TarballError(`The archive has an unsafe path: ${raw.slice(0, 80)}`);
  return name;
}

/**
 * Reads `package/package.json` from a gzip ustar stream. Throws `TarballError` with a user-facing
 * reason for anything unusable (not gzip, corrupt, unsafe path, over a limit, no manifest).
 */
export async function readTarballPackageJson(
  source: Readable,
  limits: TarballLimits = {},
): Promise<{ packageJson: unknown; entries: number }> {
  const maxJson = limits.maxPackageJsonBytes ?? MAX_PACKAGE_JSON_BYTES;
  const maxEntries = limits.maxEntries ?? MAX_TARBALL_ENTRIES;
  const maxExpanded = limits.maxExpandedBytes ?? MAX_EXPANDED_BYTES;
  const gunzip = createGunzip();
  source.on("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);

  type Mode = "skip" | "manifest" | "pax" | "longname";
  let state: "header" | "data" | "pad" | "end" = "header";
  let buf: Buffer = Buffer.alloc(0);
  let remaining = 0;
  let mode: Mode = "skip";
  let collected: Buffer[] = [];
  let pendingName: string | undefined;
  let entries = 0;
  let expanded = 0;
  let manifest: Buffer | undefined;
  let padding = 0;

  const finishData = () => {
    const data = Buffer.concat(collected);
    collected = [];
    if (mode === "manifest") manifest = data;
    else if (mode === "pax") pendingName = paxPath(data) ?? pendingName;
    else if (mode === "longname") pendingName = str(data, 0, data.length);
    mode = "skip";
  };

  const header = (block: Buffer) => {
    if (block.every((byte) => byte === 0)) {
      state = "end";
      return;
    }
    if (!checksumOk(block))
      throw new TarballError("The file is not a valid tar archive (corrupt header checksum)");
    const prefix = str(block, 345, 155);
    const own = str(block, 0, 100);
    const size = parseSize(block);
    const type = String.fromCharCode(block[156] || 0x30);
    padding = (512 - (size % 512)) % 512;
    if (type === "x" || type === "L" || type === "g") {
      if (size > MAX_META_BYTES)
        throw new TarballError("The archive has an oversized header record");
      mode = type === "x" ? "pax" : type === "L" ? "longname" : "skip";
    } else {
      entries++;
      if (entries > maxEntries) throw new TarballError("The archive has too many entries");
      const name = safeName(pendingName ?? (prefix ? `${prefix}/${own}` : own));
      pendingName = undefined;
      mode = "skip";
      if (name === "package/package.json" && (type === "0" || type === "7")) {
        if (size > maxJson) throw new TarballError("package.json is too large");
        mode = "manifest";
      }
    }
    remaining = size;
    state = remaining > 0 ? "data" : padding > 0 ? "pad" : "header";
    if (remaining === 0 && mode !== "skip") finishData();
  };

  const pump = () => {
    for (;;) {
      if (state === "end") return;
      if (state === "header") {
        if (buf.length < 512) return;
        const block = buf.subarray(0, 512);
        buf = buf.subarray(512);
        header(block);
        continue;
      }
      const take = Math.min(remaining, buf.length);
      if (take === 0) return;
      if (state === "data" && mode !== "skip") {
        collected.push(buf.subarray(0, take));
      }
      buf = buf.subarray(take);
      remaining -= take;
      if (remaining > 0) return;
      if (state === "data") {
        if (mode !== "skip") finishData();
        remaining = padding;
        state = padding > 0 ? "pad" : "header";
      } else state = "header";
    }
  };

  try {
    for await (const chunk of gunzip) {
      expanded += (chunk as Buffer).length;
      if (expanded > maxExpanded)
        throw new TarballError("The archive expands beyond the allowed size");
      buf = buf.length ? Buffer.concat([buf, chunk as Buffer]) : (chunk as Buffer);
      pump();
    }
  } catch (error) {
    if (error instanceof TarballError) throw error;
    throw new TarballError("The file is not a gzip archive (.tgz)");
  } finally {
    source.unpipe(gunzip);
    source.destroy();
  }
  const last = state as string;
  if (last !== "end" && last !== "header") throw new TarballError("The archive is truncated");
  if (entries === 0 && last !== "end")
    throw new TarballError("The file is not a valid tar archive");
  if (!manifest) throw new TarballError("The archive has no package/package.json");
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(manifest.toString("utf8"));
  } catch {
    throw new TarballError("package/package.json is not valid JSON");
  }
  return { packageJson, entries };
}

export interface PluginTarballInfo {
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  license?: string;
  /** `peerDependencies["@alisio/sdk"]`. */
  sdkRange?: string;
  /** True when every check passed; `reasons` lists what failed otherwise. */
  isAlisioPlugin: boolean;
  reasons: string[];
  /** Declared `preinstall`/`install`/`postinstall` scripts (npm runs them on install). */
  lifecycleScripts: string[];
  size: number;
}

const text = (value: unknown, max = 500): string | undefined =>
  typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;

/** Validates a tarball on disk as an Alisio plugin package; never throws for bad content. */
export async function inspectPluginTarball(
  path: string,
  limits: TarballLimits & { maxBytes?: number } = {},
): Promise<PluginTarballInfo> {
  const size = (await stat(path)).size;
  const info: PluginTarballInfo = {
    isAlisioPlugin: false,
    reasons: [],
    lifecycleScripts: [],
    size,
  };
  const maxBytes = limits.maxBytes ?? MAX_TARBALL_BYTES;
  if (size > maxBytes) {
    info.reasons.push(`The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`);
    return info;
  }
  let json: unknown;
  try {
    json = (await readTarballPackageJson(createReadStream(path), limits)).packageJson;
  } catch (error) {
    info.reasons.push(error instanceof TarballError ? error.message : "The file could not be read");
    return info;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    info.reasons.push("package/package.json is not an object");
    return info;
  }
  const pkg = json as Record<string, unknown>;
  const name = text(pkg.name, 214);
  const version = text(pkg.version, 64);
  let nameOk = false;
  if (name) {
    try {
      const parsed = parsePluginSpec(name);
      nameOk = parsed.version === undefined && parsed.name === name;
    } catch {
      nameOk = false;
    }
  }
  if (nameOk) info.name = name;
  else info.reasons.push("The package name is missing or not a valid npm package name");
  if (version && comparePluginVersions(version, version) !== undefined) info.version = version;
  else info.reasons.push("The package version is missing or not a valid semver version");
  const keywords = Array.isArray(pkg.keywords) ? pkg.keywords : [];
  if (!keywords.includes(PLUGIN_KEYWORD))
    info.reasons.push(
      `Not an Alisio plugin: package.json keywords must include "${PLUGIN_KEYWORD}"`,
    );
  const hasExports =
    (typeof pkg.exports === "string" && pkg.exports.length > 0) ||
    (!!pkg.exports && typeof pkg.exports === "object" && Object.keys(pkg.exports).length > 0);
  if (!hasExports && !text(pkg.main))
    info.reasons.push('The package has no entry point ("exports" or "main" in package.json)');
  const description = text(pkg.description, 600);
  if (description) info.description = description;
  const author =
    text(pkg.author) ??
    (pkg.author && typeof pkg.author === "object"
      ? text((pkg.author as Record<string, unknown>).name)
      : undefined);
  if (author) info.author = author;
  const license = text(pkg.license, 80);
  if (license) info.license = license;
  const peers = pkg.peerDependencies;
  const range =
    peers && typeof peers === "object"
      ? text((peers as Record<string, unknown>)["@alisio/sdk"], 80)
      : undefined;
  if (range) info.sdkRange = range;
  const scripts =
    pkg.scripts && typeof pkg.scripts === "object" ? (pkg.scripts as Record<string, unknown>) : {};
  info.lifecycleScripts = LIFECYCLE.filter((key) => typeof scripts[key] === "string");
  info.isAlisioPlugin = info.reasons.length === 0;
  return info;
}
