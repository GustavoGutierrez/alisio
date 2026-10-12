/**
 * `alisio analysis setup --wasm` core (Python spec §8.1, PD7, FP-AC-22): the only code that fetches
 * Pyodide. Runs against a local HTTP server that serves a tiny fake manifest; the real
 * distribution is never downloaded in tests.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  downloadSize,
  inspectPyodide,
  installPyodide,
  PyodideIntegrityError,
  profileFiles,
  pyodideDir,
  verifyPyodideFiles,
} from "../packages/core/src/forge/python/pyodide-install.ts";
import {
  PYODIDE_MANIFEST,
  type PyodideManifest,
} from "../packages/core/src/forge/python/pyodide-manifest.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

let server: Server;
let base: string;
let root: string;
let hits: string[];
/** What the server sends per path; the manifest pins the originals. */
let served: Record<string, string>;
const bodies: Record<string, string> = {
  "pyodide.mjs": "export const loadPyodide = 1;\n",
  "pyodide-lock.json": '{"packages":{}}',
  "numpy-1.whl": "numpy wheel bytes",
  "scipy-1.whl": "scipy wheel bytes, a little longer",
};
const file = (name: string, source: "pyodide" | "pypi" = "pyodide") => ({
  name,
  url: `${base}/${name}`,
  sha256: sha(bodies[name] as string),
  size: Buffer.byteLength(bodies[name] as string),
  source,
});
let manifest: PyodideManifest;

