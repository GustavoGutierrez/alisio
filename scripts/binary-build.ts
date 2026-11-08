/**
 * Builds the standalone Bun binary with the CLI package version injected at build
 * time (ALISIO_PACKAGE_VERSION), so `--version` matches the published package.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { embeddedModuleSource } from "../packages/core/src/documents/embedded.ts";

const root = resolve(import.meta.dirname ?? ".", "..");
const manifest = JSON.parse(
  readFileSync(join(root, "packages", "cli", "package.json"), "utf8"),
) as { version?: string };
const version = JSON.stringify(manifest.version ?? "0.0.0");
execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
// Document themes and fonts travel inside the binary (spec 026 D-28): the compiled stub module is
// replaced by one carrying them for the `bun build` only, then restored so packing stays clean.
const stub = join(root, "packages", "core", "dist", "documents", "embedded-assets.js");
const original = readFileSync(stub, "utf8");
writeFileSync(
  stub,
  await embeddedModuleSource(join(root, "packages", "core", "assets", "documents")),
);
try {
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
} finally {
  writeFileSync(stub, original);
}
