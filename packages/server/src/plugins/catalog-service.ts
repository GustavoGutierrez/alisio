/**
 * The plugin catalog client: one remote JSON document, cached on disk and revalidated only when it
 * is stale (24 h by default) or the user asks. A revalidation is a conditional request, so an
 * unchanged catalog costs a 304. Offline with a cache serves the cache; offline without one fails.
 * Covers are proxied from the catalog origin through a disk cache so the browser never makes a
 * third-party request (the web UI CSP would block it anyway).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stateHome } from "@alisio/core";
import {
  type CatalogPlugin,
  type SanitizedCatalog,
  safeUrl,
  sameOrigin,
  sanitizeCatalog,
} from "./catalog-schema.ts";

export const DEFAULT_CATALOG_URL = "https://gustavogutierrez.github.io/alisio-plugins/catalog.json";
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
export const CATALOG_TIMEOUT_MS = 10_000;
export const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
export const MAX_COVER_BYTES = 512 * 1024;

export interface CatalogMeta {
  etag?: string;
  lastModified?: string;
  /** When the catalog content was last downloaded (ms since epoch). */
  fetchedAt: number;
  /** When the catalog was last confirmed current (download or 304). */
  checkedAt: number;
}

interface CatalogCache {
  url: string;
  meta: CatalogMeta;
  catalog: SanitizedCatalog;
}

export interface CatalogResult {
  catalog: SanitizedCatalog;
  meta: {
    checkedAt: number;
    fetchedAt: number;
    fromCache: boolean;
    stale: boolean;
    offline: boolean;
    error?: string;
  };
}

export interface CatalogServiceOptions {
  /** Catalog document URL (default: `ALISIO_PLUGIN_CATALOG_URL`, else the published catalog). */
  url?: string;
  fetch?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}

/**
 * The on-disk form of a sanitized catalog: the cover source goes back under its catalog key so the
 * cache is validated by the same `sanitizeCatalog` it was produced by.
 */
function storable(catalog: SanitizedCatalog): unknown {
  return {
    ...catalog,
    plugins: catalog.plugins.map(({ coverSource, ...rest }) => ({
      ...rest,
      ...(coverSource ? { cover: coverSource } : {}),
    })),
  };
}

export class CatalogUnavailableError extends Error {}

export interface Cover {
  body: Buffer;
  etag: string;
  contentType: string;
}

/** Image types a cover may have, recognised by their bytes (never by the origin's header). */
const COVER_TYPES = [
  { type: "image/svg+xml", ext: "svg" },
  { type: "image/webp", ext: "webp" },
  { type: "image/png", ext: "png" },
  { type: "image/jpeg", ext: "jpg" },
] as const;

