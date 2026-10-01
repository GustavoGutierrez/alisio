import { agentIdFromCommand, CommandCatalog } from "@alisio/core";
import type { CommandDescriptor, CommandOutcome } from "@alisio/sdk";
import { activateSessionAgent } from "../host/agents.ts";
import type { RunScheduler } from "../host/run-scheduler.ts";
import type { SessionService } from "../host/sessions.ts";
import type { OpenWorkspace, WorkspaceHost } from "../host/workspace-host.ts";
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { is, validate } from "../schemas.ts";
import { RecentRequests } from "./prompts.ts";

/** Commands that change the session's own run state: refused while it runs or compacts. */
const EXCLUSIVE = new Set(["model", "compact"]);

/**
 * The `/ask` prompt: the TUI sends the same instruction (packages/cli/src/tui/app.ts); both turn
 * the user's question into a multiple-choice `ask_user_question` call.
 */
export const askPrompt = (question: string): string =>
  `The user has a question of their own and wants help turning it into a multiple-choice ` +
  `question: "${question}"\n\nPropose 2-4 concrete, mutually distinct options that ` +
  `would resolve it. Mark at most one option "recommended" only if you have a clear, ` +
  `well-justified opinion; it is a suggestion, never forced on the user. Then ` +
  `immediately call ask_user_question with exactly one question built from this ` +
  `(reuse the user's own wording for the question text). Do not answer in plain text ` +
  `first; call the tool right away.`;

const helpText = (commands: CommandDescriptor[]): string =>
  [
    "**Commands**",
    "",
    ...commands.map(
      (c) =>
        `- \`/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}\` — ${c.description}${
          c.aliases?.length ? ` (${c.aliases.map((a) => `/${a}`).join(", ")})` : ""
        }`,
    ),
    "",
    "**Keys**: Enter send · Shift+Enter newline · ↑↓ prompt history · `/` focus the composer · Esc close popovers",
  ].join("\n");

/**
 * The shared slash-command catalog for the web (RF-07): `GET /api/commands` lists the commands
 * whose surfaces include `web`; `POST /api/sessions/:sid/commands` runs core commands and expands
 * prompt templates, skills and `/ask` into a prompt the client sends itself.
 */
