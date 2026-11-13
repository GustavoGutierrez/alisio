/**
 * The catalog source port (specs/030 D14, O7) and Alisio's own domain model. Every provider of MCP
 * server metadata (today the official registry) is wrapped by an adapter that implements
 * `CatalogSource` and maps the provider's wire format onto `CatalogEntry`. No provider type crosses
 * this boundary: the store, the sync, the HTTP routes and the web UI only know this module.
 */

export type CatalogStatus = "active" | "deprecated" | "deleted";
export type CatalogTransport = "stdio" | "streamable-http" | "sse" | "unknown";

/** A parameter an entry asks the user for (an environment variable, a header or a URL variable). */
export interface CatalogInput {
  name: string;
  kind: "env" | "header" | "variable";
  description?: string;
  isRequired: boolean;
  isSecret: boolean;
  format?: string;
  choices?: string[];
  default?: string;
  /** A fixed value the provider supplies (never shown for secrets). */
  value?: string;
}

/** A command-line argument of a package (structured: never concatenated into a shell string). */
export interface CatalogArgument {
  type: "positional" | "named";
  name?: string;
  value?: string;
  isRequired: boolean;
  description?: string;
}

/** A package that runs on this machine (`method` is the provider's package type: npm, pypi...). */
export interface CatalogPackage {
  method: string;
  identifier: string;
  /** Exact version; absent when the provider did not pin one. */
  version?: string;
  registryBaseUrl?: string;
  runtimeHint?: string;
  transport: CatalogTransport;
  inputs: CatalogInput[];
  args: CatalogArgument[];
}

/** A service that runs elsewhere and is reached over the network. */
export interface CatalogRemote {
  transport: CatalogTransport;
  url: string;
  inputs: CatalogInput[];
}

export interface CatalogProvenance {
  sourceId: string;
  /** The provider's schema revision the record was written against. */
  schemaVersion: string;
  /** sha256 of the original record, so a re-sync can tell whether anything changed. */
  rawDigest: string;
  /** The original record as received (untrusted data, kept for traceability; no secrets). */
  rawJson: string;
}

export interface CatalogEntry {
  sourceId: string;
  /** The provider's identity of the server; may contain `/` (it is not the internal alias). */
  name: string;
  title?: string;
  description: string;
  version: string;
  status: CatalogStatus;
  isLatest: boolean;
  publishedAt?: string;
  updatedAt?: string;
  websiteUrl?: string;
  repositoryUrl?: string;
  packages: CatalogPackage[];
  remotes: CatalogRemote[];
  /** Free-form hints the publisher attached; a weak signal for categories, never authoritative. */
  publisherHints?: { categories: string[]; keywords: string[] };
  provenance: CatalogProvenance;
}

export type RejectedReason = "schema_unsupported" | "invalid" | "too_large";

/** A record the adapter refused. It is kept visible and is never installable. */
export interface RejectedEntry {
  name?: string;
  version?: string;
  reason: RejectedReason;
  schemaVersion?: string;
  detail?: string;
}

export interface CatalogCapabilities {
  supportsIncremental: boolean;
  supportsSearch: boolean;
  supportsCategories: boolean;
  /** Schema revisions the adapter understands; others are rejected as `schema_unsupported`. */
  schemaVersions: readonly string[];
}

export interface ListPageRequest {
  cursor?: string;
  /** Only records changed since this instant (RFC 3339), including deleted and deprecated ones. */
  updatedSince?: string;
  limit: number;
  signal?: AbortSignal;
}

export interface CatalogSourcePage {
  entries: CatalogEntry[];
  rejected: RejectedEntry[];
  nextCursor?: string;
}

export interface CatalogSource {
  readonly sourceId: string;
  readonly capabilities: CatalogCapabilities;
  /** One page of the walk. The caller repeats the same filters with each `nextCursor`. */
  listPage(request: ListPageRequest): Promise<CatalogSourcePage>;
  /** One version of one server (`undefined` version = the provider's latest); not found = undefined. */
  get(name: string, version?: string, signal?: AbortSignal): Promise<CatalogEntry | undefined>;
}

export type CatalogSourceErrorCode =
  | "network"
  | "timeout"
  | "http"
  | "too_large"
  | "bad_response"
  | "aborted"
  | "invalid_config"
  | "unknown_source";

/** A failure of a source, with a stable code the UI can map to a recovery action. */
export class CatalogSourceError extends Error {
  constructor(
    readonly code: CatalogSourceErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CatalogSourceError";
  }
}

/** The page size ceiling every adapter honors. */
export const MAX_PAGE_LIMIT = 100;
