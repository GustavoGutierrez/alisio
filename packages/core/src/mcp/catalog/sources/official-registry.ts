/**
 * Anti-corruption adapter for the official MCP registry (`registry.modelcontextprotocol.io`,
 * API `/v0.1`). It is the only module that knows the registry's wire format: it understands the
 * `server.json` schema revisions 2025-07-09, 2025-09-29 and 2025-12-11, flags any other revision
 * as `schema_unsupported`, enforces the response and record budgets (CAT-02) and the request
 * policy (CAT-01: 15 s timeout, two retries with backoff, `Retry-After`), and maps everything
 * onto Alisio's domain model. Registry text is untrusted data.
 */
import { createHash } from "node:crypto";
import {
  type CatalogArgument,
  type CatalogEntry,
  type CatalogInput,
  type CatalogPackage,
  type CatalogRemote,
  type CatalogSource,
  CatalogSourceError,
  type CatalogSourcePage,
  type CatalogStatus,
  type CatalogTransport,
  type ListPageRequest,
  MAX_PAGE_LIMIT,
  type RejectedEntry,
} from "../source.ts";

export const OFFICIAL_SOURCE_ID = "official";
export const OFFICIAL_BASE_URL = "https://registry.modelcontextprotocol.io";
const SCHEMA_VERSIONS = ["2025-07-09", "2025-09-29", "2025-12-11"] as const;
const META_OFFICIAL = "io.modelcontextprotocol.registry/official";
const META_PUBLISHER = "io.modelcontextprotocol.registry/publisher-provided";

/** CAT-02 budgets. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_RETRY_AFTER_MS = 60_000;

export interface OfficialRegistryOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Waits between retries; injected by tests. Must reject or return early on abort. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  requestTimeoutMs?: number;
  maxRetries?: number;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Validates a configured base URL: HTTPS (loopback may use http for local mirrors), no credentials. */
function normalizeBase(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CatalogSourceError("invalid_config", "The catalog base URL is not a valid URL");
  }
  if (url.username || url.password)
    throw new CatalogSourceError(
      "invalid_config",
      "The catalog base URL must not carry credentials",
    );
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname)))
    throw new CatalogSourceError("invalid_config", "The catalog base URL must use https");
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
/** First defined value among the camelCase and the legacy snake_case spelling of a field. */
const pick = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) if (o[key] !== undefined) return o[key];
  return undefined;
};
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50) : [];

const TRANSPORTS: Record<string, CatalogTransport> = {
  stdio: "stdio",
  "streamable-http": "streamable-http",
  streamable_http: "streamable-http",
  sse: "sse",
};
const transportOf = (v: unknown): CatalogTransport => {
  const type = str(obj(v)?.type) ?? str(v);
  return (type && TRANSPORTS[type]) || "unknown";
};

function inputOf(
  raw: unknown,
  kind: CatalogInput["kind"],
  nameKey = "name",
): CatalogInput | undefined {
  const o = obj(raw);
  const name = o && str(o[nameKey]);
  if (!o || !name) return undefined;
  const secret = bool(pick(o, "isSecret", "is_secret")) ?? false;
  const choices = strings(o.choices);
  const value = str(o.value);
  const dflt = str(o.default);
  return {
    name,
    kind,
    ...(str(o.description) ? { description: str(o.description) as string } : {}),
    isRequired: bool(pick(o, "isRequired", "is_required")) ?? false,
    isSecret: secret,
    ...(str(o.format) ? { format: str(o.format) as string } : {}),
    ...(choices.length ? { choices } : {}),
    // Secret defaults and fixed values are never kept: the user supplies them.
    ...(dflt !== undefined && !secret ? { default: dflt } : {}),
    ...(value !== undefined && !secret ? { value } : {}),
  };
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, 200) : []);

function packageOf(raw: unknown): CatalogPackage | undefined {
  const o = obj(raw);
  if (!o) return undefined;
  const method = str(pick(o, "registryType", "registry_type", "registry_name"));
  const identifier = str(o.identifier) ?? str(o.name);
  if (!method || !identifier) return undefined;
  const args: CatalogArgument[] = [];
  for (const a of list(pick(o, "packageArguments", "package_arguments"))) {
    const ao = obj(a);
    if (!ao) continue;
    const type = str(ao.type) === "named" ? "named" : "positional";
    args.push({
      type,
      ...(str(ao.name) ? { name: str(ao.name) as string } : {}),
      ...(str(ao.value) ? { value: str(ao.value) as string } : {}),
      isRequired: bool(pick(ao, "isRequired", "is_required")) ?? false,
      ...(str(ao.description) ? { description: str(ao.description) as string } : {}),
    });
  }
  const inputs = list(pick(o, "environmentVariables", "environment_variables"))
    .map((e) => inputOf(e, "env"))
    .filter((e): e is CatalogInput => !!e);
  return {
    method,
    identifier,
    ...(str(o.version) ? { version: str(o.version) as string } : {}),
    ...(str(pick(o, "registryBaseUrl", "registry_base_url"))
      ? { registryBaseUrl: str(pick(o, "registryBaseUrl", "registry_base_url")) as string }
      : {}),
    ...(str(pick(o, "runtimeHint", "runtime_hint"))
      ? { runtimeHint: str(pick(o, "runtimeHint", "runtime_hint")) as string }
      : {}),
    transport: transportOf(o.transport),
    inputs,
    args,
  };
}

