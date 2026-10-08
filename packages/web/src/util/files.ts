/** Pure path helpers of the files dock (RF-12): workspace-relative paths and preview kinds. */

/**
 * A tool or Markdown path as a workspace-relative `/` path: absolute paths inside the workspace
 * lose their prefix, `./` and `#fragment`/`:line` suffixes go. Absolute paths elsewhere, URLs
 * and anchors are not workspace files (undefined).
 */
export function workspaceRelative(workspace: string | undefined, path: string): string | undefined {
  let p = path.trim().replace(/\\/g, "/").replace(/#.*$/, "");
  if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("//")) return undefined;
  p = p.replace(/:\d+(:\d+)?$/, "");
  if (p.startsWith("/")) {
    const root = workspace?.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!root) return undefined;
    if (p === root) return "";
    if (!p.startsWith(`${root}/`)) return undefined;
    p = p.slice(root.length + 1);
  }
  const parts: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/** Ancestor directories of a relative path, outermost first (`a/b/c.ts` → `a`, `a/b`). */
export const parentDirs = (path: string): string[] =>
  path
    .split("/")
    .slice(0, -1)
    .map((_, i, parts) => parts.slice(0, i + 1).join("/"));

export const extensionOf = (path: string): string => {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** The file name with its extension, from a `/` path (`a/b/c.ts` → `c.ts`). */
export const fileName = (path: string): string => path.split("/").pop() ?? path;

/** The absolute path of a workspace file, using the workspace's own separator (`/` or `\`). */
export function absolutePath(workspace: string | undefined, path: string): string | undefined {
  if (!workspace) return undefined;
  const separator = workspace.includes("\\") && !workspace.includes("/") ? "\\" : "/";
  const root = workspace.replace(/[\\/]+$/, "");
  const rel = path
    .replace(/^[\\/]+/, "")
    .split("/")
    .filter(Boolean)
    .join(separator);
  return rel ? `${root}${separator}${rel}` : root;
}

export type PreviewKind = "image" | "markdown" | "json" | "code" | "binary" | "pdf" | "html";

/** How the Preview tab shows a file, from the server's sniffed type and the extension. */
export function previewKind(path: string, contentType: string): PreviewKind {
  if (contentType.startsWith("image/")) return "image";
  if (contentType === "application/pdf") return "pdf";
  if (!contentType.startsWith("text/")) return "binary";
  const ext = extensionOf(path);
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "json") return "json";
  return "code";
}
