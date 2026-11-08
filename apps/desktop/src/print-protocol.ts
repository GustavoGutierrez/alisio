/**
 * Print protocol between the host process and the Electron main process (spec 026 D7). The host
 * asks main to print a render bundle to PDF in a hidden window; main answers with a PDF file.
 * Everything crossing the channel is untrusted and validated here, without any Electron import.
 */
import { isAbsolute, join, normalize, relative, sep } from "node:path";

/** The virtual origin that serves the bundle; every other URL is blocked. */
export const PRINT_ORIGIN = "https://document.invalid/";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ERROR_CHARS = 500;
const MAX_MM = 2000;
const MAX_TIMEOUT_MS = 5 * 60_000;

export interface PrintOptions {
  /** Width of the content box in mm: the viewport used for DOM measurements. */
  contentWidthMm: number;
  tagged: boolean;
  measure: boolean;
  timeoutMs: number;
}

/** Host to main. */
export interface PrintRequest {
  type: "print";
  id: string;
  bundleDir: string;
  entry: string;
  options: PrintOptions;
}

export interface PrintMeasurements {
  overflow: Array<{ block: number; tag: string; overflowPx: number }>;
  lowDpi: Array<{ src: string; dpi: number }>;
}

/** Main to host. */
export type PrintResult =
  | {
      type: "print-result";
      id: string;
      ok: true;
      pdfPath: string;
      measurements?: PrintMeasurements;
    }
  | { type: "print-result"; id: string; ok: false; error: string };

const num = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && v <= max;

/** `dir` is strictly inside `root` (never `root` itself). */
export function isInside(root: string, dir: string): boolean {
  if (!isAbsolute(dir)) return false;
  const rel = relative(normalize(root), normalize(dir));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function parsePrintRequest(value: unknown, printRoot: string): PrintRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (r.type !== "print" || typeof r.id !== "string" || !ID.test(r.id)) return undefined;
  if (typeof r.bundleDir !== "string" || !isInside(printRoot, r.bundleDir)) return undefined;
  const entry = r.entry;
  if (
    typeof entry !== "string" ||
    !/^[\w./-]{1,100}$/.test(entry) ||
    isAbsolute(entry) ||
    entry.split("/").includes("..")
  )
    return undefined;
  const o = r.options as Record<string, unknown> | undefined;
  if (!o || typeof o !== "object") return undefined;
  if (
    !num(o.contentWidthMm, MAX_MM) ||
    !num(o.timeoutMs, MAX_TIMEOUT_MS) ||
    typeof o.tagged !== "boolean" ||
    typeof o.measure !== "boolean"
  )
    return undefined;
  return {
    type: "print",
    id: r.id,
    bundleDir: normalize(r.bundleDir),
    entry,
    options: {
      contentWidthMm: o.contentWidthMm,
      tagged: o.tagged,
      measure: o.measure,
      timeoutMs: o.timeoutMs,
    },
  };
}

function cleanMeasurements(value: unknown): PrintMeasurements | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  const overflow = (Array.isArray(v.overflow) ? v.overflow : []).flatMap((e) => {
    const x = e as Record<string, unknown>;
    return finite(x?.block) && typeof x.tag === "string" && finite(x.overflowPx)
      ? [{ block: x.block, tag: x.tag.slice(0, 20), overflowPx: x.overflowPx }]
      : [];
  });
  const lowDpi = (Array.isArray(v.lowDpi) ? v.lowDpi : []).flatMap((e) => {
    const x = e as Record<string, unknown>;
    return typeof x?.src === "string" && finite(x.dpi)
      ? [{ src: x.src.slice(0, 200), dpi: x.dpi }]
      : [];
  });
  return { overflow: overflow.slice(0, 500), lowDpi: lowDpi.slice(0, 500) };
}

export function parsePrintResult(value: unknown): PrintResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (r.type !== "print-result" || typeof r.id !== "string" || !ID.test(r.id)) return undefined;
  if (r.ok === true && typeof r.pdfPath === "string") {
    const measurements = cleanMeasurements(r.measurements);
    return {
      type: "print-result",
      id: r.id,
      ok: true,
      pdfPath: r.pdfPath,
      ...(measurements ? { measurements } : {}),
    };
  }
  if (r.ok === false && typeof r.error === "string")
    return { type: "print-result", id: r.id, ok: false, error: r.error.slice(0, MAX_ERROR_CHARS) };
  return undefined;
}

/** File of the bundle a virtual-origin URL points at, or undefined (any other URL is blocked). */
export function resolveBundleFile(bundleDir: string, url: string): string | undefined {
  let rel: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== "document.invalid" || u.port) return undefined;
    rel = normalize(decodeURIComponent(u.pathname.slice(1)));
  } catch {
    return undefined;
  }
  const root = normalize(bundleDir);
  const full = join(root, rel);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || !full.startsWith(root + sep))
    return undefined;
  return full;
}
