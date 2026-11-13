/**
 * MCP-CAT-11 (specs/030 phase 4): OAuth for Streamable HTTP servers, with the SDK's maintained
 * utilities (discovery, PKCE, issuer and resource checks, refresh) and the loopback helper of
 * spec 025. A real local authorization server and protected resource (`fixtures/oauth-server.ts`),
 * no network. Tokens live only behind the `SecretStore` port.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeOAuth, type FakeOAuthOptions, startFakeOAuth } from "../fixtures/oauth-server.ts";
import { configSchema } from "../packages/core/src/config.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { McpOAuth, type OAuthKey, oauthSecretIds } from "../packages/core/src/mcp/auth/index.ts";
import { McpConnector } from "../packages/core/src/mcp/connector.ts";
import { MemorySecretStore } from "../packages/core/src/mcp/installation/secrets.ts";
import { createUrlGuard, permissiveUrlGuard } from "../packages/core/src/mcp/net-guard.ts";

const servers: FakeOAuth[] = [];
const oauths: McpOAuth[] = [];
const connectors: McpConnector[] = [];
afterEach(async () => {
  for (const connector of connectors.splice(0)) await connector.close();
  for (const oauth of oauths.splice(0)) await oauth.close();
  for (const server of servers.splice(0)) await server.close();
  vi.unstubAllEnvs();
});

const KEY: OAuthKey = { scope: "global", alias: "cloud" };

async function boot(options: FakeOAuthOptions = {}) {
  const fake = await startFakeOAuth(options);
  servers.push(fake);
  const store = new MemorySecretStore();
  const oauth = new McpOAuth({ store, guard: permissiveUrlGuard });
  oauths.push(oauth);
  return { fake, store, oauth };
}

/** What the user's browser does: open the authorization URL, follow the redirect to the loopback. */
async function browse(url: string): Promise<Response> {
  const first = await fetch(url, { redirect: "manual" });
  const location = first.headers.get("location");
  if (!location) return first;
  return fetch(location, { redirect: "manual" });
}

function connectorFor(
  url: string,
  oauth: McpOAuth | undefined,
  key: OAuthKey = KEY,
  alias = KEY.alias,
) {
  const config = configSchema.parse({ mcp: { servers: { [alias]: { transport: "http", url } } } });
  const connector = new McpConnector(
    config.mcp.servers,
    new ToolRegistry(),
    "/work/space",
    "allowed",
    { [alias]: { kind: key.scope, file: "/x", form: "canonical" } },
    undefined,
    oauth,
  );
  connectors.push(connector);
  return connector;
}

async function signIn(oauth: McpOAuth, url: string, key: OAuthKey = KEY) {
  const flow = await oauth.start({ key, serverUrl: url });
  expect(flow.state).toBe("awaiting-browser");
  await browse(flow.authorizationUrl as string);
  return oauth.wait(flow.id);
}

