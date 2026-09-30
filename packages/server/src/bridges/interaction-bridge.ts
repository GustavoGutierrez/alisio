import { randomUUID } from "node:crypto";
import type {
  AskQuestionsRequest,
  AskQuestionsResult,
  PendingInteraction,
  SelectRequest,
  ServerFrame,
} from "@alisio/sdk";

export interface InteractionHub {
  toSession(sessionId: string, frame: ServerFrame): void;
  toWorkspace(workspaceId: string, frame: ServerFrame): void;
  subscribers(sessionId: string): number;
  workspaceSubscribers(workspaceId: string): number;
}

export interface InteractionBridgeOptions {
  hub: InteractionHub;
  rootOf: (sessionId: string) => string;
  /** Workspace id of a session (to match workspace-wide requests in snapshots). */
  workspaceOf: (sessionId: string) => string | undefined;
  /** Give up (cancel) when nobody can answer for this long (default 30 s). */
  graceMs?: number;
  /** Give up after this long even with subscribers (default 10 min; 0 = no limit). */
  timeoutMs?: number;
  /** A plugin asked to show a session (`ui.open`). */
  onOpen?: (sessionId: string) => void;
  onChange?: (rootSessionId: string | undefined) => void;
}

interface Entry {
  interaction: PendingInteraction;
  /** Root session the request names, if any. */
  root?: string;
  settle: (answer: unknown) => void;
  validate: (answer: unknown) => boolean;
  grace?: ReturnType<typeof setTimeout>;
}

const RECENT = 500;

/**
 * Plugin UI requests (`ui.select`, `ui.askQuestions`, `ui.open`) for web clients (RF-18). A
 * request that names a session goes to its root session's streams; otherwise (every `select`)
 * to every stream watching the workspace. No answer means cancelled (`undefined`), like the
 * TUI without an interactive UI: fail-closed.
 */
export class InteractionBridge {
  private entries = new Map<string, Entry>();
  private recent = new Set<string>();
  private readonly graceMs: number;
  private readonly timeoutMs: number;

  constructor(private options: InteractionBridgeOptions) {
    this.graceMs = options.graceMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
  }

  /** The `PluginHost.setInteractiveUI` implementation for one workspace app. */
  uiFor(workspaceId: string): {
    select(request: SelectRequest): Promise<string | undefined>;
    askQuestions(request: AskQuestionsRequest): Promise<AskQuestionsResult>;
    open(sessionId: string): boolean;
  } {
    return {
      select: (request) =>
        this.ask<string | undefined>(
          {
            interactionId: randomUUID(),
            workspaceId,
            request: { kind: "select", select: { title: request.title, options: request.options } },
          },
          undefined,
          undefined,
          (answer) =>
            answer === null ||
            (typeof answer === "string" && request.options.some((o) => o.value === answer)),
          (answer) => (typeof answer === "string" ? answer : undefined),
        ),
      askQuestions: (request) => {
        const empty = (): AskQuestionsResult =>
          Object.fromEntries(request.questions.map((q) => [q.id, undefined]));
        const ids = new Set(request.questions.map((q) => q.id));
        return this.ask<AskQuestionsResult>(
          {
            interactionId: randomUUID(),
            ...(request.session ? { sessionId: request.session } : {}),
            workspaceId,
            request: {
              kind: "questions",
              questions: request.questions,
              ...(request.label ? { label: request.label } : {}),
            },
          },
          request.signal,
          empty(),
          (answer) =>
            answer === null ||
            (!!answer &&
              typeof answer === "object" &&
              !Array.isArray(answer) &&
              Object.entries(answer).every(
                ([id, value]) =>
                  ids.has(id) &&
                  (value === null ||
                    typeof value === "string" ||
                    (Array.isArray(value) && value.every((v) => typeof v === "string"))),
              )),
          (answer) => ({
            ...empty(),
            ...Object.fromEntries(
              Object.entries((answer ?? {}) as Record<string, unknown>).map(([id, value]) => [
                id,
                value === null ? undefined : (value as string | string[]),
              ]),
            ),
          }),
        );
      },
      open: (sessionId) => {
        this.options.onOpen?.(sessionId);
        return this.options.hub.workspaceSubscribers(workspaceId) > 0;
      },
    };
  }

