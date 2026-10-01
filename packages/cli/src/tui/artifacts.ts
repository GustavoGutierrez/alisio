/**
 * Terminal presentation of artifacts and saved permissions (spec §16): the two-line announcement
 * under a tool, `/artifacts` picker rows, filtering, the actions each artifact offers and the
 * `/permissions` rows. Pure functions; `app.ts` wires them to pickers and the clipboard.
 */
import type { ArtifactKind, ArtifactRef, CapabilityGrantWire, InstallPreview } from "@alisio/sdk";
import { style } from "./theme.ts";

const LABELS: Record<ArtifactKind, string> = {
  dashboard: "Dashboard",
  document: "Document",
  spreadsheet: "Spreadsheet",
  image: "Image",
  data: "Data",
  code: "Text",
  archive: "Archive",
  file: "File",
};
const UNICODE: Record<ArtifactKind, string> = {
  dashboard: "▤",
  document: "¶",
  spreadsheet: "▦",
  image: "◩",
  data: "◇",
  code: "‹›",
  archive: "▣",
  file: "▢",
};
const ASCII: Record<ArtifactKind, string> = {
  dashboard: "[D]",
  document: "[M]",
  spreadsheet: "[T]",
  image: "[I]",
  data: "[J]",
  code: "[C]",
  archive: "[Z]",
  file: "[F]",
};

export const kindLabel = (kind: ArtifactKind): string => LABELS[kind] ?? "File";
export const ARTIFACTS_HINT = "/artifacts to open, copy or reveal";

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `~` for the home folder, then a cut in the MIDDLE so both ends of the path stay visible. */
export function displayPath(path: string, home: string, max: number): string {
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  let shown =
    home && (path === home || path.startsWith(`${home}${sep}`))
      ? `~${path.slice(home.length)}`
      : path;
  const chars = [...shown];
  if (max >= 5 && chars.length > max) {
    const keep = max - 1;
    const head = Math.ceil(keep / 2);
    shown = `${chars.slice(0, head).join("")}…${chars.slice(chars.length - (keep - head)).join("")}`;
  }
  return shown;
}

/**
 * The announcement of one artifact: `▤ Dashboard  name  48 KB` and, below, the real local path
 * (or `[D]`-style ASCII icons when the terminal has no Unicode). Colors come from the theme,
 * which is plain under `NO_COLOR`.
 */
export function artifactLines(
  artifact: ArtifactRef,
  options: { path?: string; width: number; unicode: boolean; home: string },
): string[] {
  const icon =
    (options.unicode ? UNICODE : ASCII)[artifact.kind] ?? (options.unicode ? "▢" : "[F]");
  const status =
    artifact.status !== "ready"
      ? ` ${style.yellow(`(${artifact.status})`)}`
      : artifact.partial
        ? ` ${style.yellow("(partial)")}`
        : "";
  const lines = [
    `  ${style.cyan(icon)} ${style.bold(kindLabel(artifact.kind))}  ${artifact.fileName}  ${style.gray(formatSize(artifact.bytes))}${status}`,
  ];
  if (options.path && artifact.status === "ready")
    lines.push(
      `    ${style.gray(displayPath(options.path, options.home, Math.max(10, options.width - 4)))}`,
    );
  return lines;
}

