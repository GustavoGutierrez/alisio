/**
 * Transcript state of one session and its pure reducers (spec §10.3). No framework or DOM code:
 * `applyFrame(state, frame) → state` is tested in Node (T-15). The signal wrapper lives in
 * `store/app.ts`.
 */
import type {
  ArtifactRef,
  BlobRef,
  DatasetRef,
  Effect,
  Message,
  RunEvent,
  ServerFrame,
  SessionDetailWire,
  ToolResult,
} from "@alisio/sdk";
import { artifactsOfResult } from "../util/artifacts.ts";

export type ToolStatus = "pending" | "running" | "completed" | "failed";

export interface ToolState {
  id: string;
  name: string;
  arguments: string;
  effect?: Effect;
  status: ToolStatus;
  durationMs?: number;
  /** Text projection from `tool_completed` (capped by the core). */
  preview?: string;
  result?: ToolResult;
  /** The server truncated `result` (>256 KB); the full one comes from `/messages`. */
  truncated?: boolean;
  /** Live progress output, bounded. */
  tail: string;
}

type Tone = "info" | "warning" | "error";

/** Durable rows (from messages) and local rows (events, command output) in display order. */
type Entry =
  | {
      kind: "user";
      key: string;
      seq: number;
      text: string;
      attachments: number;
      /** Attached images (the persisted base64), shown as thumbnails. */
      images?: Array<{ mimeType: string; data: string }>;
      /** Datasets attached to the prompt (chips that open the table). */
      datasets?: DatasetRef[];
    }
  | {
      kind: "assistant";
      key: string;
      seq: number;
      text: string;
      calls: string[];
      think?: string;
      truncated?: boolean;
    }
  | {
      kind: "notice";
      key: string;
      seq?: number;
      anchor?: number;
      code: string;
      tone: Tone;
      params: Record<string, string>;
    }
  | { kind: "context"; key: string; anchor: number; sources: string[]; tokens: number }
  | { kind: "note"; key: string; anchor: number; text: string };

export interface Echo {
  localId: string;
  requestId: string;
  /** Text sent to the model. */
  text: string;
  /** What the transcript shows instead (e.g. `/greet Ana` for an expanded template). */
  display?: string;
  state: "sending" | "failed";
  error?: string;
  /** Uploaded images sent with the prompt, and their local thumbnails (object URLs). */
  attachments?: BlobRef[];
  thumbs?: string[];
  /** Datasets attached to the prompt: the server adds their summary to the text it stores. */
  datasets?: DatasetRef[];
}

export interface LiveRun {
  runId: string;
  /** Assistant text streamed since the last durable assistant message. */
  text: string;
  reasoning: string;
  /** Tools started in this run, in order. */
  toolIds: string[];
}

export interface TranscriptState {
  sessionId: string;
  session?: SessionDetailWire;
  /** Highest durable event id applied (snapshot cursor, then event ids). */
  cursor: number;
  entries: Entry[];
  tools: Record<string, ToolState>;
  echoes: Echo[];
  live?: LiveRun;
  hasMore: boolean;
  /** Lowest message seq loaded (for `?before=`), or undefined when empty. */
  oldestSeq?: number;
  /** Highest message seq applied (duplicates at or below it are ignored). */
  maxSeq: number;
  /** A snapshot has been applied. */
  ready: boolean;
  /** Bumped by every change (cheap equality for renderers). */
  version: number;
  counter: number;
}

export type VisibleItem =
  | Extract<Entry, { kind: "user" }>
  | (Omit<Extract<Entry, { kind: "assistant" }>, "calls"> & { streaming?: false })
  | Extract<Entry, { kind: "notice" }>
  | Extract<Entry, { kind: "context" }>
  | Extract<Entry, { kind: "note" }>
  | { kind: "tool"; key: string; tool: ToolState }
  | { kind: "echo"; key: string; echo: Echo }
  | { kind: "think"; key: string; text: string }
  | { kind: "streaming"; key: string; text: string }
  /** Artifacts published by the tool rows just above (one card each, in publication order). */
  | { kind: "artifacts"; key: string; artifacts: ArtifactRef[] };

const TAIL_LIMIT = 8_192;

export const emptyTranscript = (sessionId: string): TranscriptState => ({
  sessionId,
  cursor: 0,
  entries: [],
  tools: {},
  echoes: [],
  hasMore: false,
  maxSeq: -1,
  ready: false,
  version: 0,
  counter: 0,
});

