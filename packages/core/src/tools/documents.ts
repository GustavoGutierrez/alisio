/**
 * `document_create` (effect `internal`) and `document_themes` (effect `read`), spec 026 §5.1.
 * The model writes content (Markdown or a DocumentSpec) and picks a catalog theme; Alisio owns
 * presentation. The tool writes only to Alisio's artifact store and runs a fixed renderer.
 */
import type { ToolContext, ToolResult } from "@alisio/sdk";
import type { CoreArtifactPublisher } from "../core/contracts.ts";
import type { ToolRegistry } from "../core/registry.ts";
import { type CreateDeps, createDocument, EngineUnavailable } from "../documents/create.ts";
import { DOCUMENT_LIMITS, DocumentError } from "../documents/limits.ts";
import type { DocumentEngine, PageSize } from "../documents/ports.ts";
import { RenderQueue } from "../documents/queue.ts";
import { loadCatalog } from "../documents/themes.ts";
import { artifactBlocks } from "./artifact-blocks.ts";
import { objectSchema } from "./standard.ts";

export interface DocumentToolDeps {
  tmpRoot: string;
  engines: () => DocumentEngine[];
  settings: () => { engine: "auto" | "chromium" | "weasyprint"; defaultPageSize: PageSize };
  trusted: () => boolean;
  /** Bytes of an artifact owned by the calling session, or undefined. */
  readArtifact?: (sessionId: string, id: string) => Promise<Uint8Array | undefined>;
  queue?: RenderQueue;
}

const BLOCKS_GUIDE = `Blocks (type: fields): cover (title, subtitle?, meta?[<=6], imageAsset?), heading (level 1-3, text), paragraph (text), bullets (items[], ordered?; nested {text, items[]}), table (columns[{label, align?, width?}], rows[][], caption?), image (asset, caption?, size?), quote (text, attribution?), callout (tone info|success|warning|danger, title?, text), code (text, language?), stat_grid (items[{label, value, delta?, tone?}] 2-8), page_break, toc (depth?). Text fields take Markdown inline only (**bold**, *italic*, \`code\`, [link](https://...)); never HTML. One cover (first) and one toc at most.`;

function failure(error: unknown): ToolResult {
  if (error instanceof DocumentError)
    return { content: [{ type: "text", text: `${error.code}: ${error.message}` }], isError: true };
  throw error;
}

