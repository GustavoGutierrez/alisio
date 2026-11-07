/**
 * electron-builder `afterPack` hook: copies build/runtime to `<resources>/runtime`.
 *
 * `extraResources` cannot do this job: it drops every `node_modules` directory, even with an
 * explicit filter, and the host needs its real `node_modules` tree. The tree is flat and holds no symlinks
 * (enforced by prepare-runtime), so it is copied as plain files.
 */
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

export default async function afterPack(context) {
  const source = join(appDir, "build", "runtime");
  if (!existsSync(join(source, "dist", "host.js")))
    throw new Error(
      "build/runtime is missing: run `pnpm --filter @alisio/desktop prepare:runtime`",
    );
  const resources =
    context.electronPlatformName === "darwin"
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
        )
      : join(context.appOutDir, "resources");
  cpSync(source, join(resources, "runtime"), { recursive: true });
}
