/**
 * Copies the @alisio/web build into dist/web (served by the static handler). Stale assets are
 * removed first; without a web build the server serves its placeholder page.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "..", "web", "dist");
const target = join(root, "dist", "web");
rmSync(target, { recursive: true, force: true });
if (existsSync(join(source, "index.html"))) {
  cpSync(source, target, { recursive: true });
  console.log(`copied web UI build to ${target}`);
} else console.warn("web UI build not found; the server will serve its placeholder page");
