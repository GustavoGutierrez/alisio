/**
 * Typed JSON client for the `alisio serve` API (spec §8). Sends `X-Request-Id` on every call and
 * `Content-Type: application/json` on writes (the server also checks `Origin`, which browsers
 * send by themselves). Failures become `ApiRequestError` with the server's error code.
 */
import type {
  ApiError,
  ApiErrorCode,
  CommandDescriptor,
  CommandOutcome,
  HealthInfo,
  Message,
  PendingApproval,
  PermissionPresetId,
  PromptAccepted,
  SessionContextUsage,
  SessionDetail,
  SessionModels,
  SessionSummary,
  WorkspaceInfo,
} from "@alisio/sdk";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | "network",
    message: string,
  ) {
    super(message);
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  fetch?: FetchLike;
  /** Called on 401: the cookie is missing or expired (open the launch URL again). */
  onUnauthorized?: () => void;
  requestId?: () => string;
}

export const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

export interface MessagePage {
  items: Array<{ seq: number; message: Message; compacted: boolean }>;
  hasMore: boolean;
}

export class ApiClient {
  private readonly fetcher: FetchLike;
  constructor(private options: ApiClientOptions = {}) {
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      "X-Request-Id": (this.options.requestId ?? newId)().replace(/[^A-Za-z0-9_-]/g, ""),
      Accept: "application/json",
    };
    if (method !== "GET") headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetcher(path, {
        method,
        headers,
        credentials: "same-origin",
        ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}),
      });
    } catch (error) {
      throw new ApiRequestError(
        0,
        "network",
        error instanceof Error ? error.message : "Network error",
      );
    }
    if (res.status === 401) this.options.onUnauthorized?.();
    const text = await res.text();
    if (!res.ok) {
      let parsed: Partial<ApiError> | undefined;
      try {
        parsed = JSON.parse(text) as ApiError;
      } catch {
        /* not JSON */
      }
      throw new ApiRequestError(
        res.status,
        parsed?.error?.code ?? "internal",
        parsed?.error?.message ?? `HTTP ${res.status}`,
      );
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  health = () => this.request<HealthInfo>("GET", "/api/health");
  workspaces = () => this.request<WorkspaceInfo[]>("GET", "/api/workspaces");
  addWorkspace = (path: string) => this.request<WorkspaceInfo>("POST", "/api/workspaces", { path });
  sessions = (query: { archived?: "true" | "false" | "all"; limit?: number } = {}) =>
    this.request<{ items: SessionSummary[]; next?: string }>(
      "GET",
      `/api/sessions?archived=${query.archived ?? "false"}&limit=${query.limit ?? 200}`,
    );
  createSession = (body: { workspace: string; preset?: PermissionPresetId; model?: string }) =>
    this.request<SessionDetail>("POST", "/api/sessions", body);
  session = (id: string) => this.request<SessionDetail>("GET", `/api/sessions/${enc(id)}`);
  patchSession = (
    id: string,
    patch: Partial<{
      title: string | null;
      model: string;
      effort: string | null;
      preset: PermissionPresetId;
      agent: string | null;
      pinned: boolean;
      archived: boolean;
    }>,
  ) => this.request<SessionDetail>("PATCH", `/api/sessions/${enc(id)}`, patch);
  messages = (id: string, before: number, limit = 50) =>
    this.request<MessagePage>(
      "GET",
      `/api/sessions/${enc(id)}/messages?before=${before}&limit=${limit}`,
    );
  prompt = (id: string, body: { requestId: string; text: string; display?: string }) =>
    this.request<PromptAccepted>("POST", `/api/sessions/${enc(id)}/prompts`, body);
  cancel = (id: string) =>
    this.request<{ cancelled: boolean }>("POST", `/api/sessions/${enc(id)}/cancel`, {});
  commands = (sessionId?: string) =>
    this.request<CommandDescriptor[]>(
      "GET",
      `/api/commands${sessionId ? `?session=${enc(sessionId)}` : ""}`,
    );
  command = (id: string, body: { requestId: string; name: string; args?: string }) =>
    this.request<CommandOutcome>("POST", `/api/sessions/${enc(id)}/commands`, body);
  models = (id: string) => this.request<SessionModels>("GET", `/api/sessions/${enc(id)}/models`);
  context = (id: string) =>
    this.request<SessionContextUsage>("GET", `/api/sessions/${enc(id)}/context`);
  approvals = (sessionId: string) =>
    this.request<PendingApproval[]>("GET", `/api/approvals?session=${enc(sessionId)}`);
  decide = (approvalId: string, decision: "once" | "session" | "deny") =>
    this.request<{ resolved: true }>("POST", `/api/approvals/${enc(approvalId)}`, { decision });
  answer = (interactionId: string, answer: unknown) =>
    this.request<{ resolved: true }>("POST", `/api/interactions/${enc(interactionId)}`, {
      answer,
    });
  exportUrl = (id: string) => `/api/sessions/${enc(id)}/export`;
}

const enc = encodeURIComponent;
