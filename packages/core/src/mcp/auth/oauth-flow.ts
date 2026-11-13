/**
 * The sign-in flow of one MCP integration (specs/030 phase 4): discovery and PKCE through the SDK's
 * `auth()`, the redirect through the loopback listener of spec 025, tokens behind the `SecretStore`
 * port. One flow per integration at a time; flows live in memory, are bounded by a timeout and end
 * on cancel. Signing out removes the LOCAL tokens only: the service is not asked to revoke them
 * (remote revocation would be a separate, provider-specific call this release does not make).
 */
import { randomBytes } from "node:crypto";
import {
  type AuthResult,
  auth,
  IssuerMismatchError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/client";
import { LOOPBACK_MAX_MS, openLoopback } from "../../providers/oauth/loopback.ts";
import type { SecretStore } from "../installation/secrets.ts";
import { createUrlGuard, type UrlGuard, UrlRejectedError } from "../net-guard.ts";
import {
  type OAuthKey,
  oauthFetch,
  oauthSecretIds,
  resourceId,
  SignInRequiredError,
  StoredOAuthProvider,
} from "./oauth-provider.ts";

export type SignInState = "awaiting-browser" | "completing" | "completed" | "failed" | "cancelled";

export type SignInErrorCode =
  | "oauth_failed"
  | "access_denied"
  | "timeout"
  | "loopback_unavailable"
  | "unsafe_url";

export class McpOAuthError extends Error {
  constructor(
    readonly code: SignInErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "McpOAuthError";
  }
}

/** What the UI may know about a flow: never a token, a verifier or a code. */
export interface SignInView {
  id: string;
  state: SignInState;
  /** The address to open in the browser, while the flow waits for the user. */
  authorizationUrl?: string;
  error?: { code: SignInErrorCode; message: string };
}

export interface McpOAuthOptions {
  store: SecretStore;
  /** Applied to every authorization-server origin that is not the resource's own (default: public https only). */
  guard?: UrlGuard;
  /** Longest wait for the user (default 10 minutes, at most the loopback maximum). */
  timeoutMs?: number;
  /** Test seam for the loopback listener. */
  loopback?: typeof openLoopback;
}

/** What a connection needs to use a saved sign-in. */
export interface McpOAuthConnection {
  authProvider: OAuthClientProvider;
  fetch: typeof fetch;
}

/** The slice of the service the connector depends on. */
export interface McpOAuthPort {
  forConnection(key: OAuthKey, serverUrl: string): Promise<McpOAuthConnection | undefined>;
}

interface Flow {
  id: string;
  key: OAuthKey;
  view: SignInView;
  close(): void;
  done: Promise<SignInView>;
}

const SAFE_FAILURE: Record<string, string> = {
  issuer: "The sign-in response came from an unexpected server, so it was refused",
  address: "The sign-in server address is not allowed",
  generic:
    "The sign-in could not be completed. The service may not offer sign-in, or it answered with something unexpected",
};

function describe(error: unknown): McpOAuthError {
  if (error instanceof McpOAuthError) return error;
  if (error instanceof IssuerMismatchError)
    return new McpOAuthError("oauth_failed", SAFE_FAILURE.issuer as string);
  if (error instanceof UrlRejectedError)
    return new McpOAuthError("oauth_failed", SAFE_FAILURE.address as string);
  return new McpOAuthError("oauth_failed", SAFE_FAILURE.generic as string);
}

/** The authorization address the user is sent to: https, or http on this machine, no credentials. */
function checkAuthorizationUrl(url: URL): void {
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password
  )
    throw new McpOAuthError("unsafe_url", "The sign-in address is not safe to open");
}

export class McpOAuth implements McpOAuthPort {
  private flows = new Map<string, Flow>();
  private guard: UrlGuard;
  constructor(private options: McpOAuthOptions) {
    this.guard = options.guard ?? createUrlGuard();
  }

  private provider(
    key: OAuthKey,
    serverUrl: string,
    extra: { redirectUrl?: string; state?: string; onAuthorizationUrl?: (url: URL) => void } = {},
  ) {
    return new StoredOAuthProvider({ store: this.options.store, key, serverUrl, ...extra });
  }

  /** Whether usable tokens are saved for this integration and this very resource. */
  async hasTokens(key: OAuthKey, serverUrl: string): Promise<boolean> {
    return (await this.provider(key, serverUrl).tokens()) !== undefined;
  }

  /** The provider and fetch for connecting; `undefined` when nothing is saved for this resource. */
  async forConnection(key: OAuthKey, serverUrl: string): Promise<McpOAuthConnection | undefined> {
    const provider = this.provider(key, serverUrl);
    if (!(await provider.tokens())) return undefined;
    return { authProvider: provider, fetch: oauthFetch(serverUrl, this.guard) };
  }

