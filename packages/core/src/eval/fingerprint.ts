/**
 * The request fingerprint of the cassettes (specs/010 D10) and its structured divergence diff.
 *
 * What is hashed (after run-scoped normalization, see `normalize.ts`): `instructions`, every
 * message, the tools reduced to `{name, description, inputSchema}` (sorted by name),
 * `maxOutputTokens`, `model`, `nativeTools` and `reasoningEffort`. The spec's field list omitted
 * the last two, but they change what the provider receives. Excluded on purpose: `signal` and
 * `sessionId` (a per-run identity, not part of the request's meaning).
 *
 * The fingerprint is the hash of a PARTS record (one short hash per part), and the cassette stores
 * those parts per call, so a divergence can be explained part by part. The texts needed to show
 * what the recording had (instructions, tool descriptions and schemas, messages) are stored once,
 * capped, in a `CassetteTexts` store.
 */

import type { Message, ModelProvider } from "@alisio/sdk";
import { canonicalJson, hashCanonical, sha256Hex } from "./canonical.ts";
import type { Normalizer } from "./normalize.ts";
import { redactSecrets } from "./secrets.ts";

export type StreamRequest = Parameters<ModelProvider["stream"]>[0];

/** Characters of a stored text (message parts, tool descriptions and schemas). */
export const TEXT_CAP = 4096;
/** Instructions are stored longer: they are the largest single part and are stored once. */
export const INSTRUCTIONS_CAP = 49_152;
const EXCERPT_RADIUS = 120;
const MAX_DIFF_ENTRIES = 10;

/** 64 bits of sha256: enough to tell two versions of a part apart (the fingerprint is a full hash). */
const shortHash = (text: string): string => sha256Hex(text).slice(0, 16);
const cap = (text: string, limit: number) => (text.length > limit ? text.slice(0, limit) : text);

export interface FingerprintParts {
  instructions: string;
  messages: string[];
  /** Hash of the tool set (see `CassetteTexts.toolSets`). */
  tools: string;
  maxOutputTokens: number;
  model: string | null;
  reasoningEffort: string | null;
  /** Hash of the native tools, `null` when there are none. */
  nativeTools: string | null;
}

/** What is stored about one message so a divergence can say which of its parts changed. */
export interface MessageView {
  role: string;
  text?: string;
  calls?: string;
  result?: string;
  callId?: string;
}

export interface CassetteTexts {
  /** Capped normalized texts by part hash: instructions, tool descriptions, tool schemas, native tools. */
  texts: Record<string, string>;
  /** Tool sets by hash: tool name to the hashes of its description and schema. */
  toolSets: Record<string, Record<string, { description: string; inputSchema: string }>>;
  /** Message views by message hash. */
  messages: Record<string, MessageView>;
}

export const emptyStore = (): CassetteTexts => ({ texts: {}, toolSets: {}, messages: {} });

export interface FingerprintMaterial {
  fingerprint: string;
  parts: FingerprintParts;
  texts: Record<string, string>;
  toolSet: Record<string, { description: string; inputSchema: string }>;
  messages: Array<{ hash: string; view: MessageView }>;
}

function viewOf(message: Message): MessageView {
  switch (message.role) {
    case "user":
      return { role: "user", text: cap(message.text, TEXT_CAP) };
    case "assistant":
      return {
        role: "assistant",
        text: cap(message.text, TEXT_CAP),
        calls: cap(canonicalJson(message.calls), TEXT_CAP),
      };
    default:
      return {
        role: "tool",
        callId: message.callId,
        result: cap(canonicalJson(message.result), TEXT_CAP),
      };
  }
}

/** Fingerprints a provider request after normalizing it with `normalizer`. */
export function computeFingerprint(
  request: StreamRequest,
  normalizer: Normalizer,
): FingerprintMaterial {
  const texts: Record<string, string> = {};
  const keep = (text: string, limit = TEXT_CAP): string => {
    const hash = shortHash(text);
    texts[hash] = cap(text, limit);
    return hash;
  };

  const instructionsText = normalizer.text(request.instructions);
  const instructions = keep(instructionsText, INSTRUCTIONS_CAP);

  const messages = request.messages.map((raw) => {
    const message = normalizer.value(raw);
    return { hash: shortHash(canonicalJson(message)), view: viewOf(message) };
  });

  const toolSet: FingerprintMaterial["toolSet"] = {};
  for (const tool of request.tools) {
    const description = normalizer.text(tool.description ?? "");
    const schema = canonicalJson(normalizer.value(tool.inputSchema));
    toolSet[tool.name] = { description: keep(description), inputSchema: keep(schema) };
  }
  const tools = shortHash(canonicalJson(toolSet));

  let nativeTools: string | null = null;
  if (request.nativeTools?.length)
    nativeTools = keep(canonicalJson(normalizer.value(request.nativeTools)));

  const parts: FingerprintParts = {
    instructions,
    messages: messages.map((m) => m.hash),
    tools,
    maxOutputTokens: request.maxOutputTokens,
    model: request.model ?? null,
    reasoningEffort: request.reasoningEffort ?? null,
    nativeTools,
  };
  return { fingerprint: hashCanonical(parts), parts, texts, toolSet, messages };
}

