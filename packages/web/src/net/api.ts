/**
 * Typed JSON client for the `alisio serve` API (spec §8). Sends `X-Request-Id` on every call and
 * `Content-Type: application/json` on writes (the server also checks `Origin`, which browsers
 * send by themselves). Failures become `ApiRequestError` with the server's error code.
 */
import type {
  AgentInfo,
  ApiError,
  ApiErrorCode,
  BlobRef,
  CommandDescriptor,
  CommandOutcome,
  CredentialStatus,
  FileTreePage,
  HealthInfo,
  McpOverview,
  McpServerWire,
  Message,
  PendingApproval,
  PermissionPresetId,
  PluginInfo,
  PromptAccepted,
  ProviderConfigurationValue,
  ProviderModelsInfo,
  ProviderProfileInfo,
  ProvidersOverview,
  RunEvent,
  SessionChange,
  SessionContextUsage,
  SessionDetail,
  SessionModels,
  SessionSummary,
  SettingsOverview,
  SkillInfo,
  UiBlock,
  WorkspaceInfo,
} from "@alisio/sdk";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | "network",
    message: string,
    /** The server's `error.details` (e.g. `{path}` of `workspace_missing`). */
    readonly details?: unknown,
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
        parsed?.error?.details,
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
  prompt = (
    id: string,
    body: { requestId: string; text: string; display?: string; attachments?: BlobRef[] },
  ) => this.request<PromptAccepted>("POST", `/api/sessions/${enc(id)}/prompts`, body);
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
  events = (id: string, after: number, limit = 1000, types?: string[]) =>
    this.request<{ items: RunEvent[]; next?: string }>(
      "GET",
      `/api/sessions/${enc(id)}/events?after=${after}&limit=${limit}${types?.length ? `&types=${enc(types.join(","))}` : ""}`,
    );
  tree = (workspaceId: string, path: string, cursor?: string) =>
    this.request<FileTreePage>(
      "GET",
      `/api/workspaces/${enc(workspaceId)}/tree?path=${enc(path)}${cursor ? `&cursor=${enc(cursor)}` : ""}`,
    );
  diff = (workspaceId: string, path: string) =>
    this.request<UiBlock>("GET", `/api/workspaces/${enc(workspaceId)}/diff?path=${enc(path)}`);
  changes = (sessionId: string) =>
    this.request<{ files: SessionChange[] }>("GET", `/api/sessions/${enc(sessionId)}/changes`);
  // ---- Management (RF-14/15): every call names the workspace whose application it manages.
  plugins = (wid: string) =>
    this.request<PluginInfo[]>("GET", `/api/plugins?workspace=${enc(wid)}`);
  setPlugin = (wid: string, id: string, enabled: boolean) =>
    this.request<PluginInfo>("PATCH", `/api/plugins/${enc(id)}`, { workspace: wid, enabled });
  skills = (wid: string) => this.request<SkillInfo[]>("GET", `/api/skills?workspace=${enc(wid)}`);
  setSkill = (wid: string, id: string, enabled: boolean) =>
    this.request<SkillInfo>("PATCH", `/api/skills/${enc(id)}`, { workspace: wid, enabled });
  mcp = (wid: string) => this.request<McpOverview>("GET", `/api/mcp?workspace=${enc(wid)}`);
  setMcp = (wid: string, name: string, enabled: boolean, connect = false) =>
    this.request<McpServerWire>("PATCH", `/api/mcp/${enc(name)}`, {
      workspace: wid,
      enabled,
      ...(connect ? { connect } : {}),
    });
  mcpConsent = (wid: string, remember: boolean) =>
    this.request<McpOverview>("POST", "/api/mcp/consent", {
      workspace: wid,
      confirmed: true,
      ...(remember ? { remember } : {}),
    });
  agents = (wid: string) => this.request<AgentInfo[]>("GET", `/api/agents?workspace=${enc(wid)}`);
  settings = (wid: string) =>
    this.request<SettingsOverview>("GET", `/api/settings?workspace=${enc(wid)}`);
  setSetting = (wid: string, key: string, value: string | number | boolean | null) =>
    this.request<{ message: string }>("PATCH", "/api/settings", { workspace: wid, key, value });
  providers = (wid?: string) =>
    this.request<ProvidersOverview>("GET", `/api/providers${wid ? `?workspace=${enc(wid)}` : ""}`);
  providerModels = (wid: string) =>
    this.request<ProviderModelsInfo[]>("GET", `/api/models?workspace=${enc(wid)}`);
  saveProfile = (
    wid: string,
    name: string,
    body: { provider: string; values: Record<string, ProviderConfigurationValue>; model: string },
  ) =>
    this.request<ProviderProfileInfo>("PUT", `/api/providers/${enc(name)}`, {
      workspace: wid,
      ...body,
    });
  /** Write-only: the answer says only whether it is configured and a masked tail. */
  setCredentials = (name: string, secrets: { apiKey?: string; bearerToken?: string }) =>
    this.request<CredentialStatus>("PUT", `/api/providers/${enc(name)}/credentials`, secrets);
  deleteCredentials = (name: string) =>
    this.request<CredentialStatus>("DELETE", `/api/providers/${enc(name)}/credentials`);
  activateProvider = (wid: string, name: string, model: string) =>
    this.request<{ changed: boolean }>("POST", `/api/providers/${enc(name)}/activate`, {
      workspace: wid,
      model,
    });
  fileUrl = (workspaceId: string, path: string, download = false) =>
    `/api/workspaces/${enc(workspaceId)}/file?path=${enc(path)}${download ? "&download=1" : ""}`;

  /** A workspace file for preview: its sniffed type, size, truncation and bytes. */
  async file(
    workspaceId: string,
    path: string,
  ): Promise<{ contentType: string; truncated: boolean; size: number; blob: Blob }> {
    const res = await this.raw(this.fileUrl(workspaceId, path));
    return {
      contentType: res.headers.get("Content-Type") ?? "application/octet-stream",
      truncated: res.headers.get("X-Truncated") === "true",
      size: Number(res.headers.get("X-File-Size") ?? 0),
      blob: await res.blob(),
    };
  }

  /** Uploads an image; the server sniffs its bytes and answers its content-addressed reference. */
  async upload(file: Blob): Promise<BlobRef> {
    const res = await this.raw("/api/blobs", {
      method: "POST",
      body: file,
      contentType: file.type || "application/octet-stream",
    });
    return (await res.json()) as BlobRef;
  }

  /** A GET or binary POST whose successful body the caller reads itself. */
  async raw(path: string, init: { method?: string; body?: Blob; contentType?: string } = {}) {
    const headers: Record<string, string> = {
      "X-Request-Id": (this.options.requestId ?? newId)().replace(/[^A-Za-z0-9_-]/g, ""),
    };
    if (init.contentType) headers["Content-Type"] = init.contentType;
    let res: Response;
    try {
      res = await this.fetcher(path, {
        method: init.method ?? "GET",
        headers,
        credentials: "same-origin",
        ...(init.body ? { body: init.body } : {}),
      });
    } catch (error) {
      throw new ApiRequestError(
        0,
        "network",
        error instanceof Error ? error.message : "Network error",
      );
    }
    if (res.status === 401) this.options.onUnauthorized?.();
    if (!res.ok) {
      let parsed: Partial<ApiError> | undefined;
      try {
        parsed = JSON.parse(await res.text()) as ApiError;
      } catch {
        /* not JSON */
      }
      throw new ApiRequestError(
        res.status,
        parsed?.error?.code ?? "internal",
        parsed?.error?.message ?? `HTTP ${res.status}`,
        parsed?.error?.details,
      );
    }
    return res;
  }
}

const enc = encodeURIComponent;
