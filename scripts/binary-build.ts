/**
 * Builds the standalone Bun binary with the CLI package version injected at build
 * time (ALISIO_PACKAGE_VERSION), so `--version` matches the published package.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname ?? ".", "..");
const manifest = JSON.parse(
  readFileSync(join(root, "packages", "cli", "package.json"), "utf8"),
) as { version?: string };
const version = JSON.stringify(manifest.version ?? "0.0.0");
execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
execFileSync(
  "bun",
  [
    "build",
    "packages/cli/dist/main.js",
    "--compile",
    "--outfile",
    "dist/alisio",
    "--define",
    `process.env.ALISIO_PACKAGE_VERSION=${version}`,
  ],
  { cwd: root, stdio: "inherit" },
);