beforeEach(async () => {
  hits = [];
  served = { ...bodies };
  server = createServer((req, res) => {
    const name = (req.url ?? "").slice(1);
    hits.push(name);
    if (!(name in served)) {
      res.statusCode = 404;
      res.end("no");
      return;
    }
    res.end(served[name]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = await mkdtemp(join(tmpdir(), "alisio-pyodide-"));
  manifest = {
    version: "0.0.1",
    python: "3.14.0",
    core: [file("pyodide.mjs"), file("pyodide-lock.json")],
    packages: {
      numpy: { ...file("numpy-1.whl"), depends: [] },
      scipy: { ...file("scipy-1.whl", "pypi"), depends: ["numpy"] },
    },
    profiles: { base: [], analysis: ["numpy"], science: ["numpy", "scipy"] },
  };
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

const dirOf = () => pyodideDir(root, manifest);

describe("installPyodide", () => {
  it("downloads the runtime and the closure of the profile, verifies them and marks it ready", async () => {
    const progress: string[] = [];
    const result = await installPyodide({
      dir: dirOf(),
      profile: "analysis",
      manifest,
      onProgress: (e) => progress.push(`${e.index}/${e.total} ${e.file}`),
    });
    expect(result).toEqual({ ok: true, dir: dirOf(), profile: "analysis" });
    expect((await readdir(dirOf())).sort()).toEqual(
      ["numpy-1.whl", "pyodide-lock.json", "pyodide.mjs", "ready.json"].sort(),
    );
    expect(progress).toEqual(["1/3 pyodide.mjs", "2/3 pyodide-lock.json", "3/3 numpy-1.whl"]);
    expect(await inspectPyodide(dirOf(), manifest)).toEqual({
      ok: true,
      dir: dirOf(),
      profile: "analysis",
    });
    expect(await verifyPyodideFiles(dirOf(), profileFiles(manifest, "analysis"))).toBeUndefined();
  });

  it("a payload that does not match its pinned hash is discarded and the backend is not ready (FP-AC-22)", async () => {
    served["numpy-1.whl"] = "numpy wheel bytez"; // same length, other bytes
    await expect(installPyodide({ dir: dirOf(), profile: "analysis", manifest })).rejects.toThrow(
      PyodideIntegrityError,
    );
    expect(await stat(dirOf()).catch(() => undefined)).toBeUndefined();
    expect(await inspectPyodide(dirOf(), manifest)).toEqual({
      ok: false,
      reason: "Pyodide is not installed",
    });
  });

  it("stops a server that sends more than the pinned size, and rejects a short body", async () => {
    served["pyodide.mjs"] = `${bodies["pyodide.mjs"]}${"x".repeat(5000)}`;
    await expect(installPyodide({ dir: dirOf(), profile: "base", manifest })).rejects.toThrow(
      /larger than the pinned/,
    );
    served["pyodide.mjs"] = "short";
    await expect(installPyodide({ dir: dirOf(), profile: "base", manifest })).rejects.toThrow(
      PyodideIntegrityError,
    );
    expect(await stat(dirOf()).catch(() => undefined)).toBeUndefined();
  });

  it("an HTTP error names the file and leaves nothing behind", async () => {
    delete served["numpy-1.whl"];
    await expect(installPyodide({ dir: dirOf(), profile: "analysis", manifest })).rejects.toThrow(
      /numpy-1\.whl failed: HTTP 404/,
    );
    expect(await stat(dirOf()).catch(() => undefined)).toBeUndefined();
  });

  it("a later, larger profile fetches only what is missing; a failed upgrade keeps the verified install", async () => {
    await installPyodide({ dir: dirOf(), profile: "analysis", manifest });
    hits.length = 0;
    served["scipy-1.whl"] = "scipy wheel bytes, a little longer".replace("scipy", "evil!");
    await expect(installPyodide({ dir: dirOf(), profile: "science", manifest })).rejects.toThrow(
      PyodideIntegrityError,
    );
    expect(hits).toEqual(["scipy-1.whl"]);
    expect((await inspectPyodide(dirOf(), manifest)).ok).toBe(true);
    expect(await readdir(dirOf())).not.toContain(".download");
    served["scipy-1.whl"] = bodies["scipy-1.whl"] as string;
    const upgraded = await installPyodide({ dir: dirOf(), profile: "science", manifest });
    expect(upgraded).toMatchObject({ ok: true, profile: "science" });
  });

  it("never downgrades a larger installation", async () => {
    await installPyodide({ dir: dirOf(), profile: "science", manifest });
    hits.length = 0;
    const again = await installPyodide({ dir: dirOf(), profile: "analysis", manifest });
    expect(again).toMatchObject({ ok: true, profile: "science" });
    expect(hits).toEqual([]);
  });

  it("an aborted download throws and leaves no partial files", async () => {
    const controller = new AbortController();
    controller.abort(new Error("interrupted"));
    await expect(
      installPyodide({ dir: dirOf(), profile: "analysis", manifest, signal: controller.signal }),
    ).rejects.toThrow("interrupted");
    expect(await stat(dirOf()).catch(() => undefined)).toBeUndefined();
  });
});

describe("concurrent installs (L6)", () => {
  it("two setups of the same folder do not delete or cross each other's staged files", async () => {
    // Every download is slow enough for both runs to be in the middle of theirs at once.
    const slow: typeof fetch = async (url) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return new Response(served[String(url).slice(base.length + 1)] as string);
    };
    const [a, b] = await Promise.allSettled([
      installPyodide({ dir: dirOf(), profile: "science", manifest, fetch: slow }),
      installPyodide({ dir: dirOf(), profile: "analysis", manifest, fetch: slow }),
    ]);
    expect(a.status, JSON.stringify(a)).toBe("fulfilled");
    expect(b.status, JSON.stringify(b)).toBe("fulfilled");
    expect(await verifyPyodideFiles(dirOf(), profileFiles(manifest, "science"))).toBeUndefined();
    expect(await inspectPyodide(dirOf(), manifest)).toMatchObject({ ok: true, profile: "science" });
    expect((await readdir(dirOf())).filter((n) => n.startsWith("."))).toEqual([]);
  });
});

describe("inspectPyodide", () => {
  it("is not ready when nothing is installed, when a file is missing or truncated, or the version differs", async () => {
    expect((await inspectPyodide(dirOf(), manifest)).ok).toBe(false);
    await installPyodide({ dir: dirOf(), profile: "analysis", manifest });
    await truncate(join(dirOf(), "numpy-1.whl"), 3);
    expect(await inspectPyodide(dirOf(), manifest)).toEqual({
      ok: false,
      reason: "Pyodide file numpy-1.whl is missing or damaged",
    });
    await rm(join(dirOf(), "numpy-1.whl"));
    expect((await inspectPyodide(dirOf(), manifest)).ok).toBe(false);
    await installPyodide({ dir: dirOf(), profile: "analysis", manifest });
    expect(await inspectPyodide(dirOf(), { ...manifest, version: "0.0.2" })).toEqual({
      ok: false,
      reason: "the installed Pyodide is not 0.0.2",
    });
  });

  it("verifyPyodideFiles names the file whose bytes changed under the same size", async () => {
    await installPyodide({ dir: dirOf(), profile: "analysis", manifest });
    await writeFile(join(dirOf(), "numpy-1.whl"), "numpy wheel bytez");
    expect((await inspectPyodide(dirOf(), manifest)).ok).toBe(true); // size only
    expect(await verifyPyodideFiles(dirOf(), profileFiles(manifest, "analysis"))).toBe(
      "numpy-1.whl",
    );
  });
});

describe("the real manifest", () => {
  it("pins every file with a SHA-256 and a size, lists closed dependency closures, and has no sqlite3", () => {
    const m = PYODIDE_MANIFEST;
    for (const f of [...m.core, ...Object.values(m.packages)]) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.size).toBeGreaterThan(0);
      expect(f.url).toMatch(
        f.source === "pypi"
          ? /^https:\/\/files\.pythonhosted\.org\//
          : /^https:\/\/cdn\.jsdelivr\.net\/pyodide\/v314\.0\.7\/full\//,
      );
    }
    for (const profile of ["analysis", "science"] as const) {
      const loaded = new Set<string>();
      for (const key of m.profiles[profile]) {
        for (const dep of m.packages[key]?.depends ?? []) expect(loaded.has(dep)).toBe(true);
        loaded.add(key);
      }
    }
    expect(m.profiles.science.slice(0, m.profiles.analysis.length)).toEqual(m.profiles.analysis);
    expect(Object.keys(m.packages)).not.toContain("sqlite3");
    expect(downloadSize(m, "science")).toBeGreaterThan(downloadSize(m, "analysis"));
  });
});
