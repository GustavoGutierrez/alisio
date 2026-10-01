/**
 * `artifact_read` (effect `read`) and `artifact_export` (effect `write`), spec §12. Reading is
 * bounded (64 KiB, truncation marked); exporting copies a published artifact into the workspace,
 * confined to it, through the existing `write` gate. Both only see the caller's root session.
 */
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { ToolResult } from "@alisio/sdk";
import { KIND_LABELS, looksLikeText } from "../artifacts/kinds.ts";
import { type ArtifactRecord, type ArtifactStore, readHead } from "../artifacts/store.ts";
import type { ToolRegistry } from "../core/registry.ts";
import { safePath } from "../runtime/paths.ts";
import { objectSchema } from "./standard.ts";

export const ARTIFACT_READ_MAX = 64 * 1024;
const EXPORTED = "exported ";

export interface ArtifactToolDeps {
  store: ArtifactStore;
  rootOf: (sessionId: string) => string;
}

/** A ready artifact of the caller's root session, or a model-readable error. */
function ownArtifact(deps: ArtifactToolDeps, id: unknown, session?: string): ArtifactRecord {
  const record = typeof id === "string" ? deps.store.get(id) : undefined;
  if (!record || record.sessionId !== deps.rootOf(session ?? ""))
    throw new Error(`Artifact ${String(id)} not found in this session (see artifact_list)`);
  if (record.status !== "ready") throw new Error(`Artifact ${record.id} is ${record.status}`);
  return record;
}

/**
 * Workspace-relative paths an `artifact_export` result reports, in order (the Changes view of the
 * web reads them; the first line of the text names the artifact and the target).
 */
export function exportedPaths(result: ToolResult | undefined): string[] {
  if (!result || result.isError) return [];
  const text = result.content.find((part) => part.type === "text");
  if (!text || text.type !== "text" || !text.text.startsWith(EXPORTED)) return [];
  return text.text
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);
}

const toPosix = (path: string) => path.split(sep).join("/");

export function registerArtifactTools(registry: ToolRegistry, deps: ArtifactToolDeps): void {
  registry.register({
    name: "artifact_read",
    effect: "read",
    description:
      "Read a published text artifact of this session (Markdown, CSV, JSON, HTML, code…), at " +
      "most 64 KiB; longer files are truncated and say so. path selects one file inside a " +
      "multi-file artifact (default: its entry).",
    inputSchema: objectSchema(
      {
        id: { type: "string", minLength: 1, maxLength: 64 },
        path: { type: "string", minLength: 1, maxLength: 512 },
        maxBytes: { type: "integer", minimum: 1, maximum: ARTIFACT_READ_MAX },
      },
      ["id"],
    ),
    async execute(input, context) {
      const record = ownArtifact(deps, input.id, context.session);
      const wanted =
        typeof input.path === "string" ? input.path : (record.entry ?? record.fileName);
      const file = await deps.store.resolveFile(record, wanted);
      if (!file)
        throw new Error(
          `${wanted} is not a file of ${record.id}; files: ${(await deps.store.files(record))
            .map((f) => f.path)
            .slice(0, 50)
            .join(", ")}`,
        );
      if (!looksLikeText(await readHead(file.abs)))
        throw new Error(`${file.path} is not a text file; download it instead`);
      const max = Math.min(Number(input.maxBytes ?? ARTIFACT_READ_MAX), ARTIFACT_READ_MAX);
      const handle = await open(file.abs, "r");
      let text: string;
      try {
        const buffer = Buffer.alloc(Math.min(max, file.bytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        // A multi-byte character cut at the limit decodes as U+FFFD: drop it.
        text = buffer.subarray(0, bytesRead).toString("utf8").replace(/�+$/, "");
      } finally {
        await handle.close();
      }
      const truncated = file.bytes > max;
      return {
        content: [
          {
            type: "text",
            text: [
              `${record.id} · ${KIND_LABELS[record.kind]} · ${file.path} · ${file.bytes} bytes`,
              text,
              ...(truncated ? [`[truncated: showing ${max} of ${file.bytes} bytes]`] : []),
            ].join("\n"),
          },
        ],
      };
    },
  });

  registry.register({
    name: "artifact_export",
    effect: "write",
    description:
      "Copy a published artifact of this session into the workspace (target: a workspace-" +
      "relative directory; '.' is the root). A multi-file artifact becomes a folder named after " +
      "it. Existing files are kept unless overwrite is true.",
    inputSchema: objectSchema(
      {
        id: { type: "string", minLength: 1, maxLength: 64 },
        target: { type: "string", maxLength: 1024 },
        overwrite: { type: "boolean" },
      },
      ["id", "target"],
    ),
    async execute(input, context) {
      const record = ownArtifact(deps, input.id, context.session);
      const workspace = await realpath(context.workspace);
      // `\` and `/` are both separators (Windows users type either).
      const target = String(input.target).replace(/\\/g, "/").trim() || ".";
      const directory = await safePath(workspace, target);
      const files = await deps.store.files(record);
      const folder =
        files.length > 1 ? record.fileName.replace(/\.zip$/i, "") || record.id : undefined;
      const plan: Array<{ from: string; to: string }> = [];
      for (const file of files) {
        const parts = files.length > 1 ? file.path.split("/") : [record.fileName];
        // Every destination is confined again (no symlinked component, never outside).
        const to = await safePath(
          workspace,
          join(directory, ...(folder ? [folder] : []), ...parts),
        );
        plan.push({ from: file.abs, to });
      }
      const overwrite = input.overwrite === true;
      if (!overwrite)
        for (const { to } of plan) {
          const existing = await lstat(to).catch(() => undefined);
          if (existing)
            throw new Error(
              `${toPosix(relative(workspace, to))} already exists; pass overwrite: true to replace it`,
            );
        }
      const written: string[] = [];
      for (const { from, to } of plan) {
        await mkdir(dirname(to), { recursive: true });
        await copyFile(from, to, overwrite ? 0 : constants.COPYFILE_EXCL);
        written.push(toPosix(relative(workspace, to)));
      }
      return {
        content: [
          {
            type: "text",
            text: [
              `${EXPORTED}${record.fileName} (${record.id}) to ${toPosix(relative(workspace, directory)) || "."}:`,
              ...written,
            ].join("\n"),
          },
        ],
      };
    },
  });
}
