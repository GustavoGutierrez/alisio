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
  close(): void;
}