export function sniffCover(body: Buffer): (typeof COVER_TYPES)[number] | undefined {
  if (
    body.subarray(0, 4).toString("latin1") === "RIFF" &&
    body.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return COVER_TYPES[1];
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return COVER_TYPES[2];
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return COVER_TYPES[3];
  if (/<svg[\s>]/i.test(body.toString("utf8", 0, Math.min(body.length, 4096))))
    return COVER_TYPES[0];
  return undefined;
}

/** Body of `res` as a Buffer, refusing more than `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) throw new Error("The response is too large");
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new Error("The response is too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class CatalogService {
  private inflight = new Map<boolean, Promise<CatalogResult>>();
  private coverInflight = new Map<string, Promise<Cover | undefined>>();
  private fetcher: typeof fetch;
  private clock: () => number;

  constructor(private options: CatalogServiceOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.clock = options.now ?? Date.now;
  }

  get url(): string {
    return this.options.url ?? process.env.ALISIO_PLUGIN_CATALOG_URL ?? DEFAULT_CATALOG_URL;
  }
  private get ttl(): number {
    return this.options.ttlMs ?? CATALOG_TTL_MS;
  }
  private get cacheFile(): string {
    return join(stateHome(), "cache", "plugin-catalog.json");
  }
  private coverFile(slug: string, ext: string): string {
    return join(stateHome(), "cache", "plugin-covers", `${slug}.${ext}`);
  }
  private coverMetaFile(slug: string): string {
    return join(stateHome(), "cache", "plugin-covers", `${slug}.json`);
  }

  private async readCache(): Promise<CatalogCache | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.cacheFile, "utf8")) as Partial<CatalogCache>;
      if (parsed.url !== this.url || !parsed.meta || typeof parsed.meta.checkedAt !== "number")
        return undefined;
      // Re-sanitized on every read: the file is a cache on disk, not a trusted source.
      const catalog = sanitizeCatalog({ schemaVersion: 1, ...parsed.catalog }, this.url);
      return { url: parsed.url, meta: parsed.meta, catalog };
    } catch {
      return undefined;
    }
  }

  /** The catalog: from cache when fresh, else revalidated (`refresh` forces the check). */
  get(refresh = false): Promise<CatalogResult> {
    const running = this.inflight.get(refresh);
    if (running) return running;
    const task = this.load(refresh).finally(() => this.inflight.delete(refresh));
    this.inflight.set(refresh, task);
    return task;
  }

  private async load(refresh: boolean): Promise<CatalogResult> {
    const cache = await this.readCache();
    const now = this.clock();
    if (cache && !refresh && now - cache.meta.checkedAt < this.ttl)
      return this.result(cache, { fromCache: true, offline: false });
    try {
      return await this.revalidate(cache);
    } catch (error) {
      if (cache)
        return this.result(cache, { fromCache: true, offline: true, error: message(error) });
      throw new CatalogUnavailableError(message(error));
    }
  }

  private result(
    cache: CatalogCache,
    state: { fromCache: boolean; offline: boolean; error?: string },
  ): CatalogResult {
    return {
      catalog: cache.catalog,
      meta: {
        checkedAt: cache.meta.checkedAt,
        fetchedAt: cache.meta.fetchedAt,
        fromCache: state.fromCache,
        stale: this.clock() - cache.meta.checkedAt >= this.ttl,
        offline: state.offline,
        ...(state.error ? { error: state.error } : {}),
      },
    };
  }

  private async revalidate(cache: CatalogCache | undefined): Promise<CatalogResult> {
    const url = this.url;
    const target = safeUrl(url, 2048, true);
    if (!target) throw new Error("The plugin catalog URL must be https");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (cache?.meta.etag) headers["If-None-Match"] = cache.meta.etag;
    if (cache?.meta.lastModified) headers["If-Modified-Since"] = cache.meta.lastModified;
    const res = await this.fetcher(url, {
      headers,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? CATALOG_TIMEOUT_MS),
    });
    this.assertSameOrigin(res, target);
    const now = this.clock();
    if (res.status === 304 && cache) {
      await res.body?.cancel().catch(() => {});
      const next: CatalogCache = { ...cache, meta: { ...cache.meta, checkedAt: now } };
      await writeAtomic(
        this.cacheFile,
        JSON.stringify({ ...next, catalog: storable(next.catalog) }),
      ).catch(() => {});
      return this.result(next, { fromCache: true, offline: false });
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`The plugin catalog server answered HTTP ${res.status}`);
    }
    const raw = await readCapped(res, MAX_CATALOG_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new Error("The plugin catalog is not valid JSON");
    }
    const catalog = sanitizeCatalog(parsed, url);
    const etag = res.headers.get("etag") ?? undefined;
    const lastModified = res.headers.get("last-modified") ?? undefined;
    const next: CatalogCache = {
      url,
      meta: {
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
        fetchedAt: now,
        checkedAt: now,
      },
      catalog,
    };
    await writeAtomic(
      this.cacheFile,
      JSON.stringify({ ...next, catalog: storable(catalog) }),
    ).catch(() => {});
    return this.result(next, { fromCache: false, offline: false });
  }

  private assertSameOrigin(res: Response, expected: URL): void {
    if (!res.url) return;
    let final: URL;
    try {
      final = new URL(res.url);
    } catch {
      return;
    }
    if (!sameOrigin(final, expected))
      throw new Error("The plugin catalog redirected to another origin");
  }

  /** A plugin of the current catalog by slug (cache, revalidated only when stale). */
  async plugin(
    slug: string,
  ): Promise<{ plugin: CatalogPlugin; result: CatalogResult } | undefined> {
    const result = await this.get(false);
    const plugin = result.catalog.plugins.find((entry) => entry.slug === slug);
    return plugin ? { plugin, result } : undefined;
  }

  /**
   * The cover SVG of a catalog plugin. It is fetched from the sanitized catalog URL only and kept
   * on disk; it is revalidated (conditionally) only when the catalog content changed since it was
   * last checked, and an unreachable origin falls back to the copy on disk.
   */
  cover(plugin: CatalogPlugin, catalogFetchedAt: number): Promise<Cover | undefined> {
    const key = plugin.slug;
    const running = this.coverInflight.get(key);
    if (running) return running;
    const task = this.loadCover(plugin, catalogFetchedAt).finally(() =>
      this.coverInflight.delete(key),
    );
    this.coverInflight.set(key, task);
    return task;
  }

  private async loadCover(
    plugin: CatalogPlugin,
    catalogFetchedAt: number,
  ): Promise<Cover | undefined> {
    const metaFile = this.coverMetaFile(plugin.slug);
    interface CoverMeta {
      source?: string;
      /** The origin's validator, sent back as `If-None-Match`. */
      upstream?: string;
      checkedAt?: number;
      contentType?: string;
      ext?: string;
    }
    let meta: CoverMeta = {};
    let body: Buffer | undefined;
    try {
      meta = JSON.parse(await readFile(metaFile, "utf8")) as CoverMeta;
      if (meta.ext && COVER_TYPES.some((entry) => entry.ext === meta.ext))
        body = await readFile(this.coverFile(plugin.slug, meta.ext));
    } catch {
      /* no usable copy yet */
    }
    const source = plugin.coverSource;
    if (!source) return undefined;
    const usable = body !== undefined && meta.source === source && !!meta.contentType;
    const served = (data: Buffer, contentType: string, upstream?: string): Cover => ({
      body: data,
      etag: upstream ?? this.etagOf(data),
      contentType,
    });
    if (usable && body && meta.contentType && (meta.checkedAt ?? 0) >= catalogFetchedAt)
      return served(body, meta.contentType, meta.upstream);
    try {
      const headers: Record<string, string> = {};
      if (usable && meta.upstream) headers["If-None-Match"] = meta.upstream;
      const res = await this.fetcher(source, {
        headers,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? CATALOG_TIMEOUT_MS),
      });
      this.assertSameOrigin(res, new URL(this.url));
      const now = this.clock();
      if (res.status === 304 && usable && body && meta.contentType) {
        await res.body?.cancel().catch(() => {});
        await writeAtomic(metaFile, JSON.stringify({ ...meta, checkedAt: now })).catch(() => {});
        return served(body, meta.contentType, meta.upstream);
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${res.status}`);
      }
      const fresh = await readCapped(res, MAX_COVER_BYTES);
      const kind = sniffCover(fresh);
      if (!kind) throw new Error("The cover is not an SVG, WebP, PNG or JPEG image");
      const upstream = res.headers.get("etag") ?? undefined;
      await writeAtomic(this.coverFile(plugin.slug, kind.ext), fresh).catch(() => {});
      await writeAtomic(
        metaFile,
        JSON.stringify({ source, upstream, checkedAt: now, contentType: kind.type, ext: kind.ext }),
      ).catch(() => {});
      return served(fresh, kind.type, upstream);
    } catch {
      return usable && body && meta.contentType
        ? served(body, meta.contentType, meta.upstream)
        : undefined;
    }
  }

  private etagOf(body: Buffer): string {
    return `"sha1-${createHash("sha1").update(body).digest("hex")}"`;
  }
}
