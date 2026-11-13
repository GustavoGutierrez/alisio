/**
 * OAuth for Streamable HTTP MCP servers (specs/030 §4, D9): a persistent `OAuthClientProvider` for
 * the SDK's maintained utilities (RFC 9728/8414 discovery, PKCE, RFC 8707 resource indicator,
 * RFC 9207 issuer check, refresh). Everything the flow must remember (tokens, the registered
 * client, the PKCE verifier, the discovery result) lives behind the `SecretStore` port, under ids
 * derived from the integration (scope, workspace, alias): never in a configuration file, a wire DTO,
 * a log or an error. A stdio server never goes through here.
 */
import { createHash, randomBytes } from "node:crypto";
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { SecretStore } from "../installation/secrets.ts";
import { type UrlGuard, UrlRejectedError } from "../net-guard.ts";

/** The integration a sign-in belongs to: one per scope + workspace + alias. */
export interface OAuthKey {
  scope: "global" | "project";
  /** Canonical workspace path of a project integration. */
  workspacePath?: string;
  alias: string;
}

const PARTS = ["tokens", "client", "verifier", "discovery"] as const;
type Part = (typeof PARTS)[number];

const base = (key: OAuthKey): string =>
  `mcp-oauth:${
    key.scope === "project"
      ? createHash("sha256")
          .update(key.workspacePath ?? "")
          .digest("hex")
          .slice(0, 16)
      : "global"
  }:${key.alias}`;

/** Every secret id of one integration's sign-in (so an uninstall can remove them all). */
export const oauthSecretIds = (key: OAuthKey): string[] =>
  PARTS.map((part) => `${base(key)}:${part}`);

/** Signed-in marker of the stored tokens: which resource they were granted for. */
interface TokenEnvelope {
  resource: string;
  tokens: StoredOAuthTokens;
}

/** `href` without a fragment: the identity of the protected resource a token is bound to. */
export const resourceId = (serverUrl: string | URL): string => {
  const url = new URL(serverUrl);
  url.hash = "";
  return url.href;
};

/** The service wants the user to sign in again (no usable token, refresh failed). */
export class SignInRequiredError extends Error {
  constructor() {
    super("Sign in to continue");
    this.name = "SignInRequiredError";
  }
}

const CONNECTION_PLACEHOLDER = "http://127.0.0.1/mcp/oauth/callback";

export interface OAuthProviderOptions {
  store: SecretStore;
  key: OAuthKey;
  serverUrl: string | URL;
  /** Present while the user signs in: the loopback address the authorization server redirects to. */
  redirectUrl?: string;
  /** The `state` the loopback listener checks (sign-in only). */
  state?: string;
  /** Sign-in only: receives the authorization address the user must open. */
  onAuthorizationUrl?: (url: URL) => void;
}

export class StoredOAuthProvider implements OAuthClientProvider {
  constructor(private options: OAuthProviderOptions) {}

  private id(part: Part): string {
    return `${base(this.options.key)}:${part}`;
  }
  private async read<T>(part: Part): Promise<T | undefined> {
    const raw = await this.options.store.get(this.id(part));
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }
  private write(part: Part, value: unknown): Promise<void> {
    return this.options.store.set(this.id(part), JSON.stringify(value));
  }

  /**
   * The SDK treats a provider without a redirect address as a non-interactive (client-credentials)
   * flow, which would skip the refresh path. While only connecting, a fixed loopback placeholder
   * stands in: it is never opened (`redirectToAuthorization` refuses outside a sign-in).
   */
  get redirectUrl(): string {
    return this.options.redirectUrl ?? CONNECTION_PLACEHOLDER;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Alisio",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.options.state ?? randomBytes(24).toString("base64url");
  }

  async clientInformation(
    context?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    const saved = await this.read<{ issuer?: string; info: StoredOAuthClientInformation }>(
      "client",
    );
    if (!saved) return undefined;
    // A client registered with one authorization server is never offered to another.
    if (saved.issuer && context?.issuer && saved.issuer !== context.issuer) return undefined;
    return saved.info;
  }

  async saveClientInformation(
    info: StoredOAuthClientInformation,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    await this.write("client", { ...(context?.issuer ? { issuer: context.issuer } : {}), info });
  }

  /** Tokens are returned only for the resource they were granted for. */
  async tokens(): Promise<StoredOAuthTokens | undefined> {
    const saved = await this.read<TokenEnvelope>("tokens");
    if (!saved || saved.resource !== resourceId(this.options.serverUrl)) return undefined;
    return saved.tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    const envelope: TokenEnvelope = { resource: resourceId(this.options.serverUrl), tokens };
    await this.write("tokens", envelope);
  }

  redirectToAuthorization(url: URL): void {
    if (!this.options.onAuthorizationUrl) throw new SignInRequiredError();
    this.options.onAuthorizationUrl(url);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.options.store.set(this.id("verifier"), verifier);
  }

  async codeVerifier(): Promise<string> {
    const verifier = await this.options.store.get(this.id("verifier"));
    if (!verifier) throw new Error("No sign-in is in progress");
    return verifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.write("discovery", state);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.read<OAuthDiscoveryState>("discovery");
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const parts: Part[] = scope === "all" ? [...PARTS] : [scope];
    await this.options.store.deleteMany(parts.map((part) => this.id(part)));
  }
}

/** Largest body read from an authorization server (metadata, registration, token). */
export const AUTH_RESPONSE_LIMIT = 1_048_576;

/** Reads a body up to `limit` bytes; a longer one is an error (never buffered whole). */
async function readCapped(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(new ArrayBuffer(0));
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error("The sign-in server answered with too much data");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * The `fetch` of an OAuth-capable connection. The MCP resource's own origin is contacted as is
 * (a manually added or intranet service stays possible); every OTHER origin (the authorization
 * server a service points to) must pass the SSRF guard (D20). Redirects are never followed, so a
 * token or a request cannot be bounced to a third party, and bodies from other origins are capped.
 */
export function oauthFetch(resourceUrl: string | URL, guard: UrlGuard): typeof fetch {
  const origin = new URL(resourceUrl).origin;
  return async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : (input as Request).url,
    );
    const foreign = url.origin !== origin;
    if (foreign) await guard.check(url);
    const response = await fetch(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new Error("The service redirected the request; redirects are not followed");
    }
    if (!foreign) return response;
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > AUTH_RESPONSE_LIMIT) {
      await response.body?.cancel().catch(() => {});
      throw new Error("The sign-in server answered with too much data");
    }
    const bytes = await readCapped(response, AUTH_RESPONSE_LIMIT);
    return new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

export { UrlRejectedError };