export function registerDocumentTools(registry: ToolRegistry, deps: DocumentToolDeps): void {
  const queue = deps.queue ?? new RenderQueue();

  registry.register({
    name: "document_themes",
    effect: "read",
    description:
      "List the print themes, the DocumentSpec blocks and the active PDF engine. Call it before document_create.",
    inputSchema: objectSchema({}, []),
    async execute(_input, context): Promise<ToolResult> {
      const catalog = await loadCatalog();
      const engines = await Promise.all(
        deps.engines().map(async (e) => ({ id: e.id, r: await e.readiness(context.signal) })),
      );
      const lines = [
        "Themes:",
        ...catalog.map((t) => `- ${t.id}: ${t.purpose} Pages: ${t.pageSizes.join(", ")}.`),
        "",
        BLOCKS_GUIDE,
        "",
        "Markdown works too: without front matter the first # heading becomes the cover title and bold **Key:** value lines under it the cover details; # headings (h4+ become level 3), lists, GFM tables, > quotes, ```code```, ![alt](relative/image.png), > [!NOTE] callouts, ---pagebreak--- line, [TOC], and front matter (title, subtitle, author, date, theme, toc: true; a title adds a cover).",
        'Brand colors: theme {id, accent: "#1d4f91", ink} (low-contrast colors are darkened with a warning); cover:false removes the cover. Images are workspace files or artifacts, declared in `assets` as {id, path|artifactId} and used as `asset: id`. Remote images are never fetched.',
        "",
        engines.length
          ? `Engine: ${engines.map((e) => (e.r.ready ? `${e.id} ready (${e.r.version})` : `${e.id} not ready (${e.r.reason})`)).join("; ")}`
          : "Engine: none registered",
        "Rules: content only, no HTML or CSS. quality professional (default) checks the layout and repairs it up to 2 times; fast only checks.",
        "Limits: Latin, Greek and Cyrillic text; emoji are removed; contents entries are links without page numbers.",
      ];
      return { content: [{ type: "text", text: lines.join("\n").slice(0, 4000) }] };
    },
  });

  registry.register({
    name: "document_create",
    effect: "internal",
    description:
      "Create a designed PDF (report, proposal, memo, spec, printable document) from Markdown or a structured DocumentSpec and a catalog theme. Use it whenever the user asks for a PDF or 'Markdown to PDF'; do not write HTML or CSS. Provide exactly one of markdown, markdownPath (workspace .md file) or spec. theme is an id or {id, accent, ink} with hex brand colors; cover:false omits the cover (without front matter the first # heading and the bold Key: value lines under it become the cover).",
    inputSchema: objectSchema(
      {
        markdown: { type: "string", maxLength: DOCUMENT_LIMITS.markdownBytes },
        markdownPath: { type: "string", maxLength: 500 },
        spec: { type: "object" },
        theme: {
          oneOf: [
            { type: "string", maxLength: 60 },
            {
              type: "object",
              properties: {
                id: { type: "string", maxLength: 60 },
                accent: { type: "string", maxLength: 20 },
                ink: { type: "string", maxLength: 20 },
              },
              additionalProperties: false,
            },
          ],
        },
        cover: { type: "boolean" },
        page: {
          type: "object",
          properties: {
            size: { type: "string", enum: ["A4", "Letter", "Legal", "A5"] },
            orientation: { type: "string", enum: ["portrait", "landscape"] },
          },
          additionalProperties: false,
        },
        quality: { type: "string", enum: ["fast", "professional"] },
        title: { type: "string", maxLength: 200 },
        outputName: { type: "string", maxLength: 80, pattern: "^[\\w .-]+$" },
        assets: {
          type: "array",
          maxItems: DOCUMENT_LIMITS.assets,
          items: {
            type: "object",
            properties: {
              id: { type: "string", pattern: "^[a-z0-9_-]{1,40}$" },
              path: { type: "string", maxLength: 500 },
              artifactId: { type: "string", maxLength: 80 },
              alt: { type: "string", maxLength: 300 },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
        lang: { type: "string", maxLength: 35 },
        engine: { type: "string", enum: ["auto", "chromium", "weasyprint"] },
      },
      [],
    ),
    async execute(input, context: ToolContext): Promise<ToolResult> {
      const publisher = context.artifacts as CoreArtifactPublisher | undefined;
      if (!publisher?.publishDetailed)
        return failure(
          new DocumentError(
            "DOCUMENT_RENDER_FAILED",
            "Artifacts are not available in this session.",
          ),
        );
      const settings = deps.settings();
      const signal = AbortSignal.any([
        context.signal,
        AbortSignal.timeout(DOCUMENT_LIMITS.callTimeoutMs),
      ]);
      const sessionId = context.session ?? "";
      const createDeps: CreateDeps = {
        tmpRoot: deps.tmpRoot,
        engines: deps.engines,
        settings,
        assets: {
          workspaceRoot: context.workspace,
          trusted: deps.trusted(),
          ...(deps.readArtifact
            ? {
                readArtifact: (id: string) =>
                  deps.readArtifact?.(sessionId, id) ?? Promise.resolve(undefined),
              }
            : {}),
        },
        publishFile: (source, title) => publisher.publishDetailed({ source, title }),
        publishHtml: (fileName, title, text) =>
          publisher.publishTextDetailed({ fileName, title, text }),
        signal,
        progress: (line) => context.emit(`${line}\n`),
      };
      try {
        const result = await queue.run(() => createDocument(input as never, createDeps), signal);
        const { info } = result;
        const lines = [
          `PDF created: ${info.artifacts[0]?.fileName} (${info.qa.pageCount} pages, theme ${info.theme}, ${info.engine.id}${info.engine.version ? ` ${info.engine.version}` : ""}, ${(info.durationMs / 1000).toFixed(1)} s).`,
          `Checks: ${info.qa.passed ? "passed" : "FAILED"}${info.qa.tagged ? ", tagged PDF" : ""}.`,
          ...info.qa.warnings.map((w) => `- ${w.code}: ${w.message}`),
          ...info.qa.repairs.map((r) => `- repaired (${r.code}): ${r.action}`),
          ...info.degraded.map((d) => `- degraded ${d.feature}: ${d.reason}`),
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }, ...artifactBlocks(result.published)],
          ...(info.qa.passed ? {} : {}),
        };
      } catch (error) {
        if (error instanceof EngineUnavailable && error.published)
          return {
            content: [
              { type: "text", text: `DOCUMENT_ENGINE_UNAVAILABLE: ${error.message}` },
              ...artifactBlocks([error.published]),
            ],
            isError: true,
          };
        if ((error as Error).name === "AbortError" && !context.signal.aborted)
          return failure(
            new DocumentError("DOCUMENT_RENDER_TIMEOUT", "The document took too long to render."),
          );
        return failure(error);
      }
    },
  });
}
