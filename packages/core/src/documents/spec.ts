/** DocumentSpec v1 (spec 026 §5.2): types and validation. Phase 1 block set. */
import { z } from "zod";
import { DOCUMENT_LIMITS } from "./limits.ts";

export type Inline = string;
export type Tone = "info" | "success" | "warning" | "danger";

export type Block =
  | { type: "cover"; title: string; subtitle?: string; meta?: string[]; imageAsset?: string }
  | { type: "heading"; level: 1 | 2 | 3; text: string; id?: string }
  | { type: "paragraph"; text: Inline }
  | { type: "bullets"; ordered?: boolean; items: Array<Inline | { text: Inline; items: Inline[] }> }
  | {
      type: "table";
      columns: Array<{
        label: string;
        align?: "left" | "right" | "center";
        width?: "auto" | "narrow" | "wide";
      }>;
      rows: Inline[][];
      caption?: string;
      header?: boolean;
    }
  | { type: "image"; asset: string; caption?: string; size?: "small" | "medium" | "full" }
  | { type: "quote"; text: Inline; attribution?: string }
  | { type: "callout"; tone: Tone; title?: string; text: Inline }
  | { type: "code"; text: string; language?: string }
  | {
      type: "stat_grid";
      items: Array<{ label: string; value: string; delta?: string; tone?: Tone }>;
    }
  | { type: "page_break" }
  | { type: "toc"; depth?: 1 | 2 | 3 };

export interface DocumentMeta {
  title?: string;
  subtitle?: string;
  author?: string;
  date?: string;
  organization?: string;
}

export interface DocumentSpec {
  version: 1;
  meta?: DocumentMeta;
  blocks: Block[];
}

const text = (max: number) => z.string().max(max);
const tone = z.enum(["info", "success", "warning", "danger"]);
const assetId = z.string().regex(/^[a-z0-9_-]{1,40}$/);

const block = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("cover"),
    title: text(300).min(1),
    subtitle: text(300).optional(),
    meta: z.array(text(200)).max(6).optional(),
    imageAsset: assetId.optional(),
  }),
  z.strictObject({
    type: z.literal("heading"),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    text: text(300).min(1),
    id: z
      .string()
      .regex(/^[A-Za-z][\w-]{0,60}$/)
      .optional(),
  }),
  z.strictObject({ type: z.literal("paragraph"), text: text(20_000) }),
  z.strictObject({
    type: z.literal("bullets"),
    ordered: z.boolean().optional(),
    items: z
      .array(
        z.union([
          text(2000),
          z.strictObject({ text: text(2000), items: z.array(text(2000)).max(100) }),
        ]),
      )
      .max(500),
  }),
  z.strictObject({
    type: z.literal("table"),
    columns: z
      .array(
        z.strictObject({
          label: text(200),
          align: z.enum(["left", "right", "center"]).optional(),
          width: z.enum(["auto", "narrow", "wide"]).optional(),
        }),
      )
      .min(1)
      .max(12),
    rows: z.array(z.array(text(2000)).max(12)).max(DOCUMENT_LIMITS.tableRows),
    caption: text(300).optional(),
    header: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("image"),
    asset: assetId,
    caption: text(300).optional(),
    size: z.enum(["small", "medium", "full"]).optional(),
  }),
  z.strictObject({
    type: z.literal("quote"),
    text: text(5000),
    attribution: text(200).optional(),
  }),
  z.strictObject({
    type: z.literal("callout"),
    tone,
    title: text(200).optional(),
    text: text(5000),
  }),
  z.strictObject({
    type: z.literal("code"),
    text: text(20_000),
    language: text(40).optional(),
  }),
  z.strictObject({
    type: z.literal("stat_grid"),
    items: z
      .array(
        z.strictObject({
          label: text(100),
          value: text(40),
          delta: text(40).optional(),
          tone: tone.optional(),
        }),
      )
      .min(2)
      .max(8),
  }),
  z.strictObject({ type: z.literal("page_break") }),
  z.strictObject({
    type: z.literal("toc"),
    depth: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  }),
]);

const specSchema = z.strictObject({
  version: z.literal(1),
  meta: z
    .strictObject({
      title: text(200).optional(),
      subtitle: text(300).optional(),
      author: text(200).optional(),
      date: text(60).optional(),
      organization: text(200).optional(),
    })
    .optional(),
  blocks: z.array(block).max(DOCUMENT_LIMITS.blocks),
});

export type SpecValidation = { ok: true; spec: DocumentSpec } | { ok: false; errors: string[] };

const pointer = (path: ReadonlyArray<PropertyKey>) =>
  `/${path.map((p) => String(p).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;

/** Validates before any render; `declaredAssets` are the ids of `assets`. Errors are JSON pointers. */
export function validateDocumentSpec(
  input: unknown,
  declaredAssets: ReadonlySet<string> = new Set(),
): SpecValidation {
  const parsed = specSchema.safeParse(input);
  if (!parsed.success) {
    const errors = parsed.error.issues.slice(0, 20).map((issue) => {
      const where = pointer(issue.path);
      return issue.code === "invalid_union" && issue.path.length === 2
        ? `${where}: unknown or malformed block`
        : `${where}: ${issue.message}`;
    });
    return { ok: false, errors };
  }
  const spec = parsed.data as DocumentSpec;
  const errors: string[] = [];
  let covers = 0;
  let tocs = 0;
  let totalRows = 0;
  spec.blocks.forEach((b, i) => {
    if (b.type === "cover") {
      covers++;
      if (i !== 0 || covers > 1) errors.push(`/blocks/${i}: cover must be unique and first`);
      if (b.imageAsset && !declaredAssets.has(b.imageAsset))
        errors.push(`/blocks/${i}/imageAsset: asset "${b.imageAsset}" is not declared`);
    }
    if (b.type === "toc" && ++tocs > 1) errors.push(`/blocks/${i}: only one toc is allowed`);
    if (b.type === "image" && !declaredAssets.has(b.asset))
      errors.push(`/blocks/${i}/asset: asset "${b.asset}" is not declared`);
    if (b.type === "table") totalRows += b.rows.length;
  });
  if (totalRows > DOCUMENT_LIMITS.totalTableRows)
    errors.push(`/blocks: more than ${DOCUMENT_LIMITS.totalTableRows} table rows in total`);
  return errors.length ? { ok: false, errors: errors.slice(0, 20) } : { ok: true, spec };
}