function remoteOf(raw: unknown): CatalogRemote | undefined {
  const o = obj(raw);
  const url = o && str(o.url);
  if (!o || !url) return undefined;
  const inputs: CatalogInput[] = [];
  for (const h of list(o.headers)) {
    const input = inputOf(h, "header");
    if (input) inputs.push(input);
  }
  const variables = obj(o.variables);
  if (variables)
    for (const [name, v] of Object.entries(variables).slice(0, 50)) {
      const input = inputOf({ ...(obj(v) ?? {}), name }, "variable");
      if (input) inputs.push(input);
    }
  return { transport: transportOf(o.type ?? o.transport), url, inputs };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const STATUSES = new Set<CatalogStatus>(["active", "deprecated", "deleted"]);

type Mapped = { ok: true; entry: CatalogEntry } | { ok: false; rejected: RejectedEntry };

function mapRecord(sourceId: string, raw: unknown): Mapped {
  const wrapper = obj(raw);
  const server = obj(wrapper?.server);
  const name = str(server?.name);
  const version = str(server?.version);
  const base = { ...(name ? { name } : {}), ...(version ? { version } : {}) };
  if (!wrapper || !server || !name || !version || name.length > 300 || version.length > 128)
    return {
      ok: false,
      rejected: { ...base, reason: "invalid", detail: "missing name or version" },
    };
  const rawJson = JSON.stringify(raw);
  if (Buffer.byteLength(rawJson) > MAX_RECORD_BYTES)
    return {
      ok: false,
      rejected: { ...base, reason: "too_large", detail: "record exceeds 128 KiB" },
    };
  const schemaUrl = str(server.$schema);
  const schemaVersion = schemaUrl
    ? /\/schemas\/(\d{4}-\d{2}-\d{2})\//.exec(schemaUrl)?.[1]
    : undefined;
  if (!schemaVersion || !(SCHEMA_VERSIONS as readonly string[]).includes(schemaVersion))
    return {
      ok: false,
      rejected: {
        ...base,
        reason: "schema_unsupported",
        ...(schemaVersion ? { schemaVersion } : {}),
        detail: "unsupported server.json schema revision",
      },
    };
  const meta = obj(wrapper._meta);
  const official = obj(meta?.[META_OFFICIAL]) ?? {};
  const rawStatus = str(official.status) ?? str(server.status) ?? "active";
  const status: CatalogStatus = STATUSES.has(rawStatus as CatalogStatus)
    ? (rawStatus as CatalogStatus)
    : "active";
  const hints = obj(meta?.[META_PUBLISHER]);
  const hintCategories = strings(hints?.categories);
  const hintKeywords = strings(hints?.keywords);
  const repository = obj(server.repository);
  const packages = list(server.packages)
    .map(packageOf)
    .filter((p): p is CatalogPackage => !!p);
  const remotes = list(server.remotes)
    .map(remoteOf)
    .filter((r): r is CatalogRemote => !!r);
  const entry: CatalogEntry = {
    sourceId,
    name,
    ...(str(server.title) ? { title: str(server.title) as string } : {}),
    description: (str(server.description) ?? "").slice(0, 4000),
    version,
    status,
    isLatest: bool(official.isLatest) ?? false,
    ...(str(official.publishedAt) ? { publishedAt: str(official.publishedAt) as string } : {}),
    ...(str(official.updatedAt) ? { updatedAt: str(official.updatedAt) as string } : {}),
    ...(str(server.websiteUrl) ? { websiteUrl: str(server.websiteUrl) as string } : {}),
    ...(str(repository?.url) ? { repositoryUrl: str(repository?.url) as string } : {}),
    packages,
    remotes,
    ...(hintCategories.length || hintKeywords.length
      ? { publisherHints: { categories: hintCategories, keywords: hintKeywords } }
      : {}),
    provenance: { sourceId, schemaVersion, rawDigest: sha(rawJson), rawJson },
  };
  return { ok: true, entry };
}

export class OfficialRegistrySource implements CatalogSource {
  readonly sourceId: string;
  readonly capabilities = {
    supportsIncremental: true,
    supportsSearch: true,
    supportsCategories: false,
    schemaVersions: SCHEMA_VERSIONS,
  } as const;
  /** Origin plus path prefix, without a trailing slash. */
  private readonly root: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(options: OfficialRegistryOptions = {}) {
    const base = normalizeBase(options.baseUrl ?? OFFICIAL_BASE_URL);
    this.root = `${base.origin}${base.pathname === "/" ? "" : base.pathname}`;
    this.sourceId =
      this.root === OFFICIAL_BASE_URL ? OFFICIAL_SOURCE_ID : `${OFFICIAL_SOURCE_ID}:${this.root}`;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.timeoutMs = options.requestTimeoutMs ?? 15_000;
    this.retries = options.maxRetries ?? 2;
  }

  async listPage(request: ListPageRequest): Promise<CatalogSourcePage> {
    const params = new URLSearchParams();
    params.set("limit", String(Math.max(1, Math.min(request.limit, MAX_PAGE_LIMIT))));
    // A full walk needs the latest versions only; an incremental walk needs every change (also
    // deleted and deprecated versions), which `updated_since` returns without a version filter.
    if (request.updatedSince) params.set("updated_since", request.updatedSince);
    else params.set("version", "latest");
    if (request.cursor) params.set("cursor", request.cursor);
    const body = obj(await this.getJson(`/v0.1/servers?${params.toString()}`, request.signal));
    const servers = body?.servers;
    if (!Array.isArray(servers))
      throw new CatalogSourceError(
        "bad_response",
        "The registry answered with an unexpected shape",
      );
    const entries: CatalogEntry[] = [];
    const rejected: RejectedEntry[] = [];
    for (const item of servers.slice(0, MAX_PAGE_LIMIT)) {
      const mapped = mapRecord(this.sourceId, item);
      if (mapped.ok) entries.push(mapped.entry);
      else rejected.push(mapped.rejected);
    }
    const next = str(obj(body?.metadata)?.nextCursor);
    return { entries, rejected, ...(next ? { nextCursor: next } : {}) };
  }

  async get(
    name: string,
    version?: string,
    signal?: AbortSignal,
  ): Promise<CatalogEntry | undefined> {
    const path = `/v0.1/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version ?? "latest")}`;
    let body: unknown;
    try {
      body = await this.getJson(path, signal);
    } catch (error) {
      if (error instanceof CatalogSourceError && error.status === 404) return undefined;
      throw error;
    }
    const mapped = mapRecord(this.sourceId, body);
    return mapped.ok ? mapped.entry : undefined;
  }

  /** One GET with the CAT-01 policy: timeout, retries with backoff, byte budget, no redirects. */
  private async getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    const url = `${this.root}${path}`;
    let lastError: CatalogSourceError | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (signal?.aborted)
        throw new CatalogSourceError("aborted", "The catalog request was cancelled");
      let retryAfter: number | undefined;
      try {
        return await this.once(url, signal);
      } catch (error) {
        if (!(error instanceof CatalogSourceError)) throw error;
        lastError = error;
        const transient =
          error.code === "network" ||
          error.code === "timeout" ||
          (error.code === "http" && [429, 502, 503, 504].includes(error.status ?? 0));
        if (!transient || attempt === this.retries) throw error;
        retryAfter = (error as RetryAfterError).retryAfterMs;
      }
      await this.sleep(retryAfter ?? 500 * 2 ** attempt, signal);
    }
    throw lastError ?? new CatalogSourceError("network", "The catalog could not be reached");
  }

  private async once(url: string, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: combined,
      });
    } catch {
      if (signal?.aborted)
        throw new CatalogSourceError("aborted", "The catalog request was cancelled");
      if (timeout.aborted)
        throw new CatalogSourceError("timeout", "The catalog did not answer in time");
      throw new CatalogSourceError("network", "The catalog could not be reached");
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => {});
      const error: RetryAfterError = new CatalogSourceError(
        "http",
        `The catalog answered with HTTP ${response.status}`,
        response.status,
      );
      const wait = parseRetryAfter(response.headers.get("retry-after"));
      if (wait !== undefined) error.retryAfterMs = wait;
      throw error;
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new CatalogSourceError("too_large", "The catalog response is too large");
    }
    const text = await readCapped(response, combined);
    try {
      return JSON.parse(text);
    } catch {
      throw new CatalogSourceError(
        "bad_response",
        "The catalog answered with something that is not JSON",
      );
    }
  }
}

type RetryAfterError = CatalogSourceError & { retryAfterMs?: number };

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.min(ms, MAX_RETRY_AFTER_MS)) : undefined;
}

async function readCapped(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted)
        throw new CatalogSourceError("timeout", "The catalog did not answer in time");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new CatalogSourceError("too_large", "The catalog response is too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CatalogSourceError) throw error;
    throw new CatalogSourceError(
      signal.aborted ? "timeout" : "network",
      "The catalog response was interrupted",
    );
  }
  return Buffer.concat(chunks).toString("utf8");
}