const bump = (state: TranscriptState, patch: Partial<TranscriptState>): TranscriptState => ({
  ...state,
  ...patch,
  version: state.version + 1,
});

const toolFromCall = (call: { id: string; name: string; arguments: string }): ToolState => ({
  id: call.id,
  name: call.name,
  arguments: call.arguments,
  status: "pending",
  tail: "",
});

const resultStatus = (result: ToolResult): ToolStatus => (result.isError ? "failed" : "completed");

/** Entries and tool states rebuilt from a page of stored messages. */
function fromMessages(
  items: Array<{ seq: number; message: Message }>,
  tools: Record<string, ToolState>,
): Entry[] {
  const entries: Entry[] = [];
  for (const { seq, message } of items) {
    if (message.role === "user") {
      if (message.summary)
        entries.push({
          kind: "notice",
          key: `m${seq}`,
          seq,
          code: "summary",
          tone: "info",
          params: {},
        });
      else
        entries.push({
          kind: "user",
          key: `m${seq}`,
          seq,
          text: message.display ?? message.text,
          attachments: message.attachments?.length ?? 0,
          ...(message.attachments?.length
            ? {
                images: message.attachments.map((a) => ({ mimeType: a.mimeType, data: a.data })),
              }
            : {}),
          ...(message.datasets?.length ? { datasets: message.datasets } : {}),
        });
    } else if (message.role === "assistant") {
      for (const call of message.calls)
        tools[call.id] = { ...toolFromCall(call), ...tools[call.id] };
      entries.push({
        kind: "assistant",
        key: `m${seq}`,
        seq,
        text: message.text,
        calls: message.calls.map((c) => c.id),
        ...(message.truncated ? { truncated: true } : {}),
      });
    } else {
      const current = tools[message.callId];
      tools[message.callId] = {
        ...(current ?? toolFromCall({ id: message.callId, name: "tool", arguments: "" })),
        result: message.result,
        status: resultStatus(message.result),
      };
    }
  }
  return entries;
}

/** Local entries (anchored to a message seq) merged back among durable ones. */
function mergeLocal(durable: Entry[], local: Entry[]): Entry[] {
  if (!local.length) return durable;
  const out: Entry[] = [];
  let pending = [...local];
  for (const entry of durable) {
    const seq = "seq" in entry && entry.seq !== undefined ? entry.seq : undefined;
    if (seq !== undefined) {
      const before = pending.filter((l) => anchorOf(l) < seq);
      pending = pending.filter((l) => anchorOf(l) >= seq);
      out.push(...before);
    }
    out.push(entry);
  }
  return [...out, ...pending];
}

const anchorOf = (entry: Entry): number =>
  "anchor" in entry && entry.anchor !== undefined ? entry.anchor : Number.POSITIVE_INFINITY;
const isLocal = (entry: Entry): boolean => "anchor" in entry && entry.anchor !== undefined;

function applySnapshot(
  state: TranscriptState,
  frame: Extract<ServerFrame, { t: "snapshot" }>,
): TranscriptState {
  const tools: Record<string, ToolState> = {};
  const items = frame.messages.items;
  const durable = fromMessages(items, tools);
  const oldest = items[0]?.seq;
  const local = state.entries.filter(
    (e) => isLocal(e) && (oldest === undefined || anchorOf(e) >= oldest),
  );
  let live: LiveRun | undefined;
  if (frame.inflight) {
    live = {
      runId: frame.inflight.runId,
      text: frame.inflight.text,
      reasoning: frame.inflight.reasoning,
      toolIds: frame.inflight.tools.map((t) => t.id),
    };
    for (const t of frame.inflight.tools)
      tools[t.id] = {
        ...toolFromCall(t),
        ...tools[t.id],
        effect: t.effect,
        status: "running",
        tail: t.tail,
      };
  }
  const users = items
    .map((i) => i.message)
    .filter((m): m is Extract<Message, { role: "user" }> => m.role === "user");
  const echoes = state.echoes.filter(
    (echo) => echo.state === "failed" || !users.some((m) => matchesEcho(m, echo)),
  );
  return bump(state, {
    session: frame.session,
    cursor: frame.cursor,
    entries: mergeLocal(durable, local),
    tools,
    echoes,
    live,
    hasMore: frame.messages.hasMore,
    oldestSeq: oldest,
    maxSeq: items.at(-1)?.seq ?? -1,
    ready: true,
  });
}

