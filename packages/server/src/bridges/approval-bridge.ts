import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ExternalDirectoryHandler,
  ExternalDirectoryRequest,
} from "@alisio/core";
import type { PendingApproval, ServerFrame } from "@alisio/sdk";

/** What the bridges need from the SSE hub. */
export interface BridgeHub {
  toSession(sessionId: string, frame: ServerFrame): void;
  subscribers(sessionId: string): number;
}

export interface ApprovalBridgeOptions {
  hub: BridgeHub;
  /** Root of a session (children's approvals show in their root session view). */
  rootOf: (sessionId: string) => string;
  /** Current run of a session, when known. */
  runOf?: (sessionId: string) => string | undefined;
  /** Deny when the root session has no subscriber for this long (default 30 s). */
  graceMs?: number;
  /** Deny after this long even with subscribers (default 10 min; 0 = no limit). */
  timeoutMs?: number;
  /** Called when a root session starts or stops waiting for a decision. */
  onChange?: (rootSessionId: string) => void;
}

interface Entry {
  approval: PendingApproval;
  settle: (decision: ApprovalDecision, reason?: "cancelled" | "timeout") => void;
  grace?: ReturnType<typeof setTimeout>;
}

const MAX_INPUT = 4_096;
const RECENT = 500;

const pretty = (value: unknown): string => {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? "";
  } catch {
    text = String(value);
  }
  return text.length > MAX_INPUT ? `${text.slice(0, MAX_INPUT)}\n…` : text;
};

/**
 * Web approvals for the runner's `ApprovalHandler` and the external-directory handler (§8.7).
 * Fail-closed: the answer is `deny` when the run aborts, when nobody watches the root session
 * for `graceMs`, or after `timeoutMs`. The first answer wins; later ones are refused.
 */
export class ApprovalBridge {
  private entries = new Map<string, Entry>();
  private recent = new Set<string>();
  private readonly graceMs: number;
  private readonly timeoutMs: number;

  constructor(private options: ApprovalBridgeOptions) {
    this.graceMs = options.graceMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
  }

  /** Passed as `AppOptions.approve` for every workspace app. */
  readonly handler: ApprovalHandler = (request) => {
    const session = request.session ?? "";
    return this.ask(
      {
        approvalId: `${session}:${request.call.id}`,
        sessionId: session,
        rootSessionId: this.options.rootOf(session),
        kind: "effect",
        callId: request.call.id,
        name: request.call.name,
        effect: request.effect,
        ...(request.label ? { label: request.label } : {}),
        input: pretty(request.input),
      },
      request.signal,
    );
  };

  /** Passed as `AppOptions.approveExternalDirectory` for every workspace app. */
  readonly directoryHandler: ExternalDirectoryHandler = (request: ExternalDirectoryRequest) => {
    const session = request.session ?? "";
    return this.ask(
      {
        approvalId: `${session}:dir:${randomUUID()}`,
        sessionId: session,
        rootSessionId: this.options.rootOf(session),
        kind: "directory",
        directory: request.directory,
        ...(request.label ? { label: request.label } : {}),
        input: pretty({ directory: request.directory, path: request.path }),
      },
      request.signal,
    );
  };

  private ask(base: PendingApproval, signal: AbortSignal): Promise<ApprovalDecision> {
    if (signal.aborted) return Promise.resolve("deny");
    const runId = this.options.runOf?.(base.rootSessionId);
    const approval: PendingApproval = {
      ...base,
      ...(runId ? { runId } : {}),
      ...(this.timeoutMs > 0 ? { expiresAt: Date.now() + this.timeoutMs } : {}),
    };
    return new Promise<ApprovalDecision>((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => entry.settle("deny", "cancelled");
      const entry: Entry = {
        approval,
        settle: (decision, reason) => {
          if (this.entries.get(approval.approvalId) !== entry) return;
          this.entries.delete(approval.approvalId);
          this.remember(approval.approvalId);
          if (timeout) clearTimeout(timeout);
          if (entry.grace) clearTimeout(entry.grace);
          signal.removeEventListener("abort", onAbort);
          this.send(approval, {
            t: "approval_withdrawn",
            approvalId: approval.approvalId,
            reason: reason ?? "resolved_elsewhere",
          });
          this.options.onChange?.(approval.rootSessionId);
          resolve(decision);
        },
      };
      this.entries.set(approval.approvalId, entry);
      signal.addEventListener("abort", onAbort, { once: true });
      if (this.timeoutMs > 0)
        timeout = setTimeout(() => entry.settle("deny", "timeout"), this.timeoutMs);
      this.send(approval, { t: "approval", approval });
      this.watch(entry);
      this.options.onChange?.(approval.rootSessionId);
    });
  }

  private send(approval: PendingApproval, frame: ServerFrame) {
    this.options.hub.toSession(approval.rootSessionId, frame);
    if (approval.sessionId !== approval.rootSessionId)
      this.options.hub.toSession(approval.sessionId, frame);
  }

  private watched(approval: PendingApproval): boolean {
    return (
      this.options.hub.subscribers(approval.rootSessionId) > 0 ||
      this.options.hub.subscribers(approval.sessionId) > 0
    );
  }

  /** Starts the grace timer when nobody watches; clears it when someone does. */
  private watch(entry: Entry) {
    if (this.watched(entry.approval)) {
      if (entry.grace) clearTimeout(entry.grace);
      entry.grace = undefined;
    } else
      entry.grace ??= setTimeout(() => {
        if (!this.watched(entry.approval)) entry.settle("deny", "timeout");
        else entry.grace = undefined;
      }, this.graceMs);
  }

  /** Re-evaluates grace timers after streams connect or disconnect. */
  subscribersChanged(): void {
    for (const entry of this.entries.values()) this.watch(entry);
  }

  private remember(id: string) {
    this.recent.add(id);
    if (this.recent.size > RECENT) this.recent.delete(this.recent.values().next().value as string);
  }

  /** Answers an approval; the first answer wins. */
  resolve(
    approvalId: string,
    decision: ApprovalDecision,
  ): "resolved" | "already_resolved" | "not_found" {
    const entry = this.entries.get(approvalId);
    if (!entry) return this.recent.has(approvalId) ? "already_resolved" : "not_found";
    entry.settle(decision);
    return "resolved";
  }

  /** Pending approvals, optionally of one root session (or of the session itself). */
  pending(sessionId?: string): PendingApproval[] {
    return [...this.entries.values()]
      .map((entry) => entry.approval)
      .filter(
        (approval) =>
          !sessionId || approval.rootSessionId === sessionId || approval.sessionId === sessionId,
      );
  }

  awaiting(rootSessionId: string): boolean {
    for (const entry of this.entries.values())
      if (entry.approval.rootSessionId === rootSessionId) return true;
    return false;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Denies everything (shutdown). */
  denyAll(): void {
    for (const entry of [...this.entries.values()]) entry.settle("deny", "cancelled");
  }
}