describe("MCP-CAT-11: authorization with discovery, PKCE and refresh", () => {
  it("discovers the metadata, uses PKCE and the resource indicator, saves tokens only behind the store and connects", async () => {
    const { fake, store, oauth } = await boot();
    const flow = await oauth.start({ key: KEY, serverUrl: fake.resourceUrl });
    const url = new URL(flow.authorizationUrl as string);
    expect(url.origin).toBe(fake.issuer);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("resource")).toBe(fake.resourceUrl);
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    // The authorization address carries no secret of Alisio's: nothing is saved before consent.
    expect(await oauth.hasTokens(KEY, fake.resourceUrl)).toBe(false);

    await browse(flow.authorizationUrl as string);
    expect((await oauth.wait(flow.id)).state).toBe("completed");
    expect(fake.grants.code).toBe(1);
    expect(await oauth.hasTokens(KEY, fake.resourceUrl)).toBe(true);

    const connector = connectorFor(fake.resourceUrl, oauth);
    await connector.connect("cloud", AbortSignal.timeout(15_000));
    expect(connector.info("cloud")).toMatchObject({ status: "connected" });
    expect(connector.info("cloud").counts.tools).toBeGreaterThan(0);
    const last = fake.mcpAuthorizations().at(-1);
    expect(last).toMatch(/^Bearer at-/);
    // Wire/lists never carry a token.
    const accessToken = String(last).replace("Bearer ", "");
    expect(JSON.stringify(connector.list())).not.toContain(accessToken);
    // The only place the token lives is the secret store, under ids derived from the binding key.
    for (const id of oauthSecretIds(KEY)) expect(id.startsWith("mcp-oauth:")).toBe(true);
    expect(await store.has(oauthSecretIds(KEY)[0] as string)).toBeDefined();
  });

  it("without a saved sign-in a connection asks for authentication and sends no credentials", async () => {
    const { fake, oauth } = await boot();
    const connector = connectorFor(fake.resourceUrl, oauth);
    await expect(connector.connect("cloud", AbortSignal.timeout(15_000))).rejects.toThrow(
      /needs authentication|failed to connect/,
    );
    expect(connector.info("cloud").status).toBe("needs-authentication");
    expect(fake.mcpAuthorizations().every((header) => header === null)).toBe(true);
  });

  it("refreshes an expired access token with the saved refresh token", async () => {
    const { fake, oauth } = await boot();
    await signIn(oauth, fake.resourceUrl);
    fake.expireAccessTokens();
    const connector = connectorFor(fake.resourceUrl, oauth);
    await connector.connect("cloud", AbortSignal.timeout(15_000));
    expect(connector.info("cloud").status).toBe("connected");
    expect(fake.grants.refresh).toBe(1);
  });

  it("asks to sign in again when the refresh token is no longer valid", async () => {
    const { fake, oauth } = await boot();
    await signIn(oauth, fake.resourceUrl);
    fake.revokeEverything();
    const connector = connectorFor(fake.resourceUrl, oauth);
    await expect(connector.connect("cloud", AbortSignal.timeout(15_000))).rejects.toThrow();
    expect(connector.info("cloud").status).toBe("needs-authentication");
    expect(connector.info("cloud").diagnostic).toMatch(/sign in/i);
  });

  it("rejects an authorization server whose metadata names another issuer", async () => {
    const { fake, store, oauth } = await boot({ metadataIssuer: "https://evil.example" });
    await expect(oauth.start({ key: KEY, serverUrl: fake.resourceUrl })).rejects.toMatchObject({
      code: "oauth_failed",
    });
    expect(await oauth.hasTokens(KEY, fake.resourceUrl)).toBe(false);
    for (const id of oauthSecretIds(KEY)) expect(await store.has(id)).toBe(false);
  });

  it("rejects protected-resource metadata that names another resource (audience)", async () => {
    const { fake, oauth } = await boot({ prmResource: "https://other.example/mcp" });
    await expect(oauth.start({ key: KEY, serverUrl: fake.resourceUrl })).rejects.toMatchObject({
      code: "oauth_failed",
    });
    expect(fake.authorizeUrls).toHaveLength(0);
    expect(await oauth.hasTokens(KEY, fake.resourceUrl)).toBe(false);
  });

  it("rejects an authorization response from another issuer and redeems nothing", async () => {
    const { fake, oauth } = await boot({ redirectIss: "https://evil.example" });
    const flow = await oauth.start({ key: KEY, serverUrl: fake.resourceUrl });
    await browse(flow.authorizationUrl as string);
    const done = await oauth.wait(flow.id);
    expect(done.state).toBe("failed");
    expect(done.error?.code).toBe("oauth_failed");
    expect(fake.grants.code).toBe(0);
    expect(await oauth.hasTokens(KEY, fake.resourceUrl)).toBe(false);
  });

  it("ignores a callback with a wrong state and still accepts the real one", async () => {
    const { fake, oauth } = await boot();
    const flow = await oauth.start({ key: KEY, serverUrl: fake.resourceUrl });
    const redirect = new URL(
      new URL(flow.authorizationUrl as string).searchParams.get("redirect_uri") as string,
    );
    redirect.searchParams.set("state", "forged");
    redirect.searchParams.set("code", "stolen");
    const forged = await fetch(redirect);
    expect(forged.status).toBe(400);
    expect(oauth.flow(flow.id)?.state).toBe("awaiting-browser");
    await browse(flow.authorizationUrl as string);
    expect((await oauth.wait(flow.id)).state).toBe("completed");
  });

  it("reports a refusal from the user as a cancelled sign-in and saves nothing", async () => {
    const { fake, oauth } = await boot();
    const flow = await oauth.start({ key: KEY, serverUrl: fake.resourceUrl });
    const redirect = new URL(
      new URL(flow.authorizationUrl as string).searchParams.get("redirect_uri") as string,
    );
    redirect.searchParams.set(
      "state",
      new URL(flow.authorizationUrl as string).searchParams.get("state") as string,
    );
    redirect.searchParams.set("error", "access_denied");
    await fetch(redirect);
    const done = await oauth.wait(flow.id);
    expect(done.state).toBe("failed");
    expect(done.error?.code).toBe("access_denied");
    expect(await oauth.hasTokens(KEY, fake.resourceUrl)).toBe(false);
  });

  it("cancelling closes the local listener and ends the flow", async () => {
    const { fake, oauth } = await boot();
    const flow = await oauth.start({ key: KEY, serverUrl: fake.resourceUrl });
    const redirect = new URL(
      new URL(flow.authorizationUrl as string).searchParams.get("redirect_uri") as string,
    );
    oauth.cancel(flow.id);
    expect((await oauth.wait(flow.id)).state).toBe("cancelled");
    await expect(fetch(redirect)).rejects.toBeDefined();
  });
});