const matchesEcho = (message: Extract<Message, { role: "user" }>, echo: Echo): boolean =>
  echo.datasets?.length
    ? // The server appended the datasets' summary to the text and kept what the user typed.
      message.display === (echo.display ?? echo.text) && message.text.startsWith(echo.text)
    : echo.display !== undefined
      ? message.display === echo.display && message.text === echo.text
      : message.text === echo.text && message.display === undefined;

function applyMessage(
  state: TranscriptState,
  frame: Extract<ServerFrame, { t: "message" }>,
): TranscriptState {
  if (frame.seq <= state.maxSeq) return state;
  const tools = { ...state.tools };
  const [entry] = fromMessages([frame], tools);
  let { echoes, live } = state;
  const { message } = frame;
  if (message.role === "user") {
    const index = echoes.findIndex((echo) => echo.state !== "failed" && matchesEcho(message, echo));
    if (index >= 0) echoes = echoes.filter((_, i) => i !== index);
  }
  let added = entry;
  if (message.role === "assistant" && entry?.kind === "assistant" && live) {
    if (live.reasoning) added = { ...entry, think: live.reasoning };
    live = { ...live, text: "", reasoning: "" };
  }
  if (message.role === "tool") {
    // Keep the live running/finished status: a tool message means the call has settled.
    const current = tools[message.callId];
    if (current && state.tools[message.callId]?.durationMs !== undefined)
      tools[message.callId] = { ...current, durationMs: state.tools[message.callId]?.durationMs };
  }
  return bump(state, {
    entries: added ? [...state.entries, added] : state.entries,
    tools,
    echoes,
    live,
    maxSeq: frame.seq,
    oldestSeq: state.oldestSeq ?? frame.seq,
  });
}

const notice = (
  state: TranscriptState,
  code: string,
  tone: Tone,
  params: Record<string, string> = {},
): Entry => ({
  kind: "notice",
  key: `n${state.counter}`,
  anchor: state.maxSeq,
  code,
  tone,
  params,
});

/**
 * A `run_failed` event with `code: "timeout"` becomes a localized notice that names the model,
 * the limit and what to do; any other failure (or a payload without the details) keeps the
 * plain `run_failed` notice with the server's English text.
 */
function timeoutNotice(
  data: Record<string, unknown>,
): { code: string; params: Record<string, string> } | undefined {
  if (data.code !== "timeout") return undefined;
  const info = data.timeout as
    | {
        kind?: string;
        ms?: number;
        model?: string;
        provider?: string;
        stage?: string;
        tool?: string;
        firstRequest?: boolean;
        attempts?: number;
      }
    | undefined;
  if (!info || typeof info.ms !== "number") return undefined;
  const who = info.model ? (info.provider ? `${info.model} (${info.provider})` : info.model) : "";
  const params = {
    who,
    seconds: String(Math.round(info.ms / 1000)),
    tool: info.tool ?? "",
    attempts: String(info.attempts ?? 1),
  };
  // The model-centred messages need its name; without it only the generic limit text is true.
  if (info.kind === "first_token" && who)
    return {
      code:
        info.attempts && info.attempts > 1
          ? "run_timeout_first_token_retried"
          : "run_timeout_first_token",
      params,
    };
  if (info.stage === "waiting_model" && who)
    return {
      code: info.firstRequest ? "run_timeout_waiting" : "run_timeout_waiting_later",
      params,
    };
  if (info.stage === "streaming" && who) return { code: "run_timeout_streaming", params };
  if (info.stage === "tool" && info.tool) return { code: "run_timeout_tool", params };
  return { code: "run_timeout_other", params };
}

