/**
 * Builds the runtime tree the installers ship under `resources/runtime`: a self-contained
 * `node_modules` (workspace packages with their `dist`, production dependencies only) plus this
 * package's compiled `dist/host.js`. The host and the workers it spawns resolve real files through
 * `import.meta.url`, so the tree stays outside the asar and is produced by `pnpm deploy` rather
 * than bundled or hand-copied.
 *
 * The tree is deployed with the hoisted linker (a flat `node_modules`, no pnpm virtual store), so
 * it holds no symlinks: pnpm's default layout leaves a self-link that escapes the tree, which
 * 7-Zip follows recursively when it builds the NSIS archive, and NSIS cannot reliably recreate
 * symlinks on Windows. The build fails if any symlink remains (see `runtime-tree.ts`).
 *
 * `--legacy` is required: pnpm 10+ refuses to deploy workspace packages unless the whole
 * workspace opts into `inject-workspace-packages`, which would change how every package links.
 *
 * Usage: node --experimental-strip-types scripts/prepare-runtime.ts
 * Prerequisite: `pnpm build` at the repository root (web UI, server and CLI `dist`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSelfContainedRuntime, removeBinDirectories } from "./runtime-tree.ts";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(appDir, "build", "runtime");

function requireFile(path: string, hint: string): void {
  if (!existsSync(path)) throw new Error(`Missing ${path}: ${hint}`);
}

requireFile(join(appDir, "dist", "host.js"), "run `pnpm --filter @alisio/desktop build`.");
requireFile(
  join(appDir, "..", "..", "packages", "server", "dist", "web", "index.html"),
  "run `pnpm build` at the repository root (the server ships the web UI build).",
);

rmSync(target, { recursive: true, force: true });
execFileSync(
  "pnpm",
  [
    "--filter",
    "@alisio/desktop",
    "deploy",
    "--legacy",
    "--prod",
    "--config.node-linker=hoisted",
    target,
  ],
  { cwd: appDir, stdio: "inherit", shell: process.platform === "win32" },
);

// `pnpm deploy --prod` leaves the workspace install state marked as production-only, which makes
// the next `pnpm run` abort asking to purge node_modules. A frozen install restores the state.
execFileSync("pnpm", ["install", "--frozen-lockfile"], {
  cwd: appDir,
  stdio: "inherit",
  env: { ...process.env, CI: "true" },
  shell: process.platform === "win32",
});

requireFile(join(target, "dist", "host.js"), "pnpm deploy did not copy the compiled host.");
requireFile(
  join(target, "node_modules", "@alisio", "server", "dist", "web", "index.html"),
  "pnpm deploy did not include the web UI build.",
);
// `node_modules/.bin` only holds symlink shims for package binaries; the host never runs them.
removeBinDirectories(target);
assertSelfContainedRuntime(target);
console.log(`runtime tree ready at ${target}`);
