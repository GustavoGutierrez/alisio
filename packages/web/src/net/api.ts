/**
 * Typed JSON client for the `alisio serve` API (spec §8). Sends `X-Request-Id` on every call and
 * `Content-Type: application/json` on writes (the server also checks `Origin`, which browsers
 * send by themselves). Failures become `ApiRequestError` with the server's error code.
 */
import type {
  AgentDefinitionInfo,
  AgentDefinitionInput,
  AgentDefinitionsOverview,
  AgentDraft,
  AgentInfo,
  AgentModelOption,
  AgentSaveResult,
  AgentScope,
  AgentTemplateInfo,
  AnalysisStatus,
  ApiError,
  ApiErrorCode,
  ArtifactRef,
  BackgroundTaskInfo,
  BackgroundTaskOutput,
  BlobRef,
  CapabilityGrantWire,
  ChangelogView,
  CommandDescriptor,
  CommandOutcome,
  CredentialStatus,
  DatasetDetailWire,
  DatasetRef,
  DatasetRowsPage,
  DirectoryListing,
  FileTreePage,
  FolderPickResult,
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
  ReloadReport,
  RunEvent,
  SessionChange,
  SessionContextUsage,
  SessionDetail,
  SessionModels,
  SessionSummary,
  SettingsOverview,
  SideQuestionEntry,
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

/**
 * A VSCode-style icon theme as served by the server. Only the lookup maps the web resolves are
 * typed; the server sends the manifest as-is.
 */
export interface IconThemeManifest {
  iconDefinitions?: Record<string, { iconPath: string }>;
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileNames?: Record<string, string>;
  fileExtensions?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
}

/** `GET /api/artifacts/:aid`: the reference plus its files and public provenance. */
export interface ArtifactDetail extends ArtifactRef {
  entry?: string;
  files: Array<{ path: string; bytes: number }>;
  provenance: Record<string, unknown>;
}

export class ApiClient {
  private readonly fetcher: FetchLike;
  constructor(private options: ApiClientOptions = {}) {
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    init: { signal?: AbortSignal } = {},
  ): Promise<T> {
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
        ...(init.signal ? { signal: init.signal } : {}),
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
  workspaces = (archived: "true" | "false" | "all" = "false") =>
    this.request<WorkspaceInfo[]>("GET", `/api/workspaces?archived=${archived}`);
  addWorkspace = (path: string) => this.request<WorkspaceInfo>("POST", "/api/workspaces", { path });
  patchWorkspace = (
    id: string,
    patch: Partial<{ label: string | null; pinned: boolean; archived: boolean }>,
  ) => this.request<WorkspaceInfo>("PATCH", `/api/workspaces/${enc(id)}`, patch);
  /** Grants or withdraws project trust (the caller must have asked the user to confirm). */
  trustWorkspace = (id: string, trusted: boolean) =>
    this.request<WorkspaceInfo>("POST", `/api/workspaces/${enc(id)}/trust`, {
      trusted,
      confirmed: true,
    });
  /** Opens the native folder dialog on the server's desktop and waits for the user. */
  pickFolder = (start?: string) =>
    this.request<FolderPickResult>("POST", "/api/workspaces/pick", start ? { start } : {});
  /** Subdirectory names of `path` (home when omitted) for the in-app folder browser. */
  listDirs = (path?: string, hidden = false) =>
    this.request<DirectoryListing>(
      "GET",
      `/api/fs/dirs?${path !== undefined ? `path=${encodeURIComponent(path)}&` : ""}hidden=${hidden}`,
    );
  sessions = (query: { archived?: "true" | "false" | "all"; limit?: number } = {}) =>
    this.request<{ items: SessionSummary[]; next?: string }>(
      "GET",
      `/api/sessions?archived=${query.archived ?? "false"}&limit=${query.limit ?? 200}`,
    );
  createSession = (body: {
    workspace: string;
    preset?: PermissionPresetId;
    model?: string;
    agent?: string;
  }) => this.request<SessionDetail>("POST", "/api/sessions", body);
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
    body: {
      requestId: string;
      text: string;
      display?: string;
      attachments?: BlobRef[];
      datasets?: string[];
    },
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
  /** `/btw` side questions of a session, oldest first. */
  sideQuestions = (id: string) =>
    this.request<SideQuestionEntry[]>("GET", `/api/sessions/${enc(id)}/btw`);
  /** Asks a side question (never added to the conversation); abort `signal` to drop it. */
  askSideQuestion = (id: string, question: string, signal?: AbortSignal) =>
    this.request<SideQuestionEntry>(
      "POST",
      `/api/sessions/${enc(id)}/btw`,
      { question },
      signal ? { signal } : {},
    );
  cancelSideQuestions = (id: string) =>
    this.request<{ cancelled: boolean }>("POST", `/api/sessions/${enc(id)}/btw/cancel`, {});
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
  /** Background tasks of a root session (shell tasks plus the read-only subagent mirror). */
  tasks = (sessionId: string) =>
    this.request<{ tasks: BackgroundTaskInfo[] }>("GET", `/api/sessions/${enc(sessionId)}/tasks`);
  /** One incremental read of a task log: pass the previous `nextOffset` as `offset`. */
  taskOutput = (sessionId: string, taskId: string, offset: number) =>
    this.request<BackgroundTaskOutput>(
      "GET",
      `/api/sessions/${enc(sessionId)}/tasks/${enc(taskId)}/output?offset=${offset}`,
    );
  /** Stops a task as the user (it ends `cancelled`). */
  stopTask = (sessionId: string, taskId: string) =>
    this.request<{ task: BackgroundTaskInfo }>(
      "POST",
      `/api/sessions/${enc(sessionId)}/tasks/${enc(taskId)}/stop`,
      {},
    );
  exportUrl = (id: string) => `/api/sessions/${enc(id)}/export`;
  /** Artifacts of a session's root, newest first (including deleted/expired, for cards). */
  artifacts = (sessionId: string) =>
    this.request<{ items: ArtifactRef[]; next?: string }>(
      "GET",
      `/api/sessions/${enc(sessionId)}/artifacts?limit=200`,
    );
  /** One artifact: its reference, entry, file list and public provenance (no paths). */
  artifact = (id: string) => this.request<ArtifactDetail>("GET", `/api/artifacts/${enc(id)}`);
  /** A signed, expiring link for the isolated viewer (dashboards and PDFs). */
  artifactView = (id: string) =>
    this.request<{ url: string; expiresAt: number }>("POST", `/api/artifacts/${enc(id)}/view`, {});
  /** Copies an artifact into the workspace as a tool call of its session (the write gate asks). */
  exportArtifact = (id: string, target: string, overwrite = false) =>
    this.request<{ runId: string; status: string }>("POST", `/api/artifacts/${enc(id)}/export`, {
      target,
      ...(overwrite ? { overwrite: true } : {}),
    });
  /** Runs the analysis behind an artifact again (same script and inputs; a new execution). */
  rerunArtifact = (id: string) =>
    this.request<{ runId: string; status: string }>("POST", `/api/artifacts/${enc(id)}/rerun`, {});
  deleteArtifact = (id: string) =>
    this.request<{ deleted: true }>("DELETE", `/api/artifacts/${enc(id)}`);
  /** URL of one file of an artifact (panel previews; never HTML inline). */
  artifactFileUrl = (id: string, path: string) =>
    `/api/artifacts/${enc(id)}/files/${path.split("/").map(enc).join("/")}`;
  artifactSourcesUrl = (id: string) => `/api/artifacts/${enc(id)}/sources`;
  /** The text of one artifact file. */
  async artifactText(id: string, path: string): Promise<string> {
    return (await this.raw(this.artifactFileUrl(id, path))).text();
  }
  /** Datasets of a session's root, newest first. */
  datasets = (sessionId: string) =>
    this.request<{ items: DatasetRef[] }>("GET", `/api/sessions/${enc(sessionId)}/datasets`);
  /** Schema and statistics of every sheet of a dataset. */
  dataset = (id: string) => this.request<DatasetDetailWire>("GET", `/api/datasets/${enc(id)}`);
  /** One keyset-paginated page of a sheet. */
  datasetRows = (
    id: string,
    query: {
      sheet?: string;
      after?: string;
      offset?: number;
      limit?: number;
      sort?: string;
      dir?: "asc" | "desc";
      filter?: string;
      column?: string;
    },
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== "") params.set(key, String(value));
    return this.request<DatasetRowsPage>(
      "GET",
      `/api/datasets/${enc(id)}/rows?${params}`,
      undefined,
      signal ? { signal } : {},
    );
  };
  /** The original uploaded file of a dataset (only for datasets uploaded from the web). */
  datasetDownloadUrl = (id: string) => `/api/datasets/${enc(id)}/download`;
  /** Ingests a spreadsheet artifact the first time it is opened; `pending` means ask again. */
  artifactDataset = (id: string) =>
    this.request<{ dataset: DatasetRef | null; pending: boolean }>(
      "POST",
      `/api/artifacts/${enc(id)}/dataset`,
      {},
    );
  /**
   * Uploads a data file as the raw body. `202` answers `pending` (a `dataset_ready` or
   * `dataset_failed` frame follows); `200` returns a dataset already ingested in this session.
   */
  async uploadDataset(
    sessionId: string,
    file: File,
  ): Promise<{ dataset: DatasetRef | null; pending: boolean }> {
    const res = await this.raw(`/api/sessions/${enc(sessionId)}/datasets`, {
      method: "POST",
      body: file,
      contentType: "application/octet-stream",
      headers: { "X-File-Name": encodeURIComponent(file.name) },
    });
    return (await res.json()) as { dataset: DatasetRef | null; pending: boolean };
  }
  capabilities = (sessionId: string) =>
    this.request<{ items: CapabilityGrantWire[] }>(
      "GET",
      `/api/sessions/${enc(sessionId)}/capabilities`,
    );
  revokeCapability = (sessionId: string, grantId: string) =>
    this.request<{ revoked: true }>(
      "DELETE",
      `/api/sessions/${enc(sessionId)}/capabilities/${enc(grantId)}`,
    );
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
  /** The shipped changelog (offline): the newest entries, or `version`; `lastSeen` asks for news. */
  changelog = (params: { version?: string; lastSeen?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.version) query.set("version", params.version);
    if (params.lastSeen) query.set("lastSeen", params.lastSeen);
    const text = query.toString();
    return this.request<ChangelogView>("GET", `/api/changelog${text ? `?${text}` : ""}`);
  };
  /** `/reload` of a workspace (the web client usually goes through the `reload` command). */
  reloadWorkspace = (wid: string) =>
    this.request<ReloadReport>("POST", `/api/workspaces/${enc(wid)}/reload`, {});
  // ---- Agent definitions (`.agents/agents` files; project scope needs a workspace).
  agentDefinitions = (wid?: string) =>
    this.request<AgentDefinitionsOverview>(
      "GET",
      `/api/agents/definitions${wid ? `?workspace=${enc(wid)}` : ""}`,
    );
  agentTemplates = () => this.request<AgentTemplateInfo[]>("GET", "/api/agents/templates");
  agentModels = (wid: string) =>
    this.request<AgentModelOption[]>("GET", `/api/agents/models?workspace=${enc(wid)}`);
  createAgent = (body: AgentDefinitionInput & { workspace?: string; scope: AgentScope }) =>
    this.request<AgentSaveResult>("POST", "/api/agents", body);
  updateAgent = (
    id: string,
    body: AgentDefinitionInput & { workspace?: string; scope: AgentScope },
  ) => this.request<AgentSaveResult>("PUT", `/api/agents/${enc(id)}`, body);
  deleteAgent = (id: string, scope: AgentScope, wid?: string) =>
    this.request<{ deleted: boolean; live: boolean }>(
      "DELETE",
      `/api/agents/${enc(id)}?scope=${scope}${wid ? `&workspace=${enc(wid)}` : ""}`,
    );
  agentDefinition = (id: string, scope: AgentScope, wid?: string) =>
    this.request<AgentDefinitionInfo>(
      "GET",
      `/api/agents/${enc(id)}?scope=${scope}${wid ? `&workspace=${enc(wid)}` : ""}`,
    );
  /** The active model drafts (or refines `base`); abort `signal` to cancel the model call. */
  draftAgent = (
    body: {
      workspace: string;
      description?: string;
      base?: { name?: string; description?: string; instructions?: string };
    },
    signal?: AbortSignal,
  ) => this.request<AgentDraft>("POST", "/api/agents/draft", body, signal ? { signal } : {});
  /** Sessions started with (or switched to) an agent. */
  agentSessions = (agent: string) =>
    this.request<{ items: SessionSummary[] }>(
      "GET",
      `/api/sessions?agent=${enc(agent)}&archived=all&limit=50`,
    );
  settings = (wid: string) =>
    this.request<SettingsOverview>("GET", `/api/settings?workspace=${enc(wid)}`);
  /** The state of the data-analysis runtime (Settings → Data analysis). */
  analysis = (wid: string) =>
    this.request<AnalysisStatus>("GET", `/api/analysis?workspace=${enc(wid)}`);
  setSetting = (wid: string, key: string, value: string | number | boolean | null) =>
    this.request<{ message: string }>("PATCH", "/api/settings", { workspace: wid, key, value });
  // ---- Icon themes (web UI): the catalog, the active theme's manifest and its SVGs.
  /** Available icon themes and the active one for `workspace` (`none` when no theme is active). */
  iconThemes = (workspace: string) =>
    this.request<{ active: string; themes: Array<{ id: string; label: string }> }>(
      "GET",
      `/api/icon-themes?workspace=${enc(workspace)}`,
    );
  /** The active theme's manifest; the server answers 404 when no theme is active. */
  iconThemeManifest = (workspace: string) =>
    this.request<IconThemeManifest>("GET", `/api/icon-theme/manifest?workspace=${enc(workspace)}`);
  /** URL of one SVG of the active icon theme (served by the server, never bundled). */
  iconThemeIconUrl = (workspace: string, name: string): string =>
    `/api/icon-theme/icons/${encodeURIComponent(name)}?workspace=${enc(workspace)}`;
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
  async raw(
    path: string,
    init: {
      method?: string;
      body?: Blob;
      contentType?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    const headers: Record<string, string> = {
      "X-Request-Id": (this.options.requestId ?? newId)().replace(/[^A-Za-z0-9_-]/g, ""),
      ...(init.headers ?? {}),
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
