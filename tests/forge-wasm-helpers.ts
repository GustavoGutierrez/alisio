/**
 * Fixtures for the wasm (Pyodide) backend tests: a tiny pinned distribution installed through an
 * in-memory `fetch`, and a fake `node` (`fixtures/fake-node.mjs`) behind a wrapper script, so the
 * launch path, flags, environment and watchdog are tested without the real 70 MB distribution.
 */
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installPyodide, pyodideDir } from "../packages/core/src/forge/python/pyodide-install.ts";
import type { PyodideManifest } from "../packages/core/src/forge/python/pyodide-manifest.ts";

const FAKE_NODE = resolve("fixtures/fake-node.mjs");

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const body = (name: string) => `contents of ${name}\n`;
const lock = (name: string, depends: string[] = [], source: "pyodide" | "pypi" = "pyodide") => ({
  name: `${name}-1.0-py3-none-any.whl`,
  url: `https://files.invalid/${name}.whl`,
  sha256: sha(body(`${name}-1.0-py3-none-any.whl`)),
  size: Buffer.byteLength(body(`${name}-1.0-py3-none-any.whl`)),
  source,
  depends,
});
const core = (name: string) => ({
  name,
  url: `https://files.invalid/${name}`,
  sha256: sha(body(name)),
  size: Buffer.byteLength(body(name)),
  source: "pyodide" as const,
});

/** The manifest shape of the real one, with tiny files and the same package names. */
export const TINY_MANIFEST: PyodideManifest = {
  version: "9.9.9",
  python: "3.14.0",
  core: [core("pyodide.mjs"), core("pyodide-lock.json")],
  packages: {
    numpy: lock("numpy"),
    "python-dateutil": lock("python-dateutil"),
    pytz: lock("pytz"),
    pandas: lock("pandas", ["numpy", "python-dateutil", "pytz"]),
    lxml: lock("lxml"),
    "typing-extensions": lock("typing-extensions"),
    "python-docx": lock("python-docx", ["lxml", "typing-extensions"], "pypi"),
    scipy: lock("scipy", ["numpy"]),
    "scikit-learn": lock("scikit-learn", ["scipy"]),
  },
  profiles: {
    base: [],
    analysis: [
      "numpy",
      "python-dateutil",
      "pytz",
      "pandas",
      "lxml",
      "typing-extensions",
      "python-docx",
    ],
    science: [
      "numpy",
      "python-dateutil",
      "pytz",
      "pandas",
      "lxml",
      "typing-extensions",
      "python-docx",
      "scipy",
      "scikit-learn",
    ],
  },
};

export interface WasmFixture {
  stateRoot: string;
  manifest: PyodideManifest;
  /** `<stateRoot>/analysis/pyodide/<version>`. */
  dist: string;
  /** A wrapper that runs the fake node; `settings.nodePath` for the backend. */
  node(options?: {
    net?: "denied" | "open" | `error:${string}`;
    reports?: string;
    name?: string;
  }): Promise<string>;
  /** Installs the tiny distribution without any network. */
  install(profile?: "analysis" | "science"): Promise<void>;
  dispose(): Promise<void>;
}

export async function wasmFixture(): Promise<WasmFixture> {
  const stateRoot = await mkdtemp(join(tmpdir(), "alisio-wasm-"));
  const bin = join(stateRoot, "bin");
  const manifest = TINY_MANIFEST;
  const dist = pyodideDir(stateRoot, manifest);
  const names = new Map(
    [...manifest.core, ...Object.values(manifest.packages)].map((f) => [f.url, f.name]),
  );
  return {
    stateRoot,
    manifest,
    dist,
    async node(options = {}) {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(bin, { recursive: true });
      const path = join(bin, options.name ?? "fake-node");
      const flags = [
        ...(options.net && options.net !== "open" ? [`--net=${options.net}`] : []),
        ...(options.reports ? [`--reports=${options.reports}`] : []),
      ].join(" ");
      await writeFile(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_NODE}" ${flags} "$@"\n`);
      await chmod(path, 0o755);
      return path;
    },
    async install(profile = "analysis") {
      await installPyodide({
        dir: dist,
        profile,
        manifest,
        fetch: async (url) => new Response(body(names.get(String(url)) as string)),
      });
    },
    dispose: () => rm(stateRoot, { recursive: true, force: true }),
  };
}
