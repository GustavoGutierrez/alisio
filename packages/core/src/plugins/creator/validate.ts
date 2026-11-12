/**
 * Static validation of a creator project against the generated-plugin contract: an ESM package
 * whose only dependency is the `@alisio/sdk` peer, no install scripts, an entry inside the packed
 * files, tests, bounded size, no symlinks, and no runtime imports beyond relative files and Node
 * built-ins. Nothing is executed here (the build's probe checks the exported plugin object).
 */

import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, join, posix } from "node:path";
import type { PluginCreatorIssue, PluginCreatorSchema } from "@alisio/sdk";
import { PLUGIN_KEYWORD } from "../../runtime/modules.ts";
import { parsePluginSpec } from "../install.ts";
import { comparePluginVersions, satisfiesRange } from "../version-compat.ts";
import { type ProjectWalk, walkProject } from "./files.ts";
import { detectSchema } from "./schema.ts";
import { PLUGIN_CREATOR_LIMITS } from "./types.ts";

export interface ProjectValidation {
  ok: boolean;
  issues: PluginCreatorIssue[];
  schema: PluginCreatorSchema;
  walk: ProjectWalk;
  manifest?: Record<string, unknown>;
  /** Project-relative entry file, when it resolves. */
  entry?: string;
  /** Project-relative `*.test.js` files. */
  tests: string[];
}

const LIFECYCLE = ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepack"];
const SOURCE = /\.(?:m|c)?js$/;
export const TEST_FILE = /^test\/(?:.+\/)?[^/]+\.test\.(?:m|c)?js$/;

/** Removes comments (JSDoc `import("…")` types are not runtime imports). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const SPECIFIERS = [
  /\bimport\s+(?:[\w*{}\s,]+?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s+)?from\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/** Module specifiers a source file loads at runtime. */
export function importsOf(text: string): string[] {
  const code = stripComments(text);
  const found = new Set<string>();
  for (const pattern of SPECIFIERS) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(code); m; m = pattern.exec(code)) if (m[1]) found.add(m[1]);
  }
  return [...found];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function entryOf(pkg: Record<string, unknown>): string | undefined {
  const exports = pkg.exports;
  if (typeof exports === "string") return exports;
  if (isObject(exports)) {
    const dot = exports["."] ?? exports;
    if (typeof dot === "string") return dot;
    if (isObject(dot)) {
      const value = dot.import ?? dot.default;
      if (typeof value === "string") return value;
    }
  }
  return typeof pkg.main === "string" ? pkg.main : undefined;
}

/** Size caps of the images, as the host reads them (package icon 256 KB, catalog cover 512 KB). */
export const ASSET_LIMITS = { icon: 256 * 1024, cover: 512 * 1024 } as const;
const IMAGE_EXT = /\.(svg|png|webp|jpe?g)$/i;

/** The image type of `bytes` (by content, never by extension), as the host sniffs it. */
export function sniffImage(bytes: Buffer): "svg" | "png" | "webp" | "jpeg" | undefined {
  if (
    bytes.length >= 12 &&
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  )
    return "webp";
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (/<svg[\s>]/i.test(bytes.toString("utf8", 0, Math.min(bytes.length, 4096)))) return "svg";
  return undefined;
}

/**
 * Why an SVG is unsafe or not self-contained, or undefined. Refused: scripts, event handler
 * attributes, `foreignObject`, embedded `<image>`, any `href` that is not a `#fragment`, and
 * `url(...)`/`@import` that point anywhere but `#fragment`.
 */