function applyEvent(state: TranscriptState, event: RunEvent): TranscriptState {
  const cursor = Math.max(state.cursor, Number(event.eventId ?? 0) || 0);
  const next = { ...state, cursor, counter: state.counter + 1 };
  const data = (event.data ?? {}) as Record<string, unknown>;
  const str = (value: unknown) => (value === undefined ? "" : String(value));
  const withNotice = (code: string, tone: Tone, params: Record<string, string> = {}) =>
    bump(next, { entries: [...state.entries, notice(state, code, tone, params)] });
  switch (event.type) {
    case "run_started":
      return bump(next, { live: { runId: event.runId, text: "", reasoning: "", toolIds: [] } });
    case "tool_started": {
      const id = str(data.id);
      const live = next.live ?? { runId: event.runId, text: "", reasoning: "", toolIds: [] };
      return bump(next, {
        tools: {
          ...state.tools,
          [id]: {
            ...toolFromCall({ id, name: str(data.name), arguments: str(data.arguments) }),
            ...state.tools[id],
            effect: data.effect as Effect,
            status: "running",
          },
        },
        live: live.toolIds.includes(id) ? live : { ...live, toolIds: [...live.toolIds, id] },
      });
    }
    case "tool_completed": {
      const id = str(data.id);
      const current = state.tools[id] ?? toolFromCall({ id, name: str(data.name), arguments: "" });
      return bump(next, {
        tools: {
          ...state.tools,
          [id]: {
            ...current,
            status: data.isError ? "failed" : "completed",
            durationMs: Number(data.durationMs) || 0,
            preview: str(data.preview),
          },
        },
      });
    }
    case "run_completed":
      return bump(next, { live: undefined });
    case "run_failed": {
      const timeout = timeoutNotice(data);
      return {
        ...(timeout
          ? withNotice(timeout.code, "error", timeout.params)
          : withNotice("run_failed", "error", { error: str(data.error) })),
        live: undefined,
      };
    }
    case "run_cancelled":
      return { ...withNotice("run_cancelled", "warning"), live: undefined };
    case "run_turns_exceeded":
      return withNotice("run_turns_exceeded", "warning", { turns: str(data.turns) });
    case "response_truncated":
      return withNotice("response_truncated", "warning", {
        maxOutputTokens: str(data.maxOutputTokens),
      });
    case "model_changed":
      return withNotice("model_changed", "info", {
        model: str(data.model),
        previous: str(data.previous),
      });
    case "compaction_completed":
      return withNotice("compaction_completed", "info", {
        before: str(data.before),
        after: str(data.after),
      });
    case "compaction_failed":
      return withNotice("compaction_failed", "error", { error: str(data.error) });
    case "context_reduced":
      return withNotice("context_reduced", "info", { messages: str(data.messages) });
    case "plugin_hook_failed":
      return withNotice("plugin_hook_failed", "warning", {
        source: str(data.source),
        hook: str(data.hook),
        error: str(data.error),
      });
    case "session_context_injected":
      return bump(next, {
        entries: [
          ...state.entries,
          {
            kind: "context",
            key: `n${state.counter}`,
            anchor: state.maxSeq,
            sources: Array.isArray(data.sources) ? data.sources.map(String) : [],
            tokens: Number(data.tokens) || 0,
          },
        ],
      });
    default:
      return cursor === state.cursor ? state : { ...state, cursor };
  }
}

function applyDelta(
  state: TranscriptState,
  frame: Extract<ServerFrame, { t: "delta" }>,
): TranscriptState {
  const base =
    state.live?.runId === frame.runId
      ? state.live
      : { runId: frame.runId, text: "", reasoning: "", toolIds: [] };
  const live = {
    ...base,
    text: base.text + (frame.text ?? ""),
    reasoning: base.reasoning + (frame.reasoning ?? ""),
  };
  let tools = state.tools;
  if (frame.progress?.length) {
    tools = { ...tools };
    for (const { toolId, chunk } of frame.progress) {
      const current = tools[toolId] ?? toolFromCall({ id: toolId, name: "tool", arguments: "" });
      tools[toolId] = { ...current, tail: (current.tail + chunk).slice(-TAIL_LIMIT) };
    }
  }
  return bump(state, { live, tools });
}

