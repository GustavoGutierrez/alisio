/**
 * Activating an agent in an existing web session (`/agent:<id>` and the `/agents` picker). The
 * agent id is stored in the session options; its instructions (and default reasoning effort)
 * apply from the session's next run, never mid-run, so tool call ids and persisted turns stay
 * consistent. Its declared model is applied only when it belongs to the session's provider
 * (`runner.setModel`); otherwise the session keeps its model and the answer says so.
 */
import { agentCatalogFromState, DEFAULT_AGENT_ID, type Session } from "@alisio/core";
import type { CommandOutcome } from "@alisio/sdk";
import type { OpenWorkspace } from "./workspace-host.ts";

export async function activateSessionAgent(
  opened: OpenWorkspace,
  session: Session,
  agentId: string,
  options: { setAgent(id: string): void; busy(): boolean },
): Promise<CommandOutcome> {
  let state: unknown;
  try {
    state = opened.app.plugins.pluginState("subagents", "mainAgents");
  } catch {
    /* contributions are best-effort */
  }
  const agent = agentCatalogFromState(state).find((candidate) => candidate.id === agentId);
  if (!agent) throw new Error(`Unknown agent "${agentId}". Open /agents to see the loaded agents.`);
  options.setAgent(agent.id);
  const effects = ["agent"];
  const lines = [
    `Active agent: **${agent.name}**${agent.id === DEFAULT_AGENT_ID ? " (default)" : ""}${agent.readOnly ? " · read-only" : ""}. Applies from the next prompt.`,
  ];
  if (agent.model && agent.model !== session.model) {
    let target: Awaited<ReturnType<typeof opened.app.resolveModel>> | undefined;
    try {
      target = await opened.app.resolveModel(agent.model);
    } catch {
      /* not resolvable from the configured profiles */
    }
    if (target && target.provider === session.provider && !options.busy()) {
      if (target.model.id !== session.model) {
        opened.app.runner.setModel(session.id, target.model.id);
        effects.push("model");
        lines.push(`Model switched to \`${target.model.id}\`.`);
      }
    } else
      lines.push(
        `This chat keeps \`${session.model}\`; start a new chat with ${agent.name} to use its model \`${agent.model}\`.`,
      );
  }
  return { output: lines.join(" "), tone: "notice", effects };
}