  /** Starts a sign-in and resolves once the address to open is known (or it is already signed in). */
  async start(input: {
    key: OAuthKey;
    serverUrl: string;
    signal?: AbortSignal;
  }): Promise<SignInView> {
    const serverUrl = new URL(input.serverUrl);
    if (serverUrl.protocol !== "https:" && serverUrl.protocol !== "http:")
      throw new McpOAuthError("oauth_failed", SAFE_FAILURE.generic as string);
    for (const flow of this.flows.values())
      if (sameKey(flow.key, input.key) && !isFinal(flow.view.state)) flow.close();
    const state = randomBytes(24).toString("base64url");
    const open = this.options.loopback ?? openLoopback;
    let loopback: Awaited<ReturnType<typeof openLoopback>>;
    try {
      loopback = await open({
        port: 0,
        path: "/mcp/oauth/callback",
        state,
        timeoutMs: Math.min(this.options.timeoutMs ?? 600_000, LOOPBACK_MAX_MS),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch {
      throw new McpOAuthError("loopback_unavailable", "A local sign-in page could not be opened");
    }
    let authorizationUrl: URL | undefined;
    const provider = this.provider(input.key, input.serverUrl, {
      redirectUrl: loopback.redirectUri,
      state,
      onAuthorizationUrl: (url) => {
        checkAuthorizationUrl(url);
        authorizationUrl = url;
      },
    });
    const fetchFn = oauthFetch(serverUrl, this.guard);
    let result: AuthResult;
    try {
      result = await auth(provider, { serverUrl, fetchFn });
    } catch (error) {
      loopback.close();
      await provider.invalidateCredentials("verifier").catch(() => {});
      throw describe(error);
    }
    if (result === "AUTHORIZED" || !authorizationUrl) {
      loopback.close();
      const id = crypto.randomUUID();
      const view: SignInView = { id, state: "completed" };
      this.flows.set(id, { id, key: input.key, view, close() {}, done: Promise.resolve(view) });
      return { ...view };
    }
    const id = crypto.randomUUID();
    const view: SignInView = {
      id,
      state: "awaiting-browser",
      authorizationUrl: authorizationUrl.href,
    };
    const flow: Flow = {
      id,
      key: input.key,
      view,
      close: () => {
        if (isFinal(view.state)) return;
        view.state = "cancelled";
        delete view.authorizationUrl;
        loopback.close();
      },
      done: Promise.resolve(view),
    };
    flow.done = this.complete({ flow, loopback, provider, serverUrl, fetchFn });
    this.flows.set(id, flow);
    return { ...view };
  }

  private async complete(input: {
    flow: Flow;
    loopback: Awaited<ReturnType<typeof openLoopback>>;
    provider: StoredOAuthProvider;
    serverUrl: URL;
    fetchFn: typeof fetch;
  }): Promise<SignInView> {
    const { flow, loopback, provider } = input;
    const fail = async (error: McpOAuthError) => {
      if (flow.view.state !== "cancelled") {
        flow.view.state = "failed";
        flow.view.error = { code: error.code, message: error.message };
      }
      delete flow.view.authorizationUrl;
      await provider.invalidateCredentials("verifier").catch(() => {});
      return flow.view;
    };
    let params: Record<string, string>;
    try {
      params = await loopback.wait();
    } catch (error) {
      if (flow.view.state === "cancelled") {
        await provider.invalidateCredentials("verifier").catch(() => {});
        return flow.view;
      }
      const timeout = (error as { code?: string }).code === "loopback_timeout";
      return fail(
        new McpOAuthError(
          timeout ? "timeout" : "oauth_failed",
          timeout ? "The sign-in took too long and was closed" : (SAFE_FAILURE.generic as string),
        ),
      );
    }
    if (params.error)
      return fail(
        new McpOAuthError(
          params.error === "access_denied" ? "access_denied" : "oauth_failed",
          params.error === "access_denied"
            ? "The sign-in was cancelled in the browser"
            : (SAFE_FAILURE.generic as string),
        ),
      );
    if (!params.code)
      return fail(new McpOAuthError("oauth_failed", SAFE_FAILURE.generic as string));
    flow.view.state = "completing";
    delete flow.view.authorizationUrl;
    try {
      await auth(provider, {
        serverUrl: input.serverUrl,
        authorizationCode: params.code,
        ...(params.iss !== undefined ? { iss: params.iss } : {}),
        fetchFn: input.fetchFn,
      });
    } catch (error) {
      return fail(describe(error));
    }
    await provider.invalidateCredentials("verifier").catch(() => {});
    flow.view.state = "completed";
    return flow.view;
  }

  flow(id: string): SignInView | undefined {
    const flow = this.flows.get(id);
    return flow ? { ...flow.view } : undefined;
  }

  async wait(id: string): Promise<SignInView> {
    const flow = this.flows.get(id);
    if (!flow) throw new Error("Unknown sign-in");
    return { ...(await flow.done) };
  }

  cancel(id: string): SignInView | undefined {
    const flow = this.flows.get(id);
    if (!flow) return undefined;
    flow.close();
    return { ...flow.view };
  }

  /** Removes this integration's LOCAL sign-in. The service is not asked to revoke anything. */
  async forget(key: OAuthKey): Promise<void> {
    for (const flow of this.flows.values()) if (sameKey(flow.key, key)) flow.close();
    await this.options.store.deleteMany(oauthSecretIds(key));
  }

  /** Ends every flow that is still waiting (the server is stopping). */
  async close(): Promise<void> {
    for (const flow of this.flows.values()) flow.close();
    await Promise.all([...this.flows.values()].map((flow) => flow.done.catch(() => {})));
  }
}

const isFinal = (state: SignInState) =>
  state === "completed" || state === "failed" || state === "cancelled";
const sameKey = (a: OAuthKey, b: OAuthKey) =>
  a.scope === b.scope && a.alias === b.alias && (a.workspacePath ?? "") === (b.workspacePath ?? "");

export { oauthSecretIds, resourceId, SignInRequiredError };