export function svgProblem(text: string): string | undefined {
  if (/<script[\s>/]/i.test(text)) return "it contains a script";
  if (/<foreignObject[\s>/]/i.test(text)) return "it contains foreignObject";
  if (/<image[\s>/]/i.test(text)) return "it embeds an image";
  if (/\son[a-z]+\s*=/i.test(text)) return "it has an event handler attribute";
  for (const match of text.matchAll(/\b(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi))
    if (!(match[1] ?? "").trim().startsWith("#")) return "it links to an outside resource";
  for (const match of text.matchAll(/url\(\s*["']?([^)"']*)/gi))
    if (!(match[1] ?? "").trim().startsWith("#")) return "it loads an outside resource";
  if (/@import/i.test(text)) return "it imports a stylesheet";
  if (/<!ENTITY/i.test(text)) return "it declares XML entities";
  return undefined;
}

async function checkAssets(
  dir: string,
  manifest: Record<string, unknown>,
  walk: ProjectWalk,
  error: (code: string, message: string, file?: string) => void,
  warn: (code: string, message: string, file?: string) => void,
): Promise<void> {
  const alisio = isObject(manifest.alisio) ? manifest.alisio : {};
  const files = Array.isArray(manifest.files)
    ? manifest.files.filter((f): f is string => typeof f === "string")
    : ["src"];
  for (const kind of ["icon", "cover"] as const) {
    const declared = alisio[kind];
    if (declared === undefined) {
      warn(`${kind}_missing`, `Add an ${kind} image (package.json alisio.${kind})`, "package.json");
      continue;
    }
    const rel = typeof declared === "string" ? posix.normalize(declared.replace(/^\.\//, "")) : "";
    if (!rel || rel.startsWith("..") || posix.isAbsolute(rel) || rel.includes("\0")) {
      error("asset_outside", `The ${kind} must be a file inside the plugin`, "package.json");
      continue;
    }
    if (!IMAGE_EXT.test(rel)) {
      error("asset_format", `The ${kind} must be an .svg, .png, .webp or .jpg file`, rel);
      continue;
    }
    const file = walk.files.find((f) => f.path === rel);
    if (!file) {
      error("asset_missing", `The ${kind} file ${rel} does not exist`, rel);
      continue;
    }
    const packed = files.some((f) => {
      const base = posix.normalize(f.replace(/^\.\//, "")).replace(/\/+$/, "");
      return rel === base || rel.startsWith(`${base}/`);
    });
    if (!packed) error("asset_not_packed", `The ${kind} must be listed in "files"`, "package.json");
    if (file.bytes > ASSET_LIMITS[kind]) {
      error("asset_too_large", `The ${kind} is larger than ${ASSET_LIMITS[kind] / 1024} KB`, rel);
      continue;
    }
    const bytes = await readFile(join(dir, rel)).catch(() => Buffer.alloc(0));
    const type = sniffImage(bytes);
    if (!type) {
      error("asset_format", `The ${kind} is not an SVG, PNG, WebP or JPEG image`, rel);
      continue;
    }
    if (type === "svg") {
      const problem = svgProblem(bytes.toString("utf8"));
      if (problem) error("svg_unsafe", `The ${kind} SVG is not allowed: ${problem}`, rel);
    }
  }
}

export interface ValidateOptions {
  /** Version of the `@alisio/sdk` this Alisio runs; the peer range must accept it. */
  sdkVersion?: string;
  /** Node version that runs plugins (default: this process's). */
  nodeVersion?: string;
}

/** Marker comment of the scaffold's example tool (a warning while it is still there). */
export const TEMPLATE_EXAMPLE_MARKER = "alisio-creator:example";

export async function validateProject(
  dir: string,
  options: ValidateOptions = {},
): Promise<ProjectValidation> {
  const issues: PluginCreatorIssue[] = [];
  const error = (code: string, message: string, file?: string) =>
    issues.push({ code, severity: "error", message, ...(file ? { file } : {}) });
  const warn = (code: string, message: string, file?: string) =>
    issues.push({ code, severity: "warning", message, ...(file ? { file } : {}) });
  const walk = await walkProject(dir);
  const tests = walk.files.map((f) => f.path).filter((p) => TEST_FILE.test(p));

  if (walk.truncated)
    error("too_many_files", `The plugin has more than ${PLUGIN_CREATOR_LIMITS.maxFiles} files`);
  if (walk.bytes > PLUGIN_CREATOR_LIMITS.maxProjectBytes)
    error("project_too_large", "The plugin is larger than 5 MB");
  for (const file of walk.files)
    if (file.bytes > PLUGIN_CREATOR_LIMITS.maxFileBytes)
      error("file_too_large", "This file is larger than 1 MB", file.path);
  for (const link of walk.symlinks)
    error("symlink_forbidden", "Symbolic links are not allowed in a plugin", link);

  let manifest: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    if (isObject(parsed)) manifest = parsed;
    else error("package_json_invalid", "package.json must be a JSON object", "package.json");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      error("package_json_missing", "package.json is missing");
    else error("package_json_invalid", "package.json is not valid JSON", "package.json");
  }

  let entry: string | undefined;
  if (manifest) {
    const pkg = manifest;
    const name = typeof pkg.name === "string" ? pkg.name : "";
    let nameOk = false;
    try {
      const parsed = parsePluginSpec(name);
      nameOk = parsed.version === undefined && parsed.name === name;
    } catch {
      nameOk = false;
    }
    if (!nameOk) error("name_invalid", "The package name is not a valid npm name", "package.json");
    else if (name.startsWith("@alisio/"))
      error("name_reserved", "The @alisio scope is reserved for official plugins", "package.json");
    const version = typeof pkg.version === "string" ? pkg.version : "";
    if (comparePluginVersions(version, version) === undefined)
      error("version_invalid", "The version must look like 1.2.3", "package.json");
    if (pkg.type !== "module")
      error("type_not_module", 'package.json must set "type": "module"', "package.json");
    if (!(Array.isArray(pkg.keywords) && pkg.keywords.includes(PLUGIN_KEYWORD)))
      error("keyword_missing", `keywords must include "${PLUGIN_KEYWORD}"`, "package.json");
    if (typeof pkg.description !== "string" || !pkg.description.trim())
      warn("description_missing", "Add a one-sentence description", "package.json");
    for (const key of ["dependencies", "optionalDependencies", "bundleDependencies"])
      if (
        (isObject(pkg[key]) && Object.keys(pkg[key]).length > 0) ||
        (Array.isArray(pkg[key]) && (pkg[key] as unknown[]).length > 0)
      )
        error(
          "dependencies_forbidden",
          `"${key}" must be empty: the plugin may use only Node built-ins`,
          "package.json",
        );
    const peers = isObject(pkg.peerDependencies) ? pkg.peerDependencies : {};
    if (typeof peers["@alisio/sdk"] !== "string")
      error("peer_sdk_missing", 'peerDependencies must declare "@alisio/sdk"', "package.json");
    if (Object.keys(peers).some((peer) => peer !== "@alisio/sdk"))
      error("peer_extra", 'Only "@alisio/sdk" may be a peer dependency', "package.json");
    const range = peers["@alisio/sdk"];
    if (
      typeof range === "string" &&
      options.sdkVersion &&
      !satisfiesRange(options.sdkVersion, range)
    )
      error(
        "sdk_incompatible",
        `The @alisio/sdk range ${range} does not accept the installed SDK ${options.sdkVersion}`,
        "package.json",
      );
    const engines = isObject(pkg.engines) ? pkg.engines : {};
    const nodeVersion = options.nodeVersion ?? process.versions.node;
    if (typeof engines.node === "string" && !satisfiesRange(nodeVersion, engines.node))
      error(
        "engine_unsupported",
        `engines.node ${engines.node} does not accept the Node.js that runs plugins (${nodeVersion})`,
        "package.json",
      );
    for (const key of Object.keys(engines))
      if (key !== "node")
        warn("engine_unknown", `Alisio ignores engines.${key}: remove it`, "package.json");
    const scripts = isObject(pkg.scripts) ? pkg.scripts : {};
    if (LIFECYCLE.some((key) => key in scripts))
      error(
        "lifecycle_scripts_forbidden",
        "Install scripts (preinstall, install, postinstall, prepare) are not allowed",
        "package.json",
      );
    const raw = entryOf(pkg);
    const normalized = raw ? posix.normalize(raw.replace(/^\.\//, "")) : undefined;
    if (!normalized) error("entry_missing", 'package.json needs "exports" or "main"');
    else if (normalized.startsWith("..") || posix.isAbsolute(normalized))
      error("entry_outside", "The entry file must be inside the plugin", "package.json");
    else if (!walk.files.some((f) => f.path === normalized))
      error("entry_missing", `The entry file ${normalized} does not exist`, "package.json");
    else {
      entry = normalized;
      const files = Array.isArray(pkg.files)
        ? pkg.files.filter((f): f is string => typeof f === "string")
        : ["src"];
      const packed = files.some((f) => {
        const base = posix.normalize(f.replace(/^\.\//, "")).replace(/\/+$/, "");
        return normalized === base || normalized.startsWith(`${base}/`);
      });
      if (!packed)
        error("entry_not_packed", 'The entry file must be listed in "files"', "package.json");
    }
  }
  if (manifest) await checkAssets(dir, manifest, walk, error, warn);
  if (!tests.length)
    error("tests_missing", "Add at least one test file: test/<name>.test.js", "test");

  const sources: string[] = [];
  /** Relative imports of each src file (for the reachability check). */
  const graph = new Map<string, string[]>();
  for (const file of walk.files) {
    if (!SOURCE.test(file.path) || file.bytes > PLUGIN_CREATOR_LIMITS.maxFileBytes) continue;
    const text = await readFile(join(dir, file.path), "utf8").catch(() => "");
    if (file.path.startsWith("src/")) {
      sources.push(text);
      graph.set(file.path, []);
      if (!stripComments(text).trim())
        warn("empty_file", "This file has no code: delete it or use it", file.path);
      if (text.includes(TEMPLATE_EXAMPLE_MARKER))
        warn(
          "template_example",
          "The example tool of the template is still there: replace it with what was asked",
          file.path,
        );
    }
    for (const specifier of importsOf(text)) {
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const target = posix.normalize(posix.join(posix.dirname(file.path), specifier));
        graph.get(file.path)?.push(target);
        if (target.startsWith("..") || dirname(join(dir, target)).length < dir.length)
          error("forbidden_import", `Imports must stay inside the plugin: ${specifier}`, file.path);
        continue;
      }
      if (specifier.startsWith("node:") || isBuiltin(specifier)) continue;
      error(
        "forbidden_import",
        specifier.startsWith("@alisio/")
          ? `Do not import ${specifier} at runtime: use JSDoc types and the api object instead`
          : `Packages cannot be used (${specifier}): write the code with Node built-ins`,
        file.path,
      );
    }
  }
  // Dead weight: src files the entry never reaches (directly or through other files).
  if (entry && graph.has(entry)) {
    const reached = new Set<string>([entry]);
    const queue = [entry];
    while (queue.length) {
      for (const next of graph.get(queue.shift() as string) ?? [])
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
    }
    for (const path of graph.keys())
      if (!reached.has(path) && !issues.some((i) => i.code === "empty_file" && i.file === path))
        warn("unused_file", "Nothing uses this file: delete it", path);
  }
  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    issues,
    schema: detectSchema(sources),
    walk,
    ...(manifest ? { manifest } : {}),
    ...(entry ? { entry } : {}),
    tests,
  };
}
