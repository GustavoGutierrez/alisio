/**
 * The `document_create` pipeline (spec 026 §4.1): validate, convert, resolve assets, render the
 * bundle, select the engine, render, QA, bounded repair, publish. Pure orchestration over ports;
 * the tool in `tools/documents.ts` only adapts it to the tool contract.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { DocumentResultInfo } from "@alisio/sdk";
import type { PublishedArtifactInfo } from "../core/contracts.ts";
import {
  type AssetContext,
  type AssetRequest,
  readWorkspaceFile,
  resolveAssets,
} from "./assets.ts";
import { resolveBrand } from "./brand.ts";
import { type EngineChoice, selectDocumentEngine } from "./engine-select.ts";
import { DOCUMENT_LIMITS, DocumentError } from "./limits.ts";
import { markdownToSpec } from "./markdown.ts";
import { scan } from "./pdf-scan.ts";
import type {
  DocumentEngine,
  EngineId,
  Orientation,
  PageSetup,
  PageSize,
  Readiness,
} from "./ports.ts";
import { analyzeOutput, checkText, type Finding } from "./qa.ts";
import { plain, type RenderHints, writeBundle } from "./render-html.ts";
import { MAX_REPAIRS, nextRepair, type RepairState } from "./repair.ts";
import { type DocumentSpec, validateDocumentSpec } from "./spec.ts";
import { assetsAvailable, loadManifest, pageDimensions } from "./themes.ts";

export interface CreateInput {
  markdown?: string | undefined;
  markdownPath?: string | undefined;
  spec?: unknown;
  /** A catalog id, or `{ id?, accent?, ink? }` for a brand accent and ink (hex). */
  theme?:
    | string
    | { id?: string | undefined; accent?: string | undefined; ink?: string | undefined }
    | undefined;
  /** `false` builds no cover. Default `true`. */
  cover?: boolean | undefined;
  page?: { size?: PageSize | undefined; orientation?: Orientation | undefined } | undefined;
  quality?: "fast" | "professional" | undefined;
  title?: string | undefined;
  outputName?: string | undefined;
  assets?: AssetRequest[] | undefined;
  lang?: string | undefined;
  engine?: EngineChoice | undefined;
}

export interface CreateDeps {
  /** `<state>/documents/tmp`. */
  tmpRoot: string;
  engines: () => DocumentEngine[];
  settings: { engine: EngineChoice; defaultPageSize: PageSize };
  assets: AssetContext;
  publishFile: (source: string, title: string) => Promise<PublishedArtifactInfo>;
  publishHtml: (fileName: string, title: string, html: string) => Promise<PublishedArtifactInfo>;
  signal: AbortSignal;
  progress?: (line: string) => void;
}

export interface CreateOutput {
  info: DocumentResultInfo;
  published: PublishedArtifactInfo[];
  warnings: Finding[];
}

export class EngineUnavailable extends DocumentError {
  readonly published: PublishedArtifactInfo | undefined;
  constructor(message: string, published?: PublishedArtifactInfo) {
    super("DOCUMENT_ENGINE_UNAVAILABLE", message);
    this.published = published;
  }
}

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "document";

const DEGRADE_TOC = "Table of contents entries are links without page numbers in this version.";

/** A self-contained HTML of the bundle (fallback when no engine is ready, D16). */
async function selfContainedHtml(bundleDir: string, files: string[]): Promise<string> {
  const read = (f: string) => readFile(join(bundleDir, f));
  let html = await readFile(join(bundleDir, "index.html"), "utf8");
  const origin = "https://document.invalid/";
  const dataUri = async (rel: string, mime: string) =>
    `data:${mime};base64,${(await read(rel)).toString("base64")}`;
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, "");
  const css = files.filter((f) => f.startsWith("css/"));
  let inline = "";
  for (const f of css) {
    let text = await readFile(join(bundleDir, f), "utf8");
    const lines: string[] = [];
    for (const line of text.split("\n")) {
      const m = /url\("https:\/\/document\.invalid\/(fonts\/[^"]+)"\)/.exec(line);
      if (!m) {
        lines.push(line);
        continue;
      }
      const rel = m[1] as string;
      // Greek and Cyrillic faces are left out of the fallback file to keep it small.
      if (files.includes(rel) && !/-(greek|cyrillic)-/.test(rel))
        lines.push(line.replace(m[0], `url("${await dataUri(rel, "font/woff2")}")`));
    }
    text = lines.join("\n");
    inline += `<style>\n${text}\n</style>\n`;
    html = html.replace(`<link rel="stylesheet" href="${origin}${f}">`, "");
  }
  html = html.replace("</head>", `${inline}</head>`);
  for (const m of html.matchAll(new RegExp(`${origin.replace(/\./g, "\\.")}(assets/[^"]+)`, "g"))) {
    const rel = m[1] as string;
    const ext = rel.split(".").pop() ?? "png";
    const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    html = html.replaceAll(m[0], await dataUri(rel, mime));
  }
  return html;
}

