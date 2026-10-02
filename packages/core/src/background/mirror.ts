/**
 * Read-only mirror of the subagent tasks in the unified task list. The subagents plugin keeps its
 * own manager, tools and notification (`<task-notification>`); the host only READS its tree panel
 * (`PanelProvider.nodes`) and shows each node as a task of kind `subagent`. Nothing here starts,
 * stops or stores anything.
 */
import type {
  BackgroundTaskInfo,
  BackgroundTaskStatus,
  PanelNode,
  PanelProvider,
} from "@alisio/sdk";

const STATUS: Record<string, BackgroundTaskStatus> = {
  queued: "queued",
  running: "running",
  waiting: "running",
  completed: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "lost",
};

/** Maps one panel node to a task (an unknown status is shown as `lost`, never as running). */
export function nodeToTask(node: PanelNode, rootSession: string): BackgroundTaskInfo {
  return {
    id: node.id,
    kind: "subagent",
    label: node.label,
    status: STATUS[node.status] ?? "lost",
    ...(node.detail ? { command: node.detail } : {}),
    sessionId: node.sessionId ?? rootSession,
    ...(node.parentId ? { parentId: node.parentId } : {}),
    bytes: 0,
    createdAt: node.startedAt ?? 0,
    ...(node.startedAt ? { startedAt: node.startedAt } : {}),
    ...(node.endedAt ? { endedAt: node.endedAt } : {}),
  };
}

/** The subagent tasks of a root session, from the panels the plugin registered. */
export function subagentTasks(
  panels: ReadonlyMap<string, { plugin: string; provider: PanelProvider }>,
  rootSession: string,
): BackgroundTaskInfo[] {
  const tasks: BackgroundTaskInfo[] = [];
  for (const entry of panels.values()) {
    if (entry.plugin !== "subagents") continue;
    try {
      for (const node of entry.provider.nodes({ sessionId: rootSession }))
        tasks.push(nodeToTask(node, rootSession));
    } catch {
      /* a failing panel never breaks the task list */
    }
  }
  return tasks;
}
