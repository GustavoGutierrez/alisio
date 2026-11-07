/**
 * Validation and sanitization of the published plugin catalog (`catalog.json`). The catalog is
 * remote, untrusted data: every field is type-checked and length-capped, links must be `https:`,
 * the cover must live on the catalog's own origin, and an entry with an invalid npm name or
 * version is dropped. Counts are recomputed, never trusted.
 */
import { comparePluginVersions, parsePluginSpec } from "@alisio/core";

export const SUPPORTED_SCHEMA_VERSION = 1;
const MAX_PLUGINS = 500;

export interface CatalogPlugin {
  id: string;
  slug: string;
  name: string;
  package: string;
  version: string;
  description: string;
  categories: string[];
  tags: string[];
  /** The plugin's declared `@alisio/sdk` range. */
  sdk?: string;
  author?: string;
  license?: string;
  homepage?: string;
  npmUrl?: string;
  repository?: string;
  publishedAt?: string;
  featured: boolean;
  /** Where the cover is fetched from (on the catalog origin); never sent to the browser. */
  coverSource?: string;
}

export interface SanitizedCatalog {
  generatedAt?: string;
  categories: Array<{ id: string; count: number }>;
  plugins: CatalogPlugin[];
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TAG_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._+#/-]{0,39}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  // Control characters have no place in a catalog label.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned.length > 0 && cleaned.length <= max ? cleaned : undefined;
}

export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/** A plain `https:` URL without credentials (loopback `http:` is accepted only for tests/dev). */
export function safeUrl(value: unknown, max = 500, allowHttpLoopback = false): URL | undefined {
  if (typeof value !== "string" || value.length > max) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && allowHttpLoopback && isLoopbackHostname(url.hostname)) return url;
  return undefined;
}

/** Whether `url` is on the same origin as the catalog document itself. */
export function sameOrigin(url: URL, catalogUrl: URL): boolean {
  return url.origin === catalogUrl.origin;
}

function stringList(value: unknown, itemMax: number, cap: number, pattern?: RegExp): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const entry = text(item, itemMax);
    if (!entry || (pattern && !pattern.test(entry)) || out.includes(entry)) continue;
    out.push(entry);
    if (out.length >= cap) break;
  }
  return out;
}

function sanitizePlugin(
  raw: unknown,
  catalogUrl: URL,
  loopbackOk: boolean,
): CatalogPlugin | undefined {
  if (!isRecord(raw)) return undefined;
  const slug = text(raw.slug, 64);
  const name = text(raw.name, 100);
  const pkg = text(raw.package, 214);
  const version = text(raw.version, 64);
  if (!slug || !SLUG_RE.test(slug) || !name || !pkg || !version) return undefined;
  if (comparePluginVersions(version, version) === undefined) return undefined;
  try {
    const parsed = parsePluginSpec(pkg);
    if (parsed.version !== undefined || parsed.name !== pkg) return undefined;
  } catch {
    return undefined;
  }
  const link = (value: unknown) => safeUrl(value, 500, loopbackOk)?.href;
  const cover = safeUrl(raw.cover, 500, loopbackOk);
  const sdk = text(raw.sdk, 60);
  const author = text(raw.author, 100);
  const license = text(raw.license, 60);
  const homepage = link(raw.homepage);
  const npmUrl = link(raw.npmUrl);
  const repository = link(raw.repository);
  const publishedAt = text(raw.publishedAt, 40);
  return {
    id: text(raw.id, 100) ?? slug,
    slug,
    name,
    package: pkg,
    version,
    description: text(raw.description, 600) ?? "",
    categories: stringList(raw.categories, 40, 8, /^[a-z0-9][a-z0-9-]*$/),
    tags: stringList(raw.tags, 40, 12, TAG_RE),
    ...(sdk ? { sdk } : {}),
    ...(author ? { author } : {}),
    ...(license ? { license } : {}),
    ...(homepage ? { homepage } : {}),
    ...(npmUrl ? { npmUrl } : {}),
    ...(repository ? { repository } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    featured: raw.featured === true,
    ...(cover && sameOrigin(cover, catalogUrl) ? { coverSource: cover.href } : {}),
  };
}

/** Validates a parsed catalog document; throws a short error for an unusable document. */
export function sanitizeCatalog(raw: unknown, catalogUrl: string): SanitizedCatalog {
  if (!isRecord(raw)) throw new Error("The plugin catalog is not a JSON object");
  if (raw.schemaVersion !== SUPPORTED_SCHEMA_VERSION)
    throw new Error(
      `Unsupported plugin catalog schema version (expected ${SUPPORTED_SCHEMA_VERSION})`,
    );
  if (!Array.isArray(raw.plugins)) throw new Error("The plugin catalog has no plugin list");
  const base = new URL(catalogUrl);
  const loopbackOk = base.protocol === "http:" && isLoopbackHostname(base.hostname);
  const plugins: CatalogPlugin[] = [];
  const slugs = new Set<string>();
  const packages = new Set<string>();
  for (const entry of raw.plugins.slice(0, MAX_PLUGINS)) {
    const plugin = sanitizePlugin(entry, base, loopbackOk);
    if (!plugin || slugs.has(plugin.slug) || packages.has(plugin.package)) continue;
    slugs.add(plugin.slug);
    packages.add(plugin.package);
    plugins.push(plugin);
  }
  const counts = new Map<string, number>();
  for (const plugin of plugins)
    for (const id of plugin.categories) counts.set(id, (counts.get(id) ?? 0) + 1);
  const categories = [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  const generatedAt = text(raw.generatedAt, 40);
  return { ...(generatedAt ? { generatedAt } : {}), categories, plugins };
}
