/**
 * The stack the browser E2E drives (specs/030 O10): the BUILT `@alisio/server` (and the built web
 * UI it serves) with its state and config homes in a temporary directory, a fake catalog source, a
 * local MCP server that needs a key, a local OAuth authorization server with its protected MCP
 * resource, and a scripted model provider. No network, nothing outside the temporary directory.
 *
 * Run through `pnpm test:e2e` after `pnpm build`; it is not part of the default checklist.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { serve, type TestServer } from "../fixtures/http.ts";
import { makeServer } from "../fixtures/mcp-server.ts";
import { type FakeOAuth, startFakeOAuth } from "../fixtures/oauth-server.ts";

export const NOTES_KEY = "sk-notes-E2E-0123456789";

export interface Stack {
  url: string;
  token: string;
  root: string;
  workspace: string;
  notes: { url: string };
  oauth: FakeOAuth;
  /** `POST <control>/publish-update` makes version 1.1.0 of the local package the catalog's latest. */
  control: string;
  close(): Promise<void>;
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function entry(over: {
  name: string;
  title: string;
  description: string;
  version?: string;
  remote?: { url: string; inputs?: unknown[] };
  pypi?: boolean;
  npm?: string;
}) {
  const rawJson = JSON.stringify(over);
  return {
    sourceId: "e2e",
    name: over.name,
    title: over.title,
    description: over.description,
    version: over.version ?? "1.0.0",
    status: "active" as const,
    isLatest: true,
    updatedAt: "2026-11-01T00:00:00.000Z",
    packages:
      over.pypi || over.npm
        ? [
            {
              method: over.pypi ? "pypi" : "npm",
              identifier: over.pypi ? "pypi-tool" : (over.npm as string),
              version: over.version ?? "1.0.0",
              transport: "stdio",
              inputs: [],
              args: [],
            },
          ]
        : [],
    remotes: over.remote
      ? [
          {
            transport: "streamable-http",
            url: over.remote.url,
            inputs: over.remote.inputs ?? [],
          },
        ]
      : [],
    provenance: { sourceId: "e2e", schemaVersion: "e2e-1", rawDigest: sha(rawJson), rawJson },
  };
}