  private ask<T>(
    interaction: PendingInteraction,
    signal: AbortSignal | undefined,
    cancelled: T,
    validate: (answer: unknown) => boolean,
    convert: (answer: unknown) => T,
  ): Promise<T> {
    if (signal?.aborted) return Promise.resolve(cancelled);
    const root = interaction.sessionId ? this.options.rootOf(interaction.sessionId) : undefined;
    return new Promise<T>((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => entry.settle(undefined);
      const entry: Entry = {
        interaction,
        ...(root ? { root } : {}),
        validate,
        settle: (answer) => {
          if (this.entries.get(interaction.interactionId) !== entry) return;
          this.entries.delete(interaction.interactionId);
          this.remember(interaction.interactionId);
          if (timeout) clearTimeout(timeout);
          if (entry.grace) clearTimeout(entry.grace);
          signal?.removeEventListener("abort", onAbort);
          this.send(entry, {
            t: "interaction_withdrawn",
            interactionId: interaction.interactionId,
          });
          this.options.onChange?.(root);
          resolve(answer === undefined ? cancelled : convert(answer));
        },
      };
      this.entries.set(interaction.interactionId, entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (this.timeoutMs > 0) timeout = setTimeout(() => entry.settle(undefined), this.timeoutMs);
      this.send(entry, { t: "interaction", interaction });
      this.watch(entry);
      this.options.onChange?.(root);
    });
  }

  private send(entry: Entry, frame: ServerFrame) {
    if (entry.root) this.options.hub.toSession(entry.root, frame);
    else this.options.hub.toWorkspace(entry.interaction.workspaceId, frame);
  }

  private watched(entry: Entry): boolean {
    return entry.root
      ? this.options.hub.subscribers(entry.root) > 0
      : this.options.hub.workspaceSubscribers(entry.interaction.workspaceId) > 0;
  }

  private watch(entry: Entry) {
    if (this.watched(entry)) {
      if (entry.grace) clearTimeout(entry.grace);
      entry.grace = undefined;
    } else
      entry.grace ??= setTimeout(() => {
        if (!this.watched(entry)) entry.settle(undefined);
        else entry.grace = undefined;
      }, this.graceMs);
  }

  subscribersChanged(): void {
    for (const entry of this.entries.values()) this.watch(entry);
  }

  private remember(id: string) {
    this.recent.add(id);
    if (this.recent.size > RECENT) this.recent.delete(this.recent.values().next().value as string);
  }

  /** Answers an interaction (`null` cancels it); the first valid answer wins. */
  resolve(
    interactionId: string,
    answer: unknown,
  ): "resolved" | "already_resolved" | "not_found" | "invalid" {
    const entry = this.entries.get(interactionId);
    if (!entry) return this.recent.has(interactionId) ? "already_resolved" : "not_found";
    if (!entry.validate(answer)) return "invalid";
    entry.settle(answer === null ? undefined : answer);
    return "resolved";
  }

  /** Interactions a stream subscribed to `sessionId` should see. */
  pending(sessionId?: string): PendingInteraction[] {
    const workspace = sessionId ? this.options.workspaceOf(sessionId) : undefined;
    return [...this.entries.values()]
      .filter(
        (entry) =>
          !sessionId ||
          entry.root === sessionId ||
          (!entry.root && entry.interaction.workspaceId === workspace),
      )
      .map((entry) => entry.interaction);
  }

  awaiting(rootSessionId: string): boolean {
    for (const entry of this.entries.values()) if (entry.root === rootSessionId) return true;
    return false;
  }

  cancelAll(): void {
    for (const entry of [...this.entries.values()]) entry.settle(undefined);
  }
}