describe("tokens only travel to the resource they were granted for", () => {
  it("does not send a saved token to another origin, even under the same alias", async () => {
    const { fake, oauth } = await boot();
    await signIn(oauth, fake.resourceUrl);
    const other = await startFakeOAuth();
    servers.push(other);
    expect(await oauth.hasTokens(KEY, other.resourceUrl)).toBe(false);
    const connector = connectorFor(other.resourceUrl, oauth);
    await expect(connector.connect("cloud", AbortSignal.timeout(15_000))).rejects.toThrow();
    expect(connector.info("cloud").status).toBe("needs-authentication");
    expect(other.mcpAuthorizations().every((header) => header === null)).toBe(true);
  });

  it("keeps the sign-in of a project binding apart from the global one with the same alias", async () => {
    const { fake, oauth } = await boot();
    await signIn(oauth, fake.resourceUrl, {
      scope: "project",
      workspacePath: "/a",
      alias: "cloud",
    });
    expect(
      await oauth.hasTokens(
        { scope: "project", workspacePath: "/a", alias: "cloud" },
        fake.resourceUrl,
      ),
    ).toBe(true);
    expect(
      await oauth.hasTokens(
        { scope: "project", workspacePath: "/b", alias: "cloud" },
        fake.resourceUrl,
      ),
    ).toBe(false);
    expect(await oauth.hasTokens(KEY, fake.resourceUrl)).toBe(false);
  });

  it("refuses an authorization server on a private address that the service points to", async () => {
    const fake = await startFakeOAuth();
    servers.push(fake);
    const store = new MemorySecretStore();
    const oauth = new McpOAuth({ store, guard: createUrlGuard() });
    oauths.push(oauth);
    // The resource is the user's own (allowed); its authorization server is another origin on
    // loopback, which a catalog-driven discovery must not contact.
    await expect(oauth.start({ key: KEY, serverUrl: fake.resourceUrl })).rejects.toMatchObject({
      code: "oauth_failed",
    });
    expect(fake.requests.filter((request) => request.server === "as")).toHaveLength(0);
  });
});

describe("signing out and transports", () => {
  it("forgets only the local tokens and asks the service for nothing", async () => {
    const { fake, store, oauth } = await boot();
    await signIn(oauth, fake.resourceUrl);
    const before = fake.requests.length;
    await oauth.forget(KEY);
    expect(await oauth.hasTokens(KEY, fake.resourceUrl)).toBe(false);
    for (const id of oauthSecretIds(KEY)) expect(await store.has(id)).toBe(false);
    expect(fake.requests).toHaveLength(before);
    const connector = connectorFor(fake.resourceUrl, oauth);
    await expect(connector.connect("cloud", AbortSignal.timeout(15_000))).rejects.toThrow();
    expect(connector.info("cloud").status).toBe("needs-authentication");
  });

  it("never uses the OAuth flow for a stdio server", async () => {
    const { oauth } = await boot();
    const spy = vi.spyOn(oauth, "forConnection");
    const config = configSchema.parse({
      mcp: {
        servers: {
          local: {
            transport: "stdio",
            command: process.execPath,
            args: ["fixtures/mcp-bin-server.mjs"],
          },
        },
      },
    });
    const connector = new McpConnector(
      config.mcp.servers,
      new ToolRegistry(),
      process.cwd(),
      "allowed",
      { local: { kind: "global", file: "/x", form: "canonical" } },
      undefined,
      oauth,
    );
    connectors.push(connector);
    await connector.connect("local", AbortSignal.timeout(15_000));
    expect(connector.info("local").status).toBe("connected");
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not leak a token into an error message", async () => {
    const { fake, oauth } = await boot();
    await signIn(oauth, fake.resourceUrl);
    fake.revokeEverything();
    const connector = connectorFor(fake.resourceUrl, oauth);
    const message = await connector.connect("cloud", AbortSignal.timeout(15_000)).then(
      () => "",
      (error: Error) => error.message,
    );
    expect(message).not.toMatch(/at-|rt-|Bearer/);
    expect(JSON.stringify(connector.info("cloud"))).not.toMatch(/at-|rt-/);
  });
});
