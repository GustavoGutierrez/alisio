/**
 * Checks that every package of the optional Python extras (the hashed lockfiles of
 * `packages/core/src/analysis/requirements.ts`) has a wheel for a platform, with no compilation:
 * `pip download --only-binary=:all: --require-hashes` for the tags of that platform (spec §21,
 * phase 4, portability). It downloads about 70 MB (`analysis`) or 130 MB (`science`) per run.
 *
 * Usage:
 *   node --experimental-strip-types scripts/analysis-extras-wheels.ts \
 *     --platform linux-x64|linux-arm64|linux-musl-x64|macos-x64|macos-arm64|windows-x64|windows-arm64 \
 *     [--extras analysis|science|both] [--python python3]
 *
 * pip evaluates the environment markers of the lockfile with the interpreter that runs it, so use
 * the Python version you want to check (the platform tags follow it).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTRAS_LOCK } from "../packages/core/src/analysis/requirements.ts";

/** pip `--platform` tags per target; several are given because wheels use many manylinux tags. */
const PLATFORMS: Record<string, string[]> = {
  "linux-x64": [
    "manylinux_2_28_x86_64",
    "manylinux_2_17_x86_64",
    "manylinux2014_x86_64",
    "manylinux_2_12_x86_64",
    "manylinux2010_x86_64",
    "linux_x86_64",
  ],
  "linux-arm64": [
    "manylinux_2_28_aarch64",
    "manylinux_2_17_aarch64",
    "manylinux2014_aarch64",
    "linux_aarch64",
  ],
  "linux-musl-x64": ["musllinux_1_2_x86_64", "musllinux_1_1_x86_64"],
  "macos-x64": [
    "macosx_14_0_x86_64",
    "macosx_12_0_x86_64",
    "macosx_11_0_x86_64",
    "macosx_10_13_x86_64",
    "macosx_10_9_x86_64",
  ],
  "macos-arm64": ["macosx_14_0_arm64", "macosx_12_0_arm64", "macosx_11_0_arm64"],
  "windows-x64": ["win_amd64"],
  "windows-arm64": ["win_arm64"],
};

function argument(name: string, fallback?: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const platform = argument("platform");
const tags = platform ? PLATFORMS[platform] : undefined;
if (!platform || !tags) {
  console.error(`--platform must be one of: ${Object.keys(PLATFORMS).join(", ")}`);
  process.exit(2);
}
const python = argument("python", "python3") as string;
const which = argument("extras", "both");
const sets =
  which === "both" ? (["analysis", "science"] as const) : [which as "analysis" | "science"];
if (sets.some((set) => !(set in EXTRAS_LOCK))) {
  console.error("--extras must be analysis, science or both");
  process.exit(2);
}
const probe = spawnSync(python, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], {
  encoding: "utf8",
});
if (probe.status !== 0) {
  console.error(`Cannot run ${python}`);
  process.exit(2);
}
const version = probe.stdout.trim();
const directory = mkdtempSync(join(tmpdir(), "alisio-wheels-"));
let failed = false;
try {
  for (const set of sets) {
    const lock = join(directory, `${set}.txt`);
    writeFileSync(lock, EXTRAS_LOCK[set]);
    const out = join(directory, `wheels-${set}`);
    const result = spawnSync(
      python,
      [
        "-m",
        "pip",
        "download",
        "--only-binary=:all:",
        "--require-hashes",
        "--no-deps",
        "--disable-pip-version-check",
        "--python-version",
        version,
        "--implementation",
        "cp",
        "--abi",
        `cp${version.replace(".", "")}`,
        "--abi",
        "abi3",
        "--abi",
        "none",
        ...tags.flatMap((tag) => ["--platform", tag]),
        "-d",
        out,
        "-r",
        lock,
      ],
      { encoding: "utf8" },
    );
    if (result.status === 0) console.log(`ok   ${set} · Python ${version} · ${platform}`);
    else {
      failed = true;
      console.log(`FAIL ${set} · Python ${version} · ${platform}`);
      console.log(`${result.stdout}${result.stderr}`.split("\n").slice(-12).join("\n"));
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
