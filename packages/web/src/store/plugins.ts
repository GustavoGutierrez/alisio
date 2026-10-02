/**
 * Plugin availability for the open workspace and the header tabs that depend on it. Pure: the
 * signal and the actions that feed it live in `app.ts`. "Is plugin X enabled" is generic; the
 * Memory tab is its first consumer.
 */
import type { PluginInfo } from "@alisio/sdk";

/** The session view tabs (RF-10); `memory` exists only while the memory plugin is enabled. */
export type SessionTab = "conversation" | "trajectory" | "memory";
export const MEMORY_PLUGIN = "memory";

/** The plugin list of one workspace; `list` is absent until loaded (`failed`: the load failed). */
export interface PluginsState {
  workspace: string;
  list?: PluginInfo[];
  failed?: boolean;
}
export type PluginAvailability = "enabled" | "disabled" | "loading" | "error";

export const emptyPlugins: PluginsState = { workspace: "" };

/** A failed refresh keeps the last list of the same workspace; otherwise the state is `failed`. */
export const pluginsFailed = (previous: PluginsState, workspace: string): PluginsState =>
  previous.workspace === workspace && previous.list ? previous : { workspace, failed: true };

/**
 * Whether plugin `id` can serve the current workspace now. `enabled` needs the user's choice
 * (`enabled`) AND the running plugin (`status: "active"`): a plugin disabled while it still runs
 * (`restart-required`) is off, and one enabled but not loaded yet cannot answer its views.
 */
export function pluginAvailability(
  state: PluginsState,
  workspace: string | undefined,
  id: string,
): PluginAvailability {
  if (!workspace || state.workspace !== workspace) return "loading";
  if (!state.list) return state.failed ? "error" : "loading";
  const entry = state.list.find((plugin) => plugin.id === id);
  return entry?.enabled && entry.status === "active" ? "enabled" : "disabled";
}

export const visibleTabs = (memory: PluginAvailability): SessionTab[] =>
  memory === "enabled" ? ["conversation", "trajectory", "memory"] : ["conversation", "trajectory"];

/** The tab to render: Memory only while available (a slow or failed load shows Conversation). */
export const effectiveTab = (tab: SessionTab, memory: PluginAvailability): SessionTab =>
  visibleTabs(memory).includes(tab) ? tab : "conversation";