export async function createDocument(input: CreateInput, deps: CreateDeps): Promise<CreateOutput> {
  const started = Date.now();
  if (!(await assetsAvailable()))
    throw new DocumentError(
      "DOCUMENT_ENGINE_UNAVAILABLE",
      "The document themes and fonts are not part of this build (the standalone binary carries no asset files). Install Alisio with npm (`npm install -g @alisio/alisio-code`) or use Alisio Desktop to create PDFs.",
    );
  const sources = [input.markdown, input.markdownPath, input.spec].filter((v) => v !== undefined);
  if (sources.length !== 1)
    throw new DocumentError(
      "DOCUMENT_INPUT_INVALID",
      "Provide exactly one of markdown, markdownPath or spec.",
    );
  const quality = input.quality ?? "professional";
  const warnings: Finding[] = [];
  const requests: AssetRequest[] = [...(input.assets ?? [])];
  let spec: DocumentSpec;
  let theme = typeof input.theme === "string" ? input.theme : input.theme?.id;
  let accent = typeof input.theme === "object" ? input.theme.accent : undefined;
  let ink = typeof input.theme === "object" ? input.theme.ink : undefined;
  let lang = input.lang;

  if (input.spec !== undefined) {
    if (Buffer.byteLength(JSON.stringify(input.spec) ?? "") > DOCUMENT_LIMITS.specBytes)
      throw new DocumentError("DOCUMENT_LIMIT_EXCEEDED", "The spec is larger than 1 MB.");
    const checked = validateDocumentSpec(input.spec, new Set(requests.map((a) => a.id)));
    if (!checked.ok)
      throw new DocumentError(
        "DOCUMENT_INPUT_INVALID",
        `The DocumentSpec is invalid:\n${checked.errors.map((e) => `- ${e}`).join("\n")}`,
      );
    spec = checked.spec;
    if (input.cover === false)
      spec = { ...spec, blocks: spec.blocks.filter((b) => b.type !== "cover") };
  } else {
    let text = input.markdown ?? "";
    let baseDir = "";
    if (input.markdownPath !== undefined) {
      if (!/\.(md|markdown|txt)$/i.test(input.markdownPath))
        throw new DocumentError("DOCUMENT_INPUT_INVALID", "markdownPath must point to a .md file.");
      text = Buffer.from(
        await readWorkspaceFile(input.markdownPath, deps.assets, DOCUMENT_LIMITS.markdownBytes),
      ).toString("utf8");
      baseDir = posix.dirname(input.markdownPath.replace(/\\/g, "/"));
    }
    const md = markdownToSpec(text, { cover: input.cover });
    for (const a of md.assets)
      requests.push({
        id: a.id,
        path: baseDir && baseDir !== "." ? posix.join(baseDir, a.href) : a.href,
        alt: a.alt,
      });
    for (const w of md.warnings) warnings.push({ ...w, severity: "warning" });
    theme ??= md.theme;
    lang ??= md.lang;
    accent ??= md.accent;
    ink ??= md.ink;
    const checked = validateDocumentSpec(md.spec, new Set(requests.map((a) => a.id)));
    if (!checked.ok)
      throw new DocumentError(
        "DOCUMENT_INPUT_INVALID",
        `The Markdown produced an invalid document:\n${checked.errors.map((e) => `- ${e}`).join("\n")}`,
      );
    spec = checked.spec;
  }

  const manifest = await loadManifest(theme ?? "executive-clean");
  const brand = resolveBrand({ accent, ink }, manifest.tokens.colors.paper);
  for (const w of brand.warnings) warnings.push({ ...w, severity: "warning" });
  const size = input.page?.size ?? deps.settings.defaultPageSize;
  if (!manifest.pageSizes.includes(size))
    throw new DocumentError(
      "DOCUMENT_INPUT_INVALID",
      `Theme ${manifest.id} supports page sizes: ${manifest.pageSizes.join(", ")}.`,
    );
  let page: PageSetup = { size, orientation: input.page?.orientation ?? "portrait" };

  const normalized = await checkText(spec);
  spec = normalized.value;
  warnings.push(...normalized.findings);

  const renderId = randomUUID().slice(0, 12);
  const renderDir = join(deps.tmpRoot, renderId);
  const bundleDir = join(renderDir, "bundle");
  try {
    await mkdir(bundleDir, { recursive: true, mode: 0o700 });
    deps.progress?.("Preparing document…");
    const resolved = await resolveAssets(requests, bundleDir, deps.assets);
    const assets = resolved.assets;
    const skippedAssets = new Map(resolved.skipped.map((k) => [k.id, k.alt]));
    for (const k of resolved.skipped)
      warnings.push({
        code: "image_skipped",
        severity: "warning",
        message: `Image ${k.alt ? `"${k.alt}"` : `"${k.id}"`} was left out: ${k.reason}.`,
      });
    const title = input.title ?? spec.meta?.title ?? undefined;
    const outputName =
      input.outputName ??
      slug(
        title ??
          (spec.blocks.find((b) => b.type === "heading") as { text?: string } | undefined)?.text ??
          "document",
      );

    // Engine selection, once, before rendering (D3).
    const engines = deps.engines();
    const readiness = await Promise.all(
      engines.map(async (e) => ({
        id: e.id,
        readiness: (await e.readiness(deps.signal)) as Readiness,
      })),
    );
    const choice = selectDocumentEngine({
      configured: deps.settings.engine,
      requested: input.engine,
      candidates: readiness,
      quality,
    });
    if (!choice.ok) {
      const bundle = await writeBundle(spec, assets, bundleDir, {
        theme: manifest.id,
        page,
        ...(lang ? { lang } : {}),
        ...(title ? { title } : {}),
      });
      let published: PublishedArtifactInfo | undefined;
      try {
        published = await deps.publishHtml(
          `${outputName}.html`,
          bundle.title,
          await selfContainedHtml(bundleDir, bundle.files),
        );
      } catch {
        // the error below still tells the user what to do
      }
      throw new EngineUnavailable(
        `No document engine is ready.\n${choice.reasons.map((r) => `- ${r.engine}: ${r.reason}${r.fix ? ` Fix: ${r.fix}` : ""}`).join("\n")}${published ? `\nA printable HTML version was published instead (${published.artifact.fileName}); open it in a browser and print it to PDF.` : ""}`,
        published,
      );
    }
    const engine = engines.find((e) => e.id === choice.engine) as DocumentEngine;

    let state: RepairState = {
      spec,
      hints: {} as RenderHints,
      page,
      orientationLocked: input.page?.orientation !== undefined,
    };
    const repairs: Array<{ code: string; action: string }> = [];
    let pdf: Uint8Array = new Uint8Array();
    let findings: Finding[] = [];
    let engineVersion = "";
    let tagged = false;
    let pageCount = 0;
    for (let attempt = 0; ; attempt++) {
      page = state.page;
      deps.progress?.(
        attempt === 0 ? "Rendering…" : `Repairing layout (${attempt}/${MAX_REPAIRS})…`,
      );
      const bundle = await writeBundle(state.spec, assets, bundleDir, {
        theme: manifest.id,
        page,
        brand,
        skippedAssets,
        hints: state.hints,
        ...(lang ? { lang } : {}),
        ...(title ? { title } : {}),
      });
      const dim = pageDimensions(page);
      const m = manifest.tokens.grid.margin;
      const contentWidthMm = dim.w - Number.parseFloat(m.left) - Number.parseFloat(m.right);
      const out = await engine.render(
        {
          bundleDir,
          entry: bundle.entry,
          page,
          timeoutMs: DOCUMENT_LIMITS.renderTimeoutMs,
          wantTagged: true,
          measure: engine.capabilities.domMeasurements,
          contentWidthMm,
        },
        deps.signal,
      );
      pdf = out.pdf;
      engineVersion = out.engineVersion;
      if (pdf.length > DOCUMENT_LIMITS.pdfBytes)
        throw new DocumentError("DOCUMENT_LIMIT_EXCEEDED", "The PDF is larger than 50 MB.");
      const scanned = scan(Buffer.from(pdf));
      pageCount = scanned.pages;
      tagged = scanned.tagged;
      findings = analyzeOutput(scanned, out.measurements, {
        overflowChecked: engine.capabilities.domMeasurements,
      });
      const repairable = findings.some((f) => f.severity !== "info" && f.code !== "glyphs_missing");
      if (quality !== "professional" || !repairable || attempt >= MAX_REPAIRS) break;
      const step = nextRepair(findings, state);
      if (!step) break;
      repairs.push({ code: step.code, action: step.action });
      state = step.state;
    }

    const all = [
      ...warnings,
      ...findings.filter((f) => f.severity !== "info" || f.code === "overflow_not_checked"),
    ];
    const errors = all.filter((f) => f.severity === "error");
    const file = join(renderDir, `${outputName}.pdf`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, pdf);
    const published = await deps.publishFile(file, title ?? plain(outputName));
    const degraded: DocumentResultInfo["degraded"] = [];
    if (spec.blocks.some((b) => b.type === "toc"))
      degraded.push({ feature: "toc_page_numbers", reason: DEGRADE_TOC });
    const info: DocumentResultInfo = {
      artifacts: [
        {
          id: published.artifact.id,
          title: published.artifact.title ?? outputName,
          fileName: published.artifact.fileName,
          mimeType: "application/pdf",
          bytes: published.artifact.bytes,
        },
      ],
      engine: { id: engine.id as EngineId, version: engineVersion },
      theme: manifest.id,
      qa: {
        passed: errors.length === 0,
        pageCount,
        tagged,
        warnings: all
          .filter((f) => f.severity !== "info" || f.code === "overflow_not_checked")
          .map((f) => ({
            code: f.code,
            message: f.message,
            ...(f.blockIndex !== undefined ? { blockIndex: f.blockIndex } : {}),
          })),
        repairs,
        visual: { status: "skipped", reason: "Visual QA is not available in this version." },
      },
      degraded,
      durationMs: Date.now() - started,
    };
    return { info, published: [published], warnings: all };
  } finally {
    await rm(renderDir, { recursive: true, force: true }).catch(() => {});
  }
}
