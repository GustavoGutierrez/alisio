/**
 * `alisio analysis setup --wasm` (Python spec §8.1, §9.2, FP-AC-22): size estimate, confirmation,
 * download into `<analysis dir>/pyodide/<version>/`, hash verification, and a clean not-ready state
 * on any mismatch. A local HTTP server serves a tiny fake manifest; the real distribution is never
 * downloaded here.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backendsTable, setupWasm } from "../packages/cli/src/analysis.ts";
import type { PyodideManifest } from "../packages/core/src/forge/python/pyodide-manifest.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const bodies: Record<string, string> = {
  "pyodide.mjs": "export const loadPyodide = 1;\n",
  "pyodide-lock.json": "{}",
  "numpy-1.whl": "numpy wheel",
  "scipy-1.whl": "scipy wheel!",
};
let server: Server;
let served: Record<string, string>;
let hits: string[];
let root: string;
let state: string;
let manifest: PyodideManifest;
let out: string;

const entry = (name: string) => ({
  name,
  url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/${name}`,
  sha256: sha(bodies[name] as string),
  size: Buffer.byteLength(bodies[name] as string),
  source: "pyodide" as const,
});
const o = () => ({ cwd: root, config: join(root, "none.json") });
const deps = (over: Record<string, unknown> = {}) => ({
  manifest,
  write: (text: string) => {
    out += text;
  },
  ...over,
});

beforeEach(async () => {
  hits = [];
  out = "";
  served = { ...bodies };
  server = createServer((req, res) => {
    const name = (req.url ?? "").slice(1);
    hits.push(name);
    if (name in served) res.end(served[name]);
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  root = await mkdtemp(join(tmpdir(), "alisio-cli-wasm-"));
  state = join(root, "state");
  await mkdir(state, { recursive: true });
  vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("ALISIO_STATE_HOME", state);
  manifest = {
    version: "0.0.1",
    python: "3.14.0",
    core: [entry("pyodide.mjs"), entry("pyodide-lock.json")],
    packages: {
      numpy: { ...entry("numpy-1.whl"), depends: [] },
      scipy: { ...entry("scipy-1.whl"), depends: ["numpy"] },
    },
    profiles: { base: [], analysis: ["numpy"], science: ["numpy", "scipy"] },
  };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

const pyodideDir = () => join(state, "analysis", "pyodide", "0.0.1");

describe("alisio analysis setup --wasm", () => {
  it("shows the size, source and destination first, then downloads and verifies with --yes", async () => {
    await setupWasm(o(), { yes: true }, deps());
    expect(out).toMatch(
      /Pyodide 0\.0\.1 \(Python 3\.14\.0\), profile analysis: about 1 MB from 127\.0\.0\.1:\d+\./,
    );
    expect(out).toContain(pyodideDir());
    expect(out).toContain("[3/3] numpy-1.whl");
    expect(out).toContain("Pyodide 0.0.1 is ready (profile analysis)");
    expect((await readdir(pyodideDir())).sort()).toEqual(
      ["numpy-1.whl", "pyodide-lock.json", "pyodide.mjs", "ready.json"].sort(),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("the science profile fetches the larger closure", async () => {
    await setupWasm(o(), { profile: "science", yes: true }, deps());
    expect(hits).toContain("scipy-1.whl");
    expect(out).toContain("profile science");
  });

  it("a non-interactive run without --yes asks for it and downloads nothing", async () => {
    await expect(setupWasm(o(), {}, deps({ interactive: false }))).rejects.toThrow(/pass --yes/);
    expect(hits).toEqual([]);
    expect(await stat(pyodideDir()).catch(() => undefined)).toBeUndefined();
  });

  it("interactively it asks, and a no downloads nothing", async () => {
    const questions: string[] = [];
    await setupWasm(
      o(),
      {},
      deps({
        interactive: true,
        ask: async (q: string) => {
          questions.push(q);
          return false;
        },
      }),
    );
    expect(questions).toEqual(["Download now? [y/N] "]);
    expect(out).toContain("Cancelled; nothing was downloaded.");
    expect(hits).toEqual([]);
  });

  it("interactively a yes downloads", async () => {
    await setupWasm(o(), {}, deps({ interactive: true, ask: async () => true }));
    expect(hits).toContain("numpy-1.whl");
  });

  it("FP-AC-22: a wrong hash discards the download, fails the command and leaves the backend not ready", async () => {
    served["numpy-1.whl"] = "numpy wheeX";
    await setupWasm(o(), { yes: true }, deps());
    expect(process.exitCode).toBe(1);
    expect(out).toContain("numpy-1.whl does not match its pinned SHA-256");
    expect(out).toContain("The wasm backend is not ready.");
    expect(await stat(pyodideDir()).catch(() => undefined)).toBeUndefined();
  });

  it("never touches the managed venv or the container image: only the pyodide folder appears", async () => {
    await setupWasm(o(), { yes: true }, deps());
    expect(await readdir(join(state, "analysis"))).toEqual(["pyodide"]);
  });

  it("refuses a profile it does not know", async () => {
    await expect(setupWasm(o(), { profile: "everything", yes: true }, deps())).rejects.toThrow(
      /--profile analysis/,
    );
  });
});

describe("backendsTable", () => {
  it("lines up readiness, isolation, profiles, network and the note, and labels the host honestly", () => {
    const caps = {
      cooperativeInterrupt: false,
      hardTermination: true,
      hardMemoryLimit: false,
      toolCalls: false,
    };
    const table = backendsTable([
      {
        id: "python-wasm",
        language: "python",
        version: "pyodide",
        isolation: "wasm-process",
        ready: true,
        capabilities: { ...caps, networkDeniedByOS: false },
        profiles: ["base", "analysis"],
      },
      {
        id: "python-managed",
        language: "python",
        version: "host",
        isolation: "none",
        ready: true,
        capabilities: { ...caps, networkDeniedByOS: false },
      },
      {
        id: "python-oci",
        language: "python",
        version: "img",
        isolation: "os-container",
        ready: false,
        reason: "docker was not found",
        capabilities: { ...caps, networkDeniedByOS: true },
      },
    ]).split("\n");
    expect(table[0]).toMatch(/^BACKEND\s+ISOLATION\s+STATE\s+PROFILES\s+NETWORK\s+NOTE$/);
    expect(table[1]).toMatch(/^wasm\s+wasm-process\s+ready\s+base,analysis\s+open\s*$/);
    expect(table[2]).toMatch(/^managed\s+none\s+ready\s+-\s+open\s+host \(not sandboxed\)$/);
    expect(table[3]).toMatch(
      /^oci\s+os-container\s+not ready\s+-\s+denied\s+docker was not found$/,
    );
  });
});