/** Applies one server frame; frames of other sessions and unknown `t` values are ignored. */
export function applyFrame(state: TranscriptState, frame: ServerFrame): TranscriptState {
  if ("sessionId" in frame && frame.sessionId !== undefined && frame.sessionId !== state.sessionId)
    return state;
  switch (frame.t) {
    case "snapshot":
      return applySnapshot(state, frame);
    case "message":
      return applyMessage(state, frame);
    case "event":
      return applyEvent(state, frame.event);
    case "delta":
      return applyDelta(state, frame);
    case "tool_result": {
      const current =
        state.tools[frame.callId] ??
        toolFromCall({ id: frame.callId, name: "tool", arguments: "" });
      return bump(state, {
        tools: {
          ...state.tools,
          [frame.callId]: {
            ...current,
            result: frame.result,
            ...(frame.truncated ? { truncated: true } : {}),
            ...(current.status === "running" || current.status === "pending"
              ? { status: resultStatus(frame.result) }
              : {}),
          },
        },
      });
    }
    case "session_status":
      if (!state.session) return state;
      return bump(state, {
        session: {
          ...state.session,
          status: frame.status,
          ...(frame.title !== undefined ? { title: frame.title } : {}),
          ...(frame.updatedAt !== undefined ? { updatedAt: frame.updatedAt } : {}),
        },
      });
    default:
      return state;
  }
}

/** Applies a batch of frames (one rAF worth) in order. */
export const applyFrames = (state: TranscriptState, frames: ServerFrame[]): TranscriptState =>
  frames.reduce(applyFrame, state);

/** Shows a prompt instantly, before the server accepts it (RF-05). */
export const localEcho = (
  state: TranscriptState,
  echo: Omit<Echo, "state" | "error">,
): TranscriptState => bump(state, { echoes: [...state.echoes, { ...echo, state: "sending" }] });

export const failEcho = (state: TranscriptState, localId: string, error: string): TranscriptState =>
  bump(state, {
    echoes: state.echoes.map((e) => (e.localId === localId ? { ...e, state: "failed", error } : e)),
  });

export const dropEcho = (state: TranscriptState, localId: string): TranscriptState =>
  bump(state, { echoes: state.echoes.filter((e) => e.localId !== localId) });

/** A local Markdown note (command output) anchored after the latest message. */
export const addLocalNote = (state: TranscriptState, text: string): TranscriptState =>
  bump(state, {
    counter: state.counter + 1,
    entries: [
      ...state.entries,
      { kind: "note", key: `n${state.counter}`, anchor: state.maxSeq, text },
    ],
  });

/** Prepends an older page of messages (`GET /messages?before=`). */
export function prependOlder(
  state: TranscriptState,
  page: { items: Array<{ seq: number; message: Message; compacted?: boolean }>; hasMore: boolean },
): TranscriptState {
  const oldest = state.oldestSeq ?? Number.POSITIVE_INFINITY;
  const items = page.items.filter((i) => i.seq < oldest);
  const tools = { ...state.tools };
  const older = fromMessages(items, tools);
  return bump(state, {
    entries: [...older, ...state.entries],
    tools,
    hasMore: page.hasMore,
    oldestSeq: items[0]?.seq ?? state.oldestSeq,
    maxSeq: Math.max(state.maxSeq, items.at(-1)?.seq ?? -1),
  });
}

/** The rows to render, in order: entries, pending echoes, then the live run. */
export function visibleItems(state: TranscriptState): VisibleItem[] {
  const out: VisibleItem[] = [];
  const shown = new Set<string>();
  /** Cards of `ids`' results, placed right after those rows (outside the foldable rows). */
  const cards = (ids: string[], key: string) => {
    const artifacts = ids.flatMap((id) => artifactsOfResult(state.tools[id]?.result));
    if (artifacts.length) out.push({ kind: "artifacts", key, artifacts });
  };
  for (const entry of state.entries) {
    if (entry.kind === "assistant") {
      const { calls, ...rest } = entry;
      if (entry.text || entry.think) out.push(rest);
      for (const id of calls) {
        const tool = state.tools[id];
        if (!tool) continue;
        shown.add(id);
        out.push({ kind: "tool", key: `t${id}`, tool });
      }
      cards(calls, `a${entry.key}`);
    } else out.push(entry);
  }
  for (const echo of state.echoes) out.push({ kind: "echo", key: `e${echo.localId}`, echo });
  const live = state.live;
  if (live) {
    if (live.reasoning)
      out.push({ kind: "think", key: `think-${live.runId}`, text: live.reasoning });
    const liveIds = live.toolIds.filter((id) => state.tools[id] && !shown.has(id));
    for (const id of liveIds) {
      const tool = state.tools[id];
      if (tool) out.push({ kind: "tool", key: `t${id}`, tool });
    }
    cards(liveIds, `live-a${live.runId}`);
    if (live.text) out.push({ kind: "streaming", key: `live-${live.runId}`, text: live.text });
  }
  return out;
}