export async function startStack(): Promise<Stack> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alisio-e2e-")));
  const workspace = join(root, "Contabilidad");
  await mkdir(workspace, { recursive: true });
  // Homes first: nothing may read or write the real config or state of the person running the tests.
  process.env.ALISIO_CONFIG_HOME = join(root, "config");
  process.env.ALISIO_STATE_HOME = join(root, "state");
  process.env.HERDR_ENV = "0";

  // A remote MCP server that only answers with the right key.
  const notes: TestServer = await serve(async (req) => {
    if (req.headers.get("x-api-key") !== NOTES_KEY)
      return new Response("unauthorized", { status: 401 });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await makeServer().connect(transport);
    return transport.handleRequest(req);
  });
  const notesUrl = `http://127.0.0.1:${notes.port}/mcp`;
  const oauth = await startFakeOAuth({ interactive: true });

  const core = await import("@alisio/core");
  // The person trusted this folder when they opened it (project settings load only from trusted folders).
  await core.setTrust(workspace, true, await core.hashProjectConfig(workspace));
  const { startServer } = await import("@alisio/server");
  const FILES = "@example/mcp-files";
  const entries = [
    entry({
      name: "io.example/files",
      title: "Local Files",
      description: "Browse and organise files in a folder on your computer.",
      npm: FILES,
    }),
    entry({
      name: "io.example/notes",
      title: "Notes Cloud",
      description: "Keep your notes in a remote service that needs a key.",
      remote: {
        url: notesUrl,
        inputs: [
          {
            name: "X-Api-Key",
            kind: "header",
            isRequired: true,
            isSecret: true,
            description: "Create one in your Notes Cloud account.",
          },
        ],
      },
    }),
    entry({
      name: "io.example/ledger",
      title: "Ledger Cloud",
      description: "Read your accounting ledger after you sign in.",
      remote: { url: oauth.resourceUrl },
    }),
    entry({
      name: "io.example/pytool",
      title: "Python Tool",
      description: "A Python server that cannot be installed automatically yet.",
      pypi: true,
    }),
  ];
  const source = {
    sourceId: "e2e",
    capabilities: {
      supportsIncremental: true,
      supportsSearch: false,
      supportsCategories: false,
      schemaVersions: ["e2e-1"],
    },
    async listPage(request: { cursor?: string; limit: number }) {
      return request.cursor ? { entries: [], rejected: [] } : { entries, rejected: [] };
    },
    async get(name: string) {
      return entries.find((e) => e.name === name);
    },
  };
  const catalogRef: { current?: ReturnType<typeof core.createCatalogService> } = {};
  const catalog = core.createCatalogService({
    dbPath: join(root, "state", "catalog.sqlite"),
    source: { source: "e2e" },
    factory: core.createSourceFactory({ e2e: () => source as never }),
    autoSync: true,
  });
  catalogRef.current = catalog;
  const secrets = new core.FileSecretStore(join(root, "config"));
  const oauthService = new core.McpOAuth({ store: secrets, guard: core.permissiveUrlGuard });
  const installer = core.createMcpInstaller({
    dbPath: join(root, "state", "installations.sqlite"),
    artifactsRoot: join(root, "state", "artifacts"),
    secrets,
    entries: catalog,
    guard: core.permissiveUrlGuard,
    // No network and no real npm: a package is a folder whose program starts the fixture MCP server.
    runNpm: async (_command: string, args: string[]) => {
      const spec = args[args.length - 1] as string;
      const at = spec.lastIndexOf("@");
      const name = spec.slice(0, at);
      const version = spec.slice(at + 1);
      const prefix = args[args.indexOf("--prefix") + 1] as string;
      const dir = join(prefix, "node_modules", ...name.split("/"));
      await mkdir(join(dir, "dist"), { recursive: true });
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name, version, bin: "dist/server.js" }),
      );
      const fixture = pathToFileURL(resolve("fixtures/mcp-bin-server.mjs")).href;
      await writeFile(join(dir, "dist", "server.js"), `import(${JSON.stringify(fixture)});\n`);
      await writeFile(
        join(prefix, "package-lock.json"),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "": {},
            [`node_modules/${name}`]: { version, integrity: `sha512-${sha(spec).slice(0, 24)}` },
          },
        }),
      );
      return { stdout: "", stderr: "", exitCode: 0, truncated: false };
    },
    runtime: { isExecutable: () => true },
  });
  const provider = {
    id: "scripted",
    model: "scripted-model",
    async *stream() {
      yield {
        type: "completed" as const,
        message: { role: "assistant" as const, text: "ok", calls: [] },
      };
    },
  };
  const server = await startServer({
    port: 0,
    host: "127.0.0.1",
    localBrowser: false,
    defaultWorkspace: workspace,
    mcpCatalog: catalog,
    mcpInstaller: installer,
    mcpSecrets: secrets,
    mcpOAuth: oauthService,
    app: { db: join(root, "state", "sessions.sqlite"), noHerdr: true, provider: provider as never },
  });
  // A tiny control port so a journey can publish a newer version of the local package.
  const control = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/publish-update") {
      const old = entries.find((e) => e.name === "io.example/files");
      if (old) {
        const next = entry({
          name: old.name,
          title: old.title,
          description: old.description,
          npm: FILES,
          version: "1.1.0",
        });
        entries.splice(entries.indexOf(old), 1, { ...next, updatedAt: "2026-11-02T00:00:00.000Z" });
        catalogRef.current?.setSource({ source: "e2e" });
      }
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => control.listen(0, "127.0.0.1", done));
  return {
    control: `http://127.0.0.1:${(control.address() as AddressInfo).port}`,
    url: `http://127.0.0.1:${server.port}`,
    token: server.token,
    root,
    workspace,
    notes: { url: notesUrl },
    oauth,
    async close() {
      await server.close();
      await oauth.close();
      await notes.close();
      await new Promise<void>((done) => control.close(() => done()));
    },
  };
}