export function registerCommandRoutes(
  router: Router,
  ctx: {
    sessions: SessionService;
    scheduler: RunScheduler;
    workspaces: WorkspaceHost;
    recent?: RecentRequests;
  },
): void {
  const { sessions, scheduler } = ctx;
  const recent = ctx.recent ?? new RecentRequests();
  const catalogOf = (opened?: OpenWorkspace) =>
    new CommandCatalog(opened?.app as ConstructorParameters<typeof CommandCatalog>[0]);

  router.get("/api/commands", async ({ url }) => {
    const sid = url.searchParams.get("session");
    const wid = url.searchParams.get("workspace");
    let opened: OpenWorkspace | undefined;
    if (sid) opened = await sessions.app(sessions.get(sid));
    else if (wid) {
      const path = await ctx.workspaces.pathOf(wid);
      if (!path) throw new HttpError("not_found", "Workspace not found");
      opened = await ctx.workspaces.openPath(path);
    }
    return { body: catalogOf(opened).list("web") };
  });

  router.post("/api/sessions/:sid/commands", async ({ req, params }) => {
    const session = sessions.get(params.sid ?? "");
    const input = validate<{ requestId: string; name: string; args?: string }>(
      await readJson(req),
      {
        requestId: { check: is.requestId(), required: true },
        name: { check: is.nonEmpty(200), required: true },
        args: { check: is.string(100_000) },
      },
    );
    if (recent.has(session.id, input.requestId))
      return { body: { duplicate: true } satisfies CommandOutcome };
    const opened = await sessions.app(session);
    const catalog = catalogOf(opened);
    const name = input.name.replace(/^\//, "");
    const descriptor = catalog.resolve(name);
    if (!descriptor || !descriptor.surfaces.includes("web"))
      throw new HttpError("unknown_command", `Unknown command /${name}`);
    const args = (input.args ?? "").trim();
    const busy = () =>
      scheduler.busy(session.id) ||
      scheduler.compacting(session.id) ||
      opened.app.runner.isRunning(session.id);
    if (EXCLUSIVE.has(descriptor.name) && busy())
      throw new HttpError(
        "session_busy",
        `/${descriptor.name} is unavailable while the session runs`,
      );
    recent.add(session.id, input.requestId);
    const display = `/${descriptor.name}${args ? ` ${args}` : ""}`;
    const fail = (error: unknown): never => {
      throw new HttpError(
        "validation_failed",
        error instanceof Error ? error.message : "Command failed",
        { fields: ["args"] },
      );
    };
    let outcome: CommandOutcome;
    try {
      outcome = await run();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      return fail(error);
    }
    // A `/btw` side question changes nothing the session summary shows.
    if (descriptor.name !== "btw") sessions.notify(session.id);
    return { body: outcome };

    async function run(): Promise<CommandOutcome> {
      if (!descriptor) throw new HttpError("unknown_command", `Unknown command /${name}`);
      if (descriptor.source === "prompt") {
        const expanded = opened.app.expandPrompt(display);
        if (!expanded) throw new HttpError("unknown_command", `Unknown command /${name}`);
        return { prompt: { text: expanded.text, display: expanded.display } };
      }
      if (descriptor.source === "skill") {
        const skill = await opened.app.skills.load(descriptor.name.slice("skill:".length));
        return { prompt: { text: `${skill}\n\nUser request: ${args}`, display } };
      }
      if (descriptor.source === "agent") {
        // `/agent:<id>`: stored on the session, applied from its next run.
        const id = agentIdFromCommand(descriptor.name);
        if (!id) throw new HttpError("unknown_command", `Unknown command /${name}`);
        return activateSessionAgent(opened, session, id, {
          setAgent: (agent) => sessions.setOptions(session.id, { agent }),
          busy,
        });
      }
      if (descriptor.name === "help") return { output: helpText(catalog.list("web")) };
      if (descriptor.name === "permissions") {
        // Web clients open the permissions popover instead; API callers get the list as text.
        const live = opened.app.capabilityGrants.live(session.id);
        return {
          output: live.length
            ? live
                .map(
                  (g) =>
                    `- ${g.capability} · allowed for this session · since ${new Date(g.createdAt).toISOString()} (${g.source})`,
                )
                .join("\n")
            : "No saved permissions in this session.",
          tone: "notice",
        };
      }
      if (descriptor.name === "artifacts") {
        // Web clients open the artifact panel instead; API callers get the list as text.
        const records = opened.app.artifacts.list(sessions.rootOf(session.id), { limit: 100 });
        const filter = args.toLowerCase();
        const shown = records.filter((r) =>
          `${r.fileName} ${r.title} ${r.kind}`.toLowerCase().includes(filter),
        );
        return {
          output: shown.length
            ? shown.map((r) => `- ${r.fileName} (${r.kind}, ${r.bytes} bytes, ${r.id})`).join("\n")
            : "No artifacts in this session yet.",
          tone: "notice",
        };
      }
      if (descriptor.name === "ask") {
        if (!args) throw new Error("Usage: /ask <question>");
        return { prompt: { text: askPrompt(args), display } };
      }
      if (descriptor.name === "effort") {
        // Per session on the web (the TUI's /effort changes the global setting).
        if (!args)
          return {
            output: `Reasoning effort: ${String(session.options?.effort ?? "model default")}`,
            tone: "notice",
          };
        const effort = args === "!clear" ? undefined : args;
        sessions.setOptions(session.id, { effort });
        return {
          output: effort ? `Reasoning effort set to ${effort}` : "Reasoning effort cleared",
          tone: "notice",
          effects: ["effort"],
        };
      }
      if (descriptor.name === "compact") {
        const work = opened.app.runner.compact(session.id, args ? { focus: args } : {});
        scheduler.track(session.id, opened.id, work, {
          onDone: () => sessions.notify(session.id),
        });
        sessions.notify(session.id);
        const result = await work;
        return result
          ? {
              output: `Compacted ${result.replaced} messages: ~${result.before} → ~${result.after} tokens`,
              tone: "notice",
              effects: ["messages"],
            }
          : { output: "Not enough history to compact", tone: "notice" };
      }
      const result = await catalog.execute(descriptor.name, args, { sessionId: session.id });
      if (result.sessionId && result.sessionId !== session.id) sessions.notify(result.sessionId);
      return {
        ...(result.text ? { output: result.text } : {}),
        ...(result.tone ? { tone: result.tone } : {}),
        ...(result.sessionId && result.sessionId !== session.id
          ? { sessionId: result.sessionId }
          : {}),
        ...(descriptor.name === "model" ? { effects: ["model"] } : {}),
      };
    }
  });
}
