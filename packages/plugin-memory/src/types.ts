/** Memory plugin contract. Core never imports this module. */
export const MEMORY_TYPES = [
  "decision",
  "bugfix",
  "discovery",
  "pattern",
  "architecture",
  "config",
  "preference",
  "learning",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
/** `project` memories belong to one project id; `personal` ones are visible from every project. */
export type MemoryScope = "project" | "personal";
export interface MemoryInput {
  project: string;
  scope: MemoryScope;
  type: MemoryType;
  title: string;
  /** Body, conventionally **What** / **Why** / **Where** / **Learned**. */
  content: string;
  topicKey?: string;
  session?: string;
  /** Producer, e.g. memory_save or compaction (Engram's tool_name). */
  source?: string;
}
export interface MemoryRecord extends Omit<MemoryInput, "source"> {
  id: number;
  createdAt: number;
  updatedAt: number;
  revisionCount: number;
  duplicateCount: number;
  accessCount: number;
  pinned: boolean;
}
/** Compact row: progressive disclosure keeps full bodies behind get(id). */
export interface MemoryHit {
  id: number;
  type: MemoryType;
  title: string;
  snippet: string;
  scope: MemoryScope;
  topicKey?: string;
  updatedAt: number;
  pinned?: boolean;
}
export interface SessionSummary {
  project: string;
  session: string;
  content: string;
  createdAt: number;
}
/** One row of the "saved in this chat" list (full body, capped by the caller). */
export interface SessionRecord {
  id: number;
  type: MemoryType;
  title: string;
  content: string;
  scope: MemoryScope;
  topicKey?: string;
  /** Producer, e.g. memory_save or compaction. */
  source?: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  revisionCount: number;
  duplicateCount: number;
}
/** Keyset position in the `pinned DESC, updated_at DESC, id DESC` order. */
export interface RecordsCursor {
  pinned: 0 | 1;
  updatedAt: number;
  id: number;
}
export interface SessionRecordsQuery {
  type?: MemoryType;
  /** Case-insensitive substring of title, content or topic key (literal, not a pattern). */
  text?: string;
  limit: number;
  after?: RecordsCursor;
}
export interface SearchOptions {
  limit?: number;
  type?: MemoryType;
  scope?: MemoryScope;
  /** `all` (default) requires every term; `any` matches any term. */
  mode?: "all" | "any";
  /** Search every project instead of this project plus personal memories. */
  allProjects?: boolean;
}
export type SaveAction = "created" | "updated" | "duplicate";
/** Engram-style local store: no network, no embeddings; soft-deleted rows are always hidden. */
export interface MemoryStore {
  save(input: MemoryInput): { id: number; action: SaveAction };
  search(project: string, query: string, options?: SearchOptions): MemoryHit[];
  recent(project: string, limit?: number): MemoryHit[];
  pinned(project: string, limit?: number): MemoryHit[];
  get(id: number, project: string): MemoryRecord | undefined;
  timeline(id: number, project: string, before?: number, after?: number): MemoryHit[];
  pin(id: number, project: string, pinned: boolean): boolean;
  forget(id: number, project: string, hard?: boolean): boolean;
  count(project: string): { project: number; personal: number };
  recordPrompt(project: string, session: string, content: string): void;
  recentPrompts(
    project: string,
    limit?: number,
  ): { session: string; content: string; createdAt: number }[];
  /** Stores (redacted, capped) and returns the persisted text. */
  saveSummary(project: string, session: string, content: string): string;
  /** Summary of one session, used to confirm an archive write. */
  summaryOf(session: string): string | undefined;
  lastSummary(project: string): SessionSummary | undefined;
  /**
   * Read-only listing for the web "Memory" tab: this chat's records (visible to the project),
   * pinned first then newest, by keyset. Never touches access counters or timestamps.
   */
  recordsOfSession(
    project: string,
    session: string,
    query: SessionRecordsQuery,
  ): { items: SessionRecord[]; total: number; hasMore: boolean };
  /** Summary stored for one session of this project (read-only). */
  summaryRow(project: string, session: string): { content: string; updatedAt: number } | undefined;
  /** Remembers the context injected at session start, one row per session. */
  saveInjectedContext(project: string, session: string, content: string): void;
  injectedContext(
    project: string,
    session: string,
  ): { content: string; injectedAt: number } | undefined;
  close(): void;
}
