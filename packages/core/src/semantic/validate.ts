import { type EmbeddingKind, SemanticError, type SemanticMetadata } from "@alisio/sdk";

/** Host limits (spec 029, D9/D10), enforced before any provider is called. */
export const SEMANTIC_LIMITS = {
  maxTexts: 256,
  maxTextChars: 32_768,
  minDimensions: 1,
  maxDimensions: 4096,
  maxTopK: 100,
  defaultTopK: 8,
  maxRecords: 1000,
  maxMetadataBytes: 8 * 1024,
  maxFilterKeys: 16,
} as const;

const RECORD_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const COLLECTION = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const METADATA_KEY = /^[A-Za-z0-9._:-]{1,64}$/;

const invalid = (message: string): never => {
  throw new SemanticError("invalid_request", message);
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

export function validateKind(kind: unknown): EmbeddingKind {
  if (kind !== "query" && kind !== "document") invalid('kind must be "query" or "document"');
  return kind as EmbeddingKind;
}

export function validateTexts(texts: unknown): string[] {
  if (!Array.isArray(texts) || texts.length < 1 || texts.length > SEMANTIC_LIMITS.maxTexts)
    invalid(`texts needs 1..${SEMANTIC_LIMITS.maxTexts} items`);
  for (const text of texts as unknown[])
    if (typeof text !== "string" || text.length > SEMANTIC_LIMITS.maxTextChars)
      invalid(`each text must be a string of at most ${SEMANTIC_LIMITS.maxTextChars} characters`);
  return texts as string[];
}

export function validateCollection(name: unknown): string {
  if (typeof name !== "string" || !COLLECTION.test(name))
    invalid("collection must match ^[a-z0-9][a-z0-9_-]{0,63}$");
  return name as string;
}

export function validateRecordId(id: unknown): string {
  if (typeof id !== "string" || !RECORD_ID.test(id))
    invalid("id must match ^[A-Za-z0-9._:-]{1,128}$");
  return id as string;
}

export function validateIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > SEMANTIC_LIMITS.maxRecords)
    invalid(`ids needs 1..${SEMANTIC_LIMITS.maxRecords} items`);
  for (const id of ids as unknown[]) validateRecordId(id);
  return ids as string[];
}

/** Top-level `{ key: scalar }` object; used for record metadata and for filters. */
function validateScalarMap(value: unknown, label: string, maxKeys?: number): SemanticMetadata {
  if (!isRecord(value)) return invalid(`${label} must be an object`);
  const keys = Object.keys(value);
  if (maxKeys !== undefined && keys.length > maxKeys)
    invalid(`${label} allows at most ${maxKeys} keys`);
  for (const key of keys) {
    if (!METADATA_KEY.test(key)) invalid(`${label} has an invalid key`);
    if (!isScalar(value[key])) invalid(`${label} values must be string, finite number or boolean`);
  }
  return value as SemanticMetadata;
}

export function validateFilter(filter: unknown): SemanticMetadata | undefined {
  if (filter === undefined) return undefined;
  return validateScalarMap(filter, "filter", SEMANTIC_LIMITS.maxFilterKeys);
}

export function validateTopK(topK: unknown): number {
  if (topK === undefined) return SEMANTIC_LIMITS.defaultTopK;
  if (!Number.isInteger(topK) || (topK as number) < 1 || (topK as number) > SEMANTIC_LIMITS.maxTopK)
    invalid(`topK must be an integer in 1..${SEMANTIC_LIMITS.maxTopK}`);
  return topK as number;
}

export function validateMinScore(minScore: unknown): number | undefined {
  if (minScore === undefined) return undefined;
  if (typeof minScore !== "number" || !Number.isFinite(minScore))
    invalid("minScore must be a finite number");
  return minScore as number;
}

export function validateQuery(query: unknown): string {
  if (typeof query !== "string" || query.length < 1 || query.length > SEMANTIC_LIMITS.maxTextChars)
    invalid(`query must be 1..${SEMANTIC_LIMITS.maxTextChars} characters`);
  return query as string;
}

export interface ValidDocument {
  id: string;
  text: string;
  metadata?: SemanticMetadata;
  keepText: boolean;
}

export function validateDocuments(documents: unknown): ValidDocument[] {
  if (
    !Array.isArray(documents) ||
    documents.length < 1 ||
    documents.length > SEMANTIC_LIMITS.maxRecords
  )
    invalid(`documents needs 1..${SEMANTIC_LIMITS.maxRecords} items`);
  const seen = new Set<string>();
  return (documents as unknown[]).map((raw) => {
    if (!isRecord(raw)) return invalid("each document must be an object");
    const id = validateRecordId(raw.id);
    if (seen.has(id)) invalid("document ids must be unique within one call");
    seen.add(id);
    if (
      typeof raw.text !== "string" ||
      raw.text.length < 1 ||
      raw.text.length > SEMANTIC_LIMITS.maxTextChars
    )
      invalid(`document text must be 1..${SEMANTIC_LIMITS.maxTextChars} characters`);
    let metadata: SemanticMetadata | undefined;
    if (raw.metadata !== undefined) {
      metadata = validateScalarMap(raw.metadata, "metadata");
      if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > SEMANTIC_LIMITS.maxMetadataBytes)
        invalid(`metadata is larger than ${SEMANTIC_LIMITS.maxMetadataBytes} bytes`);
    }
    if (raw.keepText !== undefined && typeof raw.keepText !== "boolean")
      invalid("keepText must be a boolean");
    return {
      id,
      text: raw.text as string,
      ...(metadata ? { metadata } : {}),
      keepText: raw.keepText !== false,
    };
  });
}

/** `dimensions()` of a provider: an integer in 1..4096, else the provider is misbehaving. */
export const isValidDimensions = (value: unknown): value is number =>
  Number.isInteger(value) &&
  (value as number) >= SEMANTIC_LIMITS.minDimensions &&
  (value as number) <= SEMANTIC_LIMITS.maxDimensions;
