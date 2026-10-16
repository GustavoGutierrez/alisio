import { createHash } from "node:crypto";
import type { Message } from "@alisio/sdk";

/** Tools whose `path` argument names the file the call reads or changes. */
export const PATH_TOOLS = new Set(["read_file", "write_file", "edit_file"]);
export const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

export const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Stable 12-hex id of a segment: kind, call id or position, and a hash of its content. */
export const segmentId = (kind: string, key: string | number, content: string) =>
  sha(`${kind}\0${key}\0${sha(content)}`).slice(0, 12);

export function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Key-order independent serialization, so equal arguments compare equal. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Text parts of a tool result joined with newlines (what the model sees). */
export const resultText = (m: Extract<Message, { role: "tool" }>) =>
  m.result.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");

export interface CallInfo {
  name: string;
  arguments: string;
  /** Parsed JSON arguments when they form an object, else undefined. */
  args?: Record<string, unknown>;
  path?: string;
}

export function describeCall(name: string, argumentsText: string): CallInfo {
  const args = parseObject(argumentsText);
  const path = PATH_TOOLS.has(name) && typeof args?.path === "string" ? args.path : undefined;
  return { name, arguments: argumentsText, ...(args ? { args } : {}), ...(path ? { path } : {}) };
}
