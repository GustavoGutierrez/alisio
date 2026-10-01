/**
 * The agent definition service every surface (web server, TUI) uses: CRUD over the project and
 * global `.agents/agents` scopes, the merged listing (a project agent overrides the global one
 * with the same id) and the hot-reload of the runtime agent registry after each write.
 *
 * The runtime registry belongs to the subagents plugin (it discovers agent files at setup and
 * publishes them through plugin state). After a write the service asks it to rediscover and then
 * checks whether the saved file is actually loaded, so callers report `live: true` only when the
 * change is usable by the next prompt; otherwise they must tell the user to restart.
 */
import type { AgentDefinitionInfo, AgentDefinitionInput, AgentScope } from "@alisio/sdk";
import { AgentNotFoundError, AgentScopeStore, agentScopeDir } from "./definitions.ts";

/** The runtime registry the service refreshes (implemented by the application). */
export interface AgentRegistry {
  /** Rediscovers agent files; false when no registry can reload (e.g. subagents plugin off). */
  reload(): Promise<boolean>;
  /** Absolute paths of the agent files currently loaded, or undefined when unknown. */
  loadedPaths(): string[] | undefined;
}

export interface AgentChange<T> {
  result: T;
  /**
   * The runtime registry reflects the change now (new prompts use it). False: the file is saved,
   * but Alisio must restart (or the workspace must be trusted / the plugin enabled) to use it.
   */
  live: boolean;
}

export interface AgentDefinitionServiceOptions {
  /** Workspace root; without it only the global scope exists. */
  workspace?: string;
  /** Home directory of the global scope (`os.homedir()`). */
  home: string;
  registry?: AgentRegistry;
  now?: () => number;
}

/** Applies the project-over-global precedence and marks both sides of an override. */
export function mergeAgentScopes(
  project: AgentDefinitionInfo[],
  global: AgentDefinitionInfo[],
): AgentDefinitionInfo[] {
  const projectIds = new Set(project.map((a) => a.id));
  const globalIds = new Set(global.map((a) => a.id));
  const byName = (a: AgentDefinitionInfo, b: AgentDefinitionInfo) =>
    a.name.localeCompare(b.name) || (a.scope === b.scope ? 0 : a.scope === "project" ? -1 : 1);
  return [
    ...project.map((a) => (globalIds.has(a.id) ? { ...a, overridesGlobal: true } : a)),
    ...global.map((a) => (projectIds.has(a.id) ? { ...a, overriddenByProject: true } : a)),
  ].sort(byName);
}

export class AgentDefinitionService {
  private readonly stores: Partial<Record<AgentScope, AgentScopeStore>> = {};
  constructor(private readonly options: AgentDefinitionServiceOptions) {
    this.stores.global = new AgentScopeStore(
      "global",
      agentScopeDir("global", options),
      options.now,
    );
    if (options.workspace)
      this.stores.project = new AgentScopeStore(
        "project",
        agentScopeDir("project", options),
        options.now,
      );
  }

  /** Scopes available here: `project` only with a workspace. */
  get scopes(): AgentScope[] {
    return this.stores.project ? ["project", "global"] : ["global"];
  }

  /** The scope new agents default to: the project when a workspace is open. */
  get defaultScope(): AgentScope {
    return this.stores.project ? "project" : "global";
  }

  dir(scope: AgentScope): string {
    return this.store(scope).dir;
  }

  private store(scope: AgentScope): AgentScopeStore {
    const store = this.stores[scope];
    if (!store) throw new Error(`The ${scope} scope is not available without a workspace`);
    return store;
  }

  async list(): Promise<AgentDefinitionInfo[]> {
    const [project, global] = await Promise.all([
      this.stores.project?.list() ?? Promise.resolve([]),
      this.store("global").list(),
    ]);
    return mergeAgentScopes(project, global);
  }

  async get(scope: AgentScope, id: string): Promise<AgentDefinitionInfo | undefined> {
    const all = await this.list();
    return all.find((a) => a.scope === scope && a.id === id);
  }

  async create(
    scope: AgentScope,
    input: AgentDefinitionInput,
  ): Promise<AgentChange<AgentDefinitionInfo>> {
    const created = await this.store(scope).create(input);
    return this.settle(created.id, scope, created.path, true);
  }

  async update(
    scope: AgentScope,
    id: string,
    input: AgentDefinitionInput,
  ): Promise<AgentChange<AgentDefinitionInfo>> {
    const updated = await this.store(scope).update(id, input);
    return this.settle(updated.id, scope, updated.path, true);
  }

  async delete(scope: AgentScope, id: string): Promise<AgentChange<boolean>> {
    const store = this.store(scope);
    const existing = await store.get(id);
    if (!existing) throw new AgentNotFoundError(scope, id);
    const deleted = await store.delete(id);
    const live = (await this.reload()) && !this.isLoaded(existing.path);
    return { result: deleted, live };
  }

  /** Asks the runtime registry to rediscover agent files (false: nothing could reload). */
  async reload(): Promise<boolean> {
    if (!this.options.registry) return false;
    try {
      return await this.options.registry.reload();
    } catch {
      return false;
    }
  }

  /** Whether the runtime registry has `path` loaded (false when unknown). */
  isLoaded(path: string): boolean {
    return !!this.options.registry?.loadedPaths()?.includes(path);
  }

  private async settle(
    id: string,
    scope: AgentScope,
    path: string,
    mustBeLoaded: boolean,
  ): Promise<AgentChange<AgentDefinitionInfo>> {
    const reloaded = await this.reload();
    const result = (await this.get(scope, id)) as AgentDefinitionInfo;
    return { result, live: reloaded && this.isLoaded(path) === mustBeLoaded };
  }
}
