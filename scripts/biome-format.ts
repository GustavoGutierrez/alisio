/**
 * Formats files with the workspace Biome in a portable way. `node_modules/.bin/biome` is a shell
 * shim on POSIX and a `.cmd` on Windows (which `execFileSync` cannot spawn directly), so this runs
 * Biome's own JavaScript launcher with the current Node instead.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

export function biomeFormat(files: string[], cwd: string = process.cwd()): void {
  const launcher = createRequire(`${cwd}/package.json`).resolve("@biomejs/biome/bin/biome");
  execFileSync(process.execPath, [launcher, "format", "--write", ...files], {
    cwd,
    stdio: "inherit",
  });
}
