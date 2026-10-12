/**
 * The local Pyodide distribution (Python spec §8.1, PD7). `installPyodide` is the ONLY code that
 * touches the network for the `wasm` backend (`alisio analysis setup --wasm`): it downloads the
 * files of a profile into a staging folder, verifies the SHA-256 and the size of every one and only
 * then moves them into `<analysis dir>/pyodide/<version>/` and writes the readiness marker. Any
 * mismatch deletes what this run downloaded and throws; a distribution that was complete before
 * stays as it was. `inspectPyodide` is the cheap check the backend does before every run.
 * It never downloads and never reads the hash of a file (`verifyPyodideFiles` does that).
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PYODIDE_MANIFEST,
  PYODIDE_PROFILE_ORDER,
  type PyodideFile,
  type PyodideManifest,
  type PyodideProfile,
} from "./pyodide-manifest.ts";

const MARKER = "ready.json";
/** Staging folders are `.download-<random>`: every run has its own, so runs never touch each other. */
const STAGING = ".download";
const STALE_STAGING_MS = 60 * 60 * 1000;

/** `<state root>/analysis/pyodide/<version>`. */
export const pyodideDir = (stateRoot: string, manifest: PyodideManifest = PYODIDE_MANIFEST) =>
  join(stateRoot, "analysis", "pyodide", manifest.version);

/** The files of a profile: the runtime plus the wheels of its closure, in load order. */
export function profileFiles(
  manifest: PyodideManifest,
  profile: PyodideProfile,
): Array<PyodideFile & { key?: string }> {
  return [
    ...manifest.core,
    ...manifest.profiles[profile].map((key) => {
      const pkg = manifest.packages[key];
      if (!pkg) throw new Error(`manifest lists ${key} in a profile but has no file for it`);
      return { ...pkg, key };
    }),
  ];
}

export const downloadSize = (manifest: PyodideManifest, profile: PyodideProfile): number =>
  profileFiles(manifest, profile).reduce((sum, f) => sum + f.size, 0);

const rank = (profile: PyodideProfile) => PYODIDE_PROFILE_ORDER.indexOf(profile);

interface Marker {
  version: string;
  profile: PyodideProfile;
  files: Record<string, number>;
}

export type PyodideInspection =
  | { ok: true; dir: string; profile: PyodideProfile }
  | { ok: false; reason: string };

/** Is the distribution there, complete for what it claims, and of this manifest's version? */
export async function inspectPyodide(
  dir: string,
  manifest: PyodideManifest = PYODIDE_MANIFEST,
): Promise<PyodideInspection> {
  let marker: Marker;
  try {
    marker = JSON.parse(await readFile(join(dir, MARKER), "utf8")) as Marker;
  } catch {
    return { ok: false, reason: "Pyodide is not installed" };
  }
  if (marker.version !== manifest.version || !(marker.profile in manifest.profiles))
    return { ok: false, reason: `the installed Pyodide is not ${manifest.version}` };
  for (const file of profileFiles(manifest, marker.profile)) {
    const info = await stat(join(dir, file.name)).catch(() => undefined);
    if (!info?.isFile() || info.size !== file.size)
      return { ok: false, reason: `Pyodide file ${file.name} is missing or damaged` };
  }
  return { ok: true, dir, profile: marker.profile };
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Hashes the given files of an installation; returns the first that does not match its pin. */
export async function verifyPyodideFiles(
  dir: string,
  files: readonly PyodideFile[],
): Promise<string | undefined> {
  for (const file of files) {
    const actual = await sha256OfFile(join(dir, file.name)).catch(() => undefined);
    if (actual !== file.sha256) return file.name;
  }
  return undefined;
}

export interface InstallPyodideOptions {
  /** `<state root>/analysis/pyodide/<version>`. */
  dir: string;
  profile: PyodideProfile;
  manifest?: PyodideManifest;
  /** Replaceable in tests; the global `fetch` otherwise. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (event: { file: string; index: number; total: number }) => void;
}

/** A download whose bytes are not the pinned ones. Nothing from it is kept. */
export class PyodideIntegrityError extends Error {
  readonly file: string;
  constructor(file: string, message: string) {
    super(message);
    this.name = "PyodideIntegrityError";
    this.file = file;
  }
}

async function download(
  file: PyodideFile,
  target: string,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<void> {
  const response = await fetcher(file.url, { ...(signal ? { signal } : {}) });
  if (!response.ok || !response.body)
    throw new Error(`download of ${file.name} failed: HTTP ${response.status} from ${file.url}`);
  const hash = createHash("sha256");
  let size = 0;
  const handle = await open(target, "w", 0o600);
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      // A server that sends more than was pinned is stopped before it fills the disk.
      if (size > file.size)
        throw new PyodideIntegrityError(
          file.name,
          `${file.name} is larger than the pinned ${file.size} bytes`,
        );
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
  if (size !== file.size)
    throw new PyodideIntegrityError(
      file.name,
      `${file.name} is ${size} bytes, the pin says ${file.size}`,
    );
  if (hash.digest("hex") !== file.sha256)
    throw new PyodideIntegrityError(file.name, `${file.name} does not match its pinned SHA-256`);
}

/** Downloads, verifies and installs the profile. Throws on any failure, leaving no partial files. */
export async function installPyodide(options: InstallPyodideOptions): Promise<PyodideInspection> {
  const manifest = options.manifest ?? PYODIDE_MANIFEST;
  const fetcher = options.fetch ?? fetch;
  const { dir } = options;
  const readMarker = () =>
    readFile(join(dir, MARKER), "utf8")
      .then((text) => JSON.parse(text) as Marker)
      .catch(() => undefined);
  const previous = await readMarker();
  await mkdir(dir, { recursive: true });
  // Leftovers of a run that was killed, long gone by now; a live run's folder is far younger.
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith(`${STAGING}-`)) continue;
    const info = await stat(join(dir, name)).catch(() => undefined);
    if (info && Date.now() - info.mtimeMs > STALE_STAGING_MS)
      await rm(join(dir, name), { recursive: true, force: true });
  }
  const staging = join(dir, `${STAGING}-${randomBytes(6).toString("hex")}`);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const files = profileFiles(manifest, options.profile);
  try {
    let index = 0;
    for (const file of files) {
      options.signal?.throwIfAborted();
      index++;
      // A file that an earlier install put there and still hashes right is kept.
      const present = await sha256OfFile(join(dir, file.name)).catch(() => undefined);
      if (present === file.sha256) continue;
      options.onProgress?.({ file: file.name, index, total: files.length });
      await download(file, join(staging, file.name), fetcher, options.signal);
    }
    for (const file of files) {
      const staged = join(staging, file.name);
      if (await stat(staged).catch(() => undefined)) await rename(staged, join(dir, file.name));
    }
    // Never downgrade a larger installation that is still there (read again: another run may
    // have finished a larger one while this one downloaded).
    const current = await readMarker();
    const keep =
      current &&
      current.version === manifest.version &&
      rank(current.profile) > rank(options.profile)
        ? current.profile
        : options.profile;
    const marker: Marker = {
      version: manifest.version,
      profile: keep,
      files: Object.fromEntries(profileFiles(manifest, keep).map((f) => [f.name, f.size])),
    };
    const temporaryMarker = join(dir, `${MARKER}.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(temporaryMarker, `${JSON.stringify(marker)}\n`);
    await rename(temporaryMarker, join(dir, MARKER));
    return { ok: true, dir, profile: keep };
  } catch (error) {
    // Nothing of this run stays; a distribution that was complete before is untouched.
    if (!previous && !(await readMarker())) await rm(dir, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
