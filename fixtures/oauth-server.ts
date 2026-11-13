/**
 * A local OAuth 2.1 authorization server and a protected MCP resource server (specs/030 phase 4).
 * Two real HTTP servers on two ports, so "another origin" is real: RFC 9728 protected-resource
 * metadata, RFC 8414 authorization-server metadata, RFC 7591 dynamic registration, PKCE (S256),
 * RFC 8707 resource indicators, RFC 9207 `iss`, refresh-token rotation. Tests and the browser E2E
 * share it; it never touches the network and is NOT a conformant production server.
 *
 * `options` make the servers misbehave on purpose (wrong issuer, wrong resource, wrong `iss`).
 */
import { createHash, randomBytes } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { serve, type TestServer } from "./http.ts";
import { makeServer } from "./mcp-server.ts";

export interface FakeOAuthOptions {
  /** Access-token lifetime in seconds (default 3600). */
  expiresIn?: number;
  /** `issuer` the authorization-server metadata claims (default: its real origin). */
  metadataIssuer?: string;
  /** `resource` the protected-resource metadata claims (default: the real resource URL). */
  prmResource?: string;
  /** `iss` returned on the authorization redirect (default: the real issuer). */
  redirectIss?: string;
  /** Redirect the user's browser here instead of the registered redirect URI. */
  redirectTo?: string;
  /** Answer `/authorize` with a page that approves on a button click (browser E2E). */
  interactive?: boolean;
  /** Where the resource server sends the client for its metadata (default: its own origin). */
  asOnResourceOrigin?: boolean;
}

export interface RecordedRequest {
  server: "as" | "rs";
  method: string;
  path: string;
  authorization: string | null;
}

export interface FakeOAuth {
  resourceUrl: string;
  issuer: string;
  requests: RecordedRequest[];
  /** Every `Authorization` header the resource server received on `/mcp`. */
  mcpAuthorizations(): Array<string | null>;
  /** Invalidates every access token issued so far (refresh tokens keep working). */
  expireAccessTokens(): void;
  /** Invalidates refresh tokens too (the user must sign in again). */
  revokeEverything(): void;
  /** Number of authorization-code and refresh-token grants served. */
  grants: { code: number; refresh: number };
  authorizeUrls: string[];
  close(): Promise<void>;
}

const b64url = (buffer: Buffer) => buffer.toString("base64url");
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export async function startFakeOAuth(options: FakeOAuthOptions = {}): Promise<FakeOAuth> {
  const requests: RecordedRequest[] = [];
  const clients = new Map<string, { redirectUris: string[] }>();
  const codes = new Map<
    string,
    { client: string; challenge: string; redirect: string; resource?: string }
  >();
  let access = new Set<string>();
  let refresh = new Set<string>();
  const grants = { code: 0, refresh: 0 };
  const authorizeUrls: string[] = [];
  let resourceOrigin = "";
  let asOrigin = "";

  /** Stateless: every request gets its own server, so any number of clients can connect. */
  const handleMcp = async (req: Request) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await makeServer().connect(transport);
    return transport.handleRequest(req);
  };

  const record = (server: "as" | "rs", req: Request) => {
    const url = new URL(req.url);
    requests.push({
      server,
      method: req.method,
      path: url.pathname,
      authorization: req.headers.get("authorization"),
    });
  };

  const authMetadata = () => ({
    issuer: options.metadataIssuer ?? asOrigin,
    authorization_endpoint: `${asOrigin}/authorize`,
    token_endpoint: `${asOrigin}/token`,
    registration_endpoint: `${asOrigin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  });

  const resource: TestServer = await serve(async (req) => {
    record("rs", req);
    const url = new URL(req.url);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json({
        resource: options.prmResource ?? `${resourceOrigin}/mcp`,
        authorization_servers: [asOrigin],
        bearer_methods_supported: ["header"],
      });
    if (options.asOnResourceOrigin && url.pathname.startsWith("/.well-known/oauth-authorization"))
      return json(authMetadata());
    if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
    if (!token || !access.has(token))
      return new Response("unauthorized", {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${resourceOrigin}/.well-known/oauth-protected-resource/mcp"`,
        },
      });
    return handleMcp(req);
  });
  resourceOrigin = `http://127.0.0.1:${resource.port}`;

  const authorization: TestServer = await serve(async (req) => {
    record("as", req);
    const url = new URL(req.url);
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
      return json(authMetadata());
    if (url.pathname === "/register" && req.method === "POST") {
      const body = (await req.json()) as { redirect_uris?: string[] };
      const id = `client-${randomBytes(6).toString("hex")}`;
      clients.set(id, { redirectUris: body.redirect_uris ?? [] });
      return json({ ...body, client_id: id }, 201);
    }
    if (url.pathname === "/authorize") {
      authorizeUrls.push(req.url);
      const clientId = url.searchParams.get("client_id") ?? "";
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      const client = clients.get(clientId);
      if (!client || !client.redirectUris.includes(redirect))
        return new Response("invalid client or redirect_uri", { status: 400 });
      if (
        url.searchParams.get("response_type") !== "code" ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        !url.searchParams.get("code_challenge")
      )
        return new Response("PKCE is required", { status: 400 });
      const approve = () => {
        const code = b64url(randomBytes(16));
        const resourceParam = url.searchParams.get("resource");
        codes.set(code, {
          client: clientId,
          challenge: url.searchParams.get("code_challenge") as string,
          redirect,
          ...(resourceParam ? { resource: resourceParam } : {}),
        });
        const target = new URL(options.redirectTo ?? redirect);
        target.searchParams.set("code", code);
        const state = url.searchParams.get("state");
        if (state) target.searchParams.set("state", state);
        target.searchParams.set("iss", options.redirectIss ?? asOrigin);
        return target.toString();
      };
      if (options.interactive && url.searchParams.get("approve") !== "1") {
        const next = new URL(req.url);
        next.searchParams.set("approve", "1");
        return new Response(
          `<!doctype html><html><body><h1>Fake service sign-in</h1><a id="approve" href="${next.pathname}${next.search}">Allow access</a></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      return Response.redirect(approve(), 302);
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      const issue = () => {
        const accessToken = `at-${b64url(randomBytes(12))}`;
        const refreshToken = `rt-${b64url(randomBytes(12))}`;
        access.add(accessToken);
        refresh.add(refreshToken);
        return json({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: options.expiresIn ?? 3600,
          refresh_token: refreshToken,
        });
      };
      if (form.get("grant_type") === "authorization_code") {
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = b64url(createHash("sha256").update(verifier).digest());
        if (!code || code.challenge !== challenge || code.redirect !== form.get("redirect_uri"))
          return json({ error: "invalid_grant" }, 400);
        grants.code++;
        return issue();
      }
      if (form.get("grant_type") === "refresh_token") {
        const token = form.get("refresh_token") ?? "";
        if (!refresh.has(token)) return json({ error: "invalid_grant" }, 400);
        refresh.delete(token);
        grants.refresh++;
        return issue();
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }
    return new Response("not found", { status: 404 });
  });
  asOrigin = `http://127.0.0.1:${authorization.port}`;

  return {
    resourceUrl: `${resourceOrigin}/mcp`,
    issuer: asOrigin,
    requests,
    mcpAuthorizations: () =>
      requests.filter((r) => r.server === "rs" && r.path === "/mcp").map((r) => r.authorization),
    expireAccessTokens: () => {
      access = new Set();
    },
    revokeEverything: () => {
      access = new Set();
      refresh = new Set();
    },
    grants,
    authorizeUrls,
    close: async () => {
      await resource.close();
      await authorization.close();
    },
  };
}