/** `3 min`, `2 h`, `5 d` (or `now`). */
export function age(createdAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - createdAt) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} d`;
}

/** One `/artifacts` picker row: `Dashboard  sales-dashboard.html  48 KB  4 min`. */
export const artifactRow = (artifact: ArtifactRef, now: number): string =>
  `${kindLabel(artifact.kind).padEnd(11)}  ${artifact.fileName}  ${formatSize(artifact.bytes)}  ${age(artifact.createdAt, now)}${artifact.partial ? "  partial" : ""}${artifact.status === "expired" ? "  Expired" : artifact.status === "deleted" ? "  Deleted" : ""}`;

/** Case-insensitive match of every filter word against name, title and kind label. */
export function matchArtifact(artifact: ArtifactRef, filter: string): boolean {
  const haystack =
    `${artifact.fileName} ${artifact.title} ${kindLabel(artifact.kind)} ${artifact.kind}`.toLowerCase();
  return filter
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

export type ArtifactAction =
  | "preview"
  | "open"
  | "copy"
  | "reveal"
  | "export"
  | "sources"
  | "details"
  | "rerun"
  | "delete";

/** Text-like kinds the terminal previews (Markdown, CSV/TSV, JSON, text/code). */
function previewsHere(artifact: ArtifactRef): boolean {
  const ext = artifact.fileName.toLowerCase().split(".").pop() ?? "";
  return (
    (artifact.kind === "document" && (ext === "md" || ext === "markdown")) ||
    (artifact.kind === "spreadsheet" && (ext === "csv" || ext === "tsv")) ||
    artifact.kind === "data" ||
    artifact.kind === "code"
  );
}

/**
 * The actions of the second `/artifacts` picker, only those that apply: `Preview here` for
 * text-like kinds, `Copy to workspace…` unless `--read-only`, `Reveal analysis sources` for
 * `python_run` outputs and `Rerun` when `python_run` is available. Dashboards, PDFs and images
 * only open with the system app. An expired artifact (its folder was removed by retention) keeps
 * `Details` and `Rerun` (the script and inputs usually remain); a deleted one has no actions.
 */
export function artifactActions(
  artifact: ArtifactRef,
  options: { readOnly?: boolean; sources?: boolean; rerun?: boolean } = {},
): Array<{ value: ArtifactAction; label: string }> {
  if (artifact.status === "deleted") return [];
  const rerun = options.rerun
    ? [{ value: "rerun" as const, label: "Rerun (same script and inputs)" }]
    : [];
  if (artifact.status !== "ready") return [{ value: "details", label: "Details" }, ...rerun];
  return [
    ...(previewsHere(artifact) ? [{ value: "preview" as const, label: "Preview here" }] : []),
    { value: "open", label: "Open with default app" },
    { value: "copy", label: "Copy path" },
    { value: "reveal", label: "Reveal in folder" },
    ...(options.readOnly ? [] : [{ value: "export" as const, label: "Copy to workspace…" }]),
    ...(options.sources ? [{ value: "sources" as const, label: "Reveal analysis sources" }] : []),
    { value: "details", label: "Details" },
    ...rerun,
    { value: "delete", label: "Delete" },
  ];
}

/** `Details` of an artifact (provenance without paths or code), one `label  value` per row. */
export function detailRows(
  artifact: ArtifactRef,
  provenance: Record<string, unknown>,
): Array<[string, string]> {
  const runtime = provenance.runtime as
    | { mode?: string; python?: string; extras?: string[]; engine?: string; image?: string }
    | undefined;
  const inputs = Array.isArray(provenance.inputs)
    ? (provenance.inputs as Array<{ name?: string; sha256?: string }>)
    : [];
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const rows: Array<[string, string | undefined]> = [
    ["Kind", kindLabel(artifact.kind)],
    ["Created", new Date(artifact.createdAt).toLocaleString()],
    [
      "Size",
      `${formatSize(artifact.bytes)}${artifact.fileCount > 1 ? ` · ${artifact.fileCount} files` : ""}`,
    ],
    ["Model", text(provenance.model)],
    ["Provider", text(provenance.provider)],
    [
      "Runtime",
      runtime
        ? [
            runtime.mode,
            runtime.engine,
            runtime.python && `Python ${runtime.python}`,
            runtime.image && runtime.image.replace(/(@sha256:[a-f0-9]{12})[a-f0-9]+$/, "$1…"),
            runtime.extras?.join(", "),
          ]
            .filter(Boolean)
            .join(" · ")
        : undefined,
    ],
    [
      "Inputs",
      inputs.length
        ? inputs.map((i) => `${i.name} (${String(i.sha256 ?? "").slice(0, 12)})`).join(", ")
        : undefined,
    ],
    ["Execution", text(provenance.executionId)],
    ["Rerun of", text(provenance.rerunOf)],
    ["Partial", artifact.partial ? "yes" : undefined],
    [
      "Status",
      artifact.status === "ready"
        ? undefined
        : artifact.status === "expired"
          ? "Expired (files removed by retention)"
          : artifact.status,
    ],
  ];
  return rows.filter((row): row is [string, string] => !!row[1]);
}

const CAPABILITY_LABELS: Record<string, string> = {
  "analysis.run": "Python analysis",
  "analysis.install": "Python packages",
};

/** `HH:MM` local time. */
const clock = (time: number) => {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

/** `Python analysis · allowed for this session · since 10:42 (web)`. */
export const permissionRow = (grant: CapabilityGrantWire): string =>
  `${CAPABILITY_LABELS[grant.capability] ?? grant.capability} · allowed for this session · since ${clock(grant.createdAt)} (${grant.source})`;

/** Title of the `analysis.install` approval (once or deny only). */
export const installApprovalTitle = (install: InstallPreview): string =>
  `Install Python packages (${install.extras}; needs network)?`;

/** Body of the `analysis.install` approval: the packages, the download estimate and the network. */
export function installApprovalDetail(install: InstallPreview): string {
  return [
    `Optional Python packages for this analysis: ${install.packages.join(", ")}`,
    `(+ dependencies: ${install.packageCount} pinned wheels in total).`,
    `Download: about ${formatSize(install.estimatedBytes)}. This needs network access.`,
    "Wheels only, hash-verified, installed into a private environment under Alisio's state folder; nothing is compiled.",
    "This permission is never remembered: it asks every time.",
  ].join("\n");
}

/** Title of a capability approval in the TUI picker. */
export const capabilityApprovalTitle = (runtime: "managed" | "oci" | undefined): string =>
  runtime === "oci"
    ? "Run Python analysis (container · no network)?"
    : "Run Python analysis (managed · not sandboxed)?";