/** Adds what `material` knows to `store`; returns the message views the store did not have yet. */
export function absorb(
  store: CassetteTexts,
  material: FingerprintMaterial,
): Record<string, MessageView> {
  Object.assign(store.texts, material.texts);
  store.toolSets[material.parts.tools] = material.toolSet;
  const added: Record<string, MessageView> = {};
  for (const { hash, view } of material.messages) {
    if (!store.messages[hash]) {
      store.messages[hash] = view;
      added[hash] = view;
    }
  }
  return added;
}

// ---------------------------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------------------------

export interface FingerprintDiffEntry {
  call: number;
  field: string;
  excerpt: { before: string; after: string };
}
export type FingerprintDiff = FingerprintDiffEntry[];

/** `radius` characters around the first offset where the texts differ. */
export function excerptAround(before: string, after: string): { before: string; after: string } {
  const limit = Math.min(before.length, after.length);
  let at = 0;
  while (at < limit && before[at] === after[at]) at++;
  const start = Math.max(0, at - EXCERPT_RADIUS);
  const cut = (text: string) => {
    const end = at + EXCERPT_RADIUS;
    return `${start > 0 ? "…" : ""}${text.slice(start, end)}${text.length > end ? "…" : ""}`;
  };
  return { before: cut(before), after: cut(after) };
}

/**
 * What differs between the recorded parts of call `call` and the request actually made, in a fixed
 * order (instructions, messages, tools, scalars), at most 10 entries, excerpts redacted.
 */
export function diffFingerprints(
  call: number,
  recorded: FingerprintParts,
  store: CassetteTexts,
  actual: FingerprintMaterial,
): FingerprintDiff {
  const entries: FingerprintDiff = [];
  const push = (field: string, before: string, after: string, whole = false) => {
    entries.push({
      call,
      field,
      excerpt: whole ? { before, after } : excerptAround(before, after),
    });
  };
  const text = (hash: string | null | undefined, source: Record<string, string>) =>
    hash == null ? "" : (source[hash] ?? "(text not stored)");
  const now = actual.parts;

  if (recorded.instructions !== now.instructions)
    push(
      "instructions",
      text(recorded.instructions, store.texts),
      text(now.instructions, actual.texts),
    );

  const shared = Math.min(recorded.messages.length, now.messages.length);
  for (let i = 0; i < shared; i++) {
    const was = recorded.messages[i];
    const is = actual.messages[i];
    if (was === undefined || is === undefined || was === is.hash) continue;
    const before = store.messages[was];
    const view = is.view;
    if (!before) {
      push(`messages[${i}].${view.role}.other`, "(message not stored)", "(changed)", true);
      continue;
    }
    if (before.role !== view.role) {
      push(`messages[${i}].role`, before.role, view.role, true);
      continue;
    }
    let named = false;
    for (const key of ["text", "calls", "result", "callId"] as const) {
      if ((before[key] ?? "") !== (view[key] ?? "")) {
        push(`messages[${i}].${view.role}.${key}`, before[key] ?? "", view[key] ?? "");
        named = true;
      }
    }
    if (!named)
      push(
        `messages[${i}].${view.role}.other`,
        "(a part beyond the stored prefix or outside text/calls/result changed)",
        "(see the request)",
        true,
      );
  }
  if (recorded.messages.length !== now.messages.length)
    push("messages.length", String(recorded.messages.length), String(now.messages.length), true);

  if (recorded.tools !== now.tools) {
    const was = store.toolSets[recorded.tools] ?? {};
    const is = actual.toolSet;
    const added = Object.keys(is).filter((name) => !(name in was));
    const removed = Object.keys(was).filter((name) => !(name in is));
    if (added.length > 0) push("tools.added", "", added.join(", "), true);
    if (removed.length > 0) push("tools.removed", removed.join(", "), "", true);
    for (const name of Object.keys(is)) {
      const before = was[name];
      const after = is[name];
      if (!before || !after) continue;
      if (before.description !== after.description)
        push(
          `tools[${name}].description`,
          text(before.description, store.texts),
          text(after.description, actual.texts),
        );
      if (before.inputSchema !== after.inputSchema)
        push(
          `tools[${name}].inputSchema`,
          text(before.inputSchema, store.texts),
          text(after.inputSchema, actual.texts),
        );
    }
  }
  if (recorded.maxOutputTokens !== now.maxOutputTokens)
    push("maxOutputTokens", String(recorded.maxOutputTokens), String(now.maxOutputTokens), true);
  if (recorded.model !== now.model) push("model", String(recorded.model), String(now.model), true);
  if (recorded.reasoningEffort !== now.reasoningEffort)
    push("reasoningEffort", String(recorded.reasoningEffort), String(now.reasoningEffort), true);
  if (recorded.nativeTools !== now.nativeTools)
    push(
      "nativeTools",
      text(recorded.nativeTools, store.texts),
      text(now.nativeTools, actual.texts),
    );

  return entries.slice(0, MAX_DIFF_ENTRIES).map((entry) => ({
    ...entry,
    excerpt: {
      before: redactSecrets(entry.excerpt.before),
      after: redactSecrets(entry.excerpt.after),
    },
  }));
}
