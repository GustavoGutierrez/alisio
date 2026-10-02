/**
 * Read-only data views of the memory plugin for the web "Memory" tab. They never write: every
 * query is a plain SELECT (no access counters, no timestamps). Ids and shapes are a contract with
 * the web (`records`, `summary`, `context`); see specs/alisio-web-memory-tab-v1.md.
 */
import { type ViewDefinition, ViewParamsError } from "@alisio/sdk";
import { MEMORY_TYPES, type MemoryStore, type MemoryType, type RecordsCursor } from "./types.ts";

/** Per-entry content cap in a list (the full body stays available through `/memory show`). */
export const ENTRY_CONTENT_CAP = 10_000;
/** Cap of the summary and context texts shown in the tab. */
export const TEXT_CAP = 50_000;
const DEFAULT_LIMIT = 20;

export interface MemoryViewDeps {
  store: MemoryStore;
  project: string;
}

export const encodeCursor = (cursor: RecordsCursor): string =>
  Buffer.from(JSON.stringify([cursor.pinned, cursor.updatedAt, cursor.id])).toString("base64url");

export function decodeCursor(text: string): RecordsCursor {
  try {
    const value: unknown = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      (value[0] === 0 || value[0] === 1) &&
      Number.isSafeInteger(value[1]) &&
      Number.isSafeInteger(value[2])
    )
      return { pinned: value[0], updatedAt: value[1] as number, id: value[2] as number };
  } catch {
    /* falls through to the error below */
  }
  throw new ViewParamsError("Invalid cursor");
}

const clip = (text: string, max: number) => ({
  text: text.length > max ? text.slice(0, max) : text,
  truncated: text.length > max,
});

export function memoryViews({ store, project }: MemoryViewDeps): ViewDefinition[] {
  return [
    {
      id: "records",
      description: "Memory records saved in the session, pinned first, then newest first",
      params: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...MEMORY_TYPES] },
          q: { type: "string", maxLength: 200 },
          limit: { type: "integer", minimum: 1, maximum: 50, default: DEFAULT_LIMIT },
          cursor: { type: "string", maxLength: 200 },
        },
      },
      handler(params, context) {
        const text = typeof params.q === "string" ? params.q.trim() : "";
        const page = store.recordsOfSession(project, context.sessionId, {
          ...(typeof params.type === "string" ? { type: params.type as MemoryType } : {}),
          ...(text ? { text } : {}),
          limit: typeof params.limit === "number" ? params.limit : DEFAULT_LIMIT,
          ...(typeof params.cursor === "string" && params.cursor
            ? { after: decodeCursor(params.cursor) }
            : {}),
        });
        const last = page.items.at(-1);
        return {
          items: page.items.map(({ content, ...entry }) => {
            const body = clip(content, ENTRY_CONTENT_CAP);
            return { ...entry, content: body.text, contentTruncated: body.truncated };
          }),
          total: page.total,
          ...(page.hasMore && last
            ? {
                next: encodeCursor({
                  pinned: last.pinned ? 1 : 0,
                  updatedAt: last.updatedAt,
                  id: last.id,
                }),
              }
            : {}),
        };
      },
    },
    {
      id: "summary",
      description: "The session summary the memory plugin stored for the session",
      handler(_params, context) {
        const row = store.summaryRow(project, context.sessionId);
        if (!row) return { summary: null };
        const body = clip(row.content, TEXT_CAP);
        return {
          summary: { content: body.text, updatedAt: row.updatedAt, truncated: body.truncated },
        };
      },
    },
    {
      id: "context",
      description: "The memory context the plugin injected when the session started",
      handler(_params, context) {
        const row = store.injectedContext(project, context.sessionId);
        if (!row) return { context: null };
        const body = clip(row.content, TEXT_CAP);
        return {
          context: { content: body.text, injectedAt: row.injectedAt, truncated: body.truncated },
        };
      },
    },
  ];
}
