/**
 * Specs/030 phase 3, O8 and D7/D17: MCP secrets live behind the `SecretStore` port, in a 0600 file
 * that is never part of any shareable JSON, wire DTO, log or error. MCP-CAT-09 and MCP-CAT-29 run
 * here at the module boundary; the end-to-end installs live in `mcp-installation.test.ts`.
 */
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serve } from "../fixtures/http.ts";
import { makeServer } from "../fixtures/mcp-server.ts";
import { configSchema } from "../packages/core/src/config.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { McpConnector } from "../packages/core/src/mcp/connector.ts";
import {
  FileSecretStore,
  MemorySecretStore,
  resolveSecretReference,
} from "../packages/core/src/mcp/installation/secrets.ts";

afterEach(() => vi.unstubAllEnvs());

const SECRET = "sk-live-SUPER-SECRET-0123456789";

async function home() {
  const root = await mkdtemp(join(tmpdir(), "alisio-mcp-secrets-"));
  return root;
}

describe("FileSecretStore (O8)", () => {
  it("keeps values in a 0600 file, behind the SecretStore port, and reads them back", async () => {
    const root = await home();
    const store = new FileSecretStore(root);
    await store.set("mcp:b1:env.API_KEY", SECRET);
    expect(await store.get("mcp:b1:env.API_KEY")).toBe(SECRET);
    expect(await store.has("mcp:b1:env.API_KEY")).toBe(true);
    expect(await store.get("mcp:b1:env.MISSING")).toBeUndefined();
    if (process.platform !== "win32") {
      const mode = (await stat(join(root, "mcp-secrets.json"))).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    // A second instance (another process, or after a restart) sees the same values.
    expect(await new FileSecretStore(root).get("mcp:b1:env.API_KEY")).toBe(SECRET);
  });

  it("deletes one or many values and tolerates unknown ids", async () => {
    const store = new FileSecretStore(await home());
    await store.setMany({ a: "1", b: "2", c: "3" });
    await store.delete("a");
    await store.deleteMany(["b", "never-existed"]);
    expect(await store.has("a")).toBe(false);
    expect(await store.has("b")).toBe(false);
    expect(await store.get("c")).toBe("3");
  });

  it("does not lose a value when two writers race", async () => {
    const root = await home();
    const writers = Array.from({ length: 12 }, (_, i) =>
      new FileSecretStore(root).set(`id-${i}`, `value-${i}`),
    );
    await Promise.all(writers);
    const store = new FileSecretStore(root);
    for (let i = 0; i < 12; i++) expect(await store.get(`id-${i}`)).toBe(`value-${i}`);
  });

  it("leaves no temporary file behind and never writes anywhere but its own file", async () => {
    const root = await home();
    await new FileSecretStore(root).set("x", SECRET);
    const files = await readdir(root);
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(files).toContain("mcp-secrets.json");
    expect(files).not.toContain("config.json");
  });
});

describe("resolveSecretReference", () => {
  it("resolves a store reference and an environment reference, and nothing else", async () => {
    const store = new MemorySecretStore();
    await store.set("mcp:b:env.K", "from-store");
    const env = { FROM_ENV: "from-env" };
    expect(await resolveSecretReference({ secret: "mcp:b:env.K" }, store, env)).toBe("from-store");
    expect(await resolveSecretReference({ env: "FROM_ENV" }, store, env)).toBe("from-env");
    expect(await resolveSecretReference({ secret: "nope" }, store, env)).toBeUndefined();
    expect(await resolveSecretReference({ env: "NOPE" }, store, env)).toBeUndefined();
  });
});

describe("MCP-CAT-09: a resolved secret reaches only the connection that declared it", () => {
  it("passes a stored secret to the stdio child as an environment variable, never through process.env", async () => {
    const store = new MemorySecretStore();
    await store.set("mcp:b1:env.FIXTURE_API_KEY", SECRET);
    const servers = configSchema.parse({
      mcp: {
        servers: {
          one: {
            transport: "stdio",
            command: process.execPath,
            args: [
              ...(process.versions.bun
                ? []
                : ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"]),
              "fixtures/mcp-server.ts",
            ],
            secretEnv: { FIXTURE_API_KEY: { secret: "mcp:b1:env.FIXTURE_API_KEY" } },
          },
        },
      },
    }).mcp.servers;
    const connector = new McpConnector(
      servers,
      new ToolRegistry(),
      process.cwd(),
      "allowed",
      {},
      (ref) => resolveSecretReference(ref, store, {}),
    );
    connector.register();
    try {
      await connector.connect("one", AbortSignal.timeout(15_000));
      expect(connector.info("one").status).toBe("connected");
      expect(process.env.FIXTURE_API_KEY).toBeUndefined();
      // The wire-facing info never carries the value, the reference or the environment.
      expect(JSON.stringify(connector.info("one"))).not.toContain(SECRET);
      expect(JSON.stringify(connector.info("one"))).not.toContain("mcp:b1");
    } finally {
      await connector.close();
    }
  });

  it("marks a server whose saved key is missing as needing attention, without leaking the id", async () => {
    const servers = configSchema.parse({
      mcp: {
        servers: {
          one: {
            transport: "stdio",
            command: process.execPath,
            args: ["-e", "0"],
            secretEnv: { K: { secret: "mcp:gone:env.K" } },
          },
        },
      },
    }).mcp.servers;
    const connector = new McpConnector(
      servers,
      new ToolRegistry(),
      process.cwd(),
      "allowed",
      {},
      (ref) => resolveSecretReference(ref, new MemorySecretStore(), {}),
    );
    const error = await connector.connect("one", AbortSignal.timeout(5_000)).catch((e) => e);
    expect(String(error)).not.toContain("mcp:gone");
    expect(connector.info("one").status).toBe("needs-authentication");
    expect(connector.info("one").diagnostic ?? "").not.toContain("mcp:gone");
  });
});

describe("MCP-CAT-29: a secret header goes only to the origin of its binding", () => {
  async function remote(options: { redirectTo?: string } = {}) {
    const seen: Array<string | null> = [];
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await makeServer().connect(transport);
    const http = await serve((req) => {
      seen.push(req.headers.get("x-api-key"));
      if (options.redirectTo) return Response.redirect(options.redirectTo, 307);
      return transport.handleRequest(req);
    });
    return { http, seen };
  }

  it("sends a stored header value to its own origin and exposes nothing on the wire", async () => {
    const { http, seen } = await remote();
    const store = new MemorySecretStore();
    await store.set("mcp:r1:header.x-api-key", SECRET);
    const servers = configSchema.parse({
      mcp: {
        servers: {
          r: {
            transport: "http",
            url: `http://127.0.0.1:${http.port}/mcp`,
            headers: { "x-api-key": { secret: "mcp:r1:header.x-api-key" } },
          },
        },
      },
    }).mcp.servers;
    const connector = new McpConnector(
      servers,
      new ToolRegistry(),
      process.cwd(),
      "allowed",
      {},
      (ref) => resolveSecretReference(ref, store, {}),
    );
    try {
      await connector.connect("r", AbortSignal.timeout(10_000));
      expect(connector.info("r").status).toBe("connected");
      expect(seen.every((value) => value === SECRET)).toBe(true);
      expect(seen.length).toBeGreaterThan(0);
      expect(JSON.stringify(connector.info("r"))).not.toContain(SECRET);
    } finally {
      await connector.close();
      await http.close();
    }
  });

  it("refuses to follow a redirect, so the secret never reaches another origin", async () => {
    const elsewhere = await remote();
    const { http, seen } = await remote({
      redirectTo: `http://127.0.0.1:${elsewhere.http.port}/mcp`,
    });
    const store = new MemorySecretStore();
    await store.set("mcp:r1:header.x-api-key", SECRET);
    const servers = configSchema.parse({
      mcp: {
        servers: {
          r: {
            transport: "http",
            url: `http://127.0.0.1:${http.port}/mcp`,
            headers: { "x-api-key": { secret: "mcp:r1:header.x-api-key" } },
          },
        },
      },
    }).mcp.servers;
    const connector = new McpConnector(
      servers,
      new ToolRegistry(),
      process.cwd(),
      "allowed",
      {},
      (ref) => resolveSecretReference(ref, store, {}),
    );
    try {
      const error = await connector.connect("r", AbortSignal.timeout(10_000)).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(SECRET);
      expect(seen.length).toBeGreaterThan(0);
      expect(elsewhere.seen).toEqual([]);
      expect(connector.info("r").status).not.toBe("connected");
    } finally {
      await connector.close();
      await http.close();
      await elsewhere.http.close();
    }
  });

  it("resolves an environment-variable header reference at connect time", async () => {
    const { http, seen } = await remote();
    vi.stubEnv("FIXTURE_HEADER", "env-value");
    const servers = configSchema.parse({
      mcp: {
        servers: {
          r: {
            transport: "http",
            url: `http://127.0.0.1:${http.port}/mcp`,
            headers: { "x-api-key": { env: "FIXTURE_HEADER" } },
          },
        },
      },
    }).mcp.servers;
    const connector = new McpConnector(
      servers,
      new ToolRegistry(),
      process.cwd(),
      "allowed",
      {},
      (ref) => resolveSecretReference(ref, new MemorySecretStore(), process.env),
    );
    try {
      await connector.connect("r", AbortSignal.timeout(10_000));
      expect(seen.every((value) => value === "env-value")).toBe(true);
    } finally {
      await connector.close();
      await http.close();
    }
  });
});
