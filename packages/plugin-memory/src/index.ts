/**
 * Built-in memory plugin (Engram-style). Everything memory-related lives in this directory;
 * the core only exposes generic hooks. Disabled means: no store file, tools, prompt or hooks.
 */
import { isAbsolute, join, resolve } from "node:path";
import { definePlugin, type Message, type Plugin } from "@alisio/sdk";
import { type MemoryConfig, memoryConfigSchema } from "./config.ts";
import {
  COMPACTION_GUIDANCE,
  formatObservation,
  MEMORY_PROTOCOL,
  memoryLine,
  OBSERVATIONS_FIELD,
  type Observation,
  parseObservations,
  parseSessionSummary,
  renderInjection,
  SESSION_SUMMARY_SYSTEM,
} from "./format.ts";
import { projectId, SQLiteMemoryStore } from "./store.ts";
import { memoryContextText, memoryTools } from "./tools.ts";
import type { MemoryScope } from "./types.ts";
import { loadVersion } from "./version.ts";

export interface MemoryPluginContext {
  workspace: string;
  stateHome: string;
  /** Directory of the configuration file, for relative `dbPath`. */
  configDir: string;
}
export type ArchiveOutcome = "confirmed" | "failed" | "unknown";

const userTexts = (messages: readonly Message[]) =>
  messages.flatMap((m) => (m.role === "user" && !m.summary && m.text.trim() ? [m.text] : []));
function transcript(messages: readonly Message[], maxChars = 60_000): string {
  const lines = messages.map((m) =>
    m.role === "user"
      ? `${m.summary ? "CONTEXT" : "USER"}: ${m.text.slice(0, 4_000)}`
      : m.role === "assistant"
        ? [
            m.text ? `ASSISTANT: ${m.text.slice(0, 4_000)}` : "",
            ...m.calls.map((c) => `TOOL CALL ${c.id} ${c.name}: ${c.arguments.slice(0, 1_000)}`),
          ]
            .filter(Boolean)
            .join("\n")
        : `TOOL RESULT ${m.callId}: ${m.result.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n")
            .slice(0, 1_500)}`,
  );
  const text = lines.join("\n");
  return text.length > maxChars ? `[earlier messages omitted]\n${text.slice(-maxChars)}` : text;
}

export function createMemoryPlugin(rawOptions: unknown, context: MemoryPluginContext): Plugin {
  const options: MemoryConfig = memoryConfigSchema.parse(rawOptions ?? {});
  const dbPath = options.dbPath
    ? isAbsolute(options.dbPath)
      ? options.dbPath
      : resolve(context.configDir, options.dbPath)
    : join(context.stateHome, "memory.sqlite");
  let store: SQLiteMemoryStore | undefined;
  const stats = {
    written: 0,
    lastArchive: undefined as ArchiveOutcome | undefined,
    lastSummary: "",
  };
  return definePlugin({
    id: "memory",
    name: "Memory",
    description: "Persistent memory and memory-aware context compaction",
    version: loadVersion(import.meta.url),
    apiVersion: 1,
    async setup(api) {
      const project = await projectId(context.workspace);
      const db = new SQLiteMemoryStore(api.storage.sqlite(dbPath));
      store = db;
      const deps = {
        store: db,
        project,
        defaultScope: options.defaultScope as MemoryScope,
        budgetTokens: options.injectBudgetTokens,
        onWrite: () => {
          stats.written++;
          refresh();
        },
      };
      const refresh = () => {
        const c = db.count(project);
        api.ui.status(
          "count",
          `mem ${c.project}${c.personal ? `+${c.personal}` : ""}`,
          [
            `project ${project}: ${c.project} project + ${c.personal} personal memories`,
            `${stats.written} writes in this process`,
            `last compaction archive: ${stats.lastArchive ?? "none"}`,
            ...(stats.lastSummary ? [`last session summary: ${stats.lastSummary}`] : []),
            `store: ${dbPath}`,
          ].join(" · "),
        );
      };
      const saveAll = (observations: Observation[], session: string, source: string) => {
        const counts = { created: 0, updated: 0, duplicate: 0 };
        for (const o of observations) {
          const r = db.save({
            project,
            scope: o.scope ?? (options.defaultScope as MemoryScope),
            type: o.type,
            title: o.title,
            content: formatObservation(o),
            ...(o.topicKey ? { topicKey: o.topicKey } : {}),
            session,
            source,
          });
          counts[r.action]++;
        }
        return counts;
      };
      for (const tool of memoryTools(deps)) api.tools.register(tool);
      api.context.register(async () => MEMORY_PROTOCOL);
      api.compaction.register({
        async beforeCompact() {
          return {
            instructions: COMPACTION_GUIDANCE,
            outputFields: { observations: OBSERVATIONS_FIELD },
          };
        },
        async afterCompact(result) {
          for (const text of userTexts(result.messages).slice(-10))
            db.recordPrompt(project, result.sessionId, text);
          const memories = saveAll(
            parseObservations(result.extracted.observations),
            result.sessionId,
            "compaction",
          );
          // Deterministic archive of the checkpoint as the session summary, confirmed by readback.
          let archive: ArchiveOutcome;
          try {
            const stored = db.saveSummary(project, result.sessionId, result.checkpointText);
            archive = db.summaryOf(result.sessionId) === stored ? "confirmed" : "unknown";
          } catch {
            archive = "failed";
          }
          stats.lastArchive = archive;
          const query = result.checkpoint
            ? [result.checkpoint.goal, ...result.checkpoint.nextSteps].join(" ")
            : result.checkpointText.slice(0, 400);
          const recalled = options.recallLimit
            ? db.search(project, query, { mode: "any", limit: options.recallLimit })
            : [];
          refresh();
          return {
            ...(recalled.length
              ? {
                  injectContext: renderInjection({
                    heading: "Recovered memory (Alisio memory plugin)",
                    memories: recalled,
                    budgetTokens: options.injectBudgetTokens,
                  }),
                }
              : {}),
            report: {
              summary: `memory: +${memories.created} new, ${memories.updated} updated, ${memories.duplicate} duplicate · archive ${archive} · ${recalled.length} recalled`,
              archive,
              memories,
              recalled: recalled.length,
            },
          };
        },
      });
      api.session.onStart(async (info) => {
        refresh();
        return memoryContextText(deps, info.sessionId);
      });
      api.session.onEnd(async (info) => {
        const prompts = userTexts(info.messages);
        const meaningful =
          prompts.length > 0 &&
          info.messages.some((m) => m.role === "assistant" && (m.text.trim() || m.calls.length));
        if (!options.autoSummary || !meaningful) return;
        for (const text of prompts.slice(-10)) db.recordPrompt(project, info.sessionId, text);
        try {
          const raw = await api.model.complete({
            system: SESSION_SUMMARY_SYSTEM,
            messages: [
              { role: "user", text: `<transcript>\n${transcript(info.messages)}\n</transcript>` },
            ],
            maxTokens: 2048,
            sessionId: info.sessionId,
            signal: info.signal,
          });
          const parsed = parseSessionSummary(raw);
          if (parsed.text) db.saveSummary(project, info.sessionId, parsed.text);
          const counts = saveAll(parsed.observations, info.sessionId, "session_summary");
          stats.lastSummary = `saved (${parsed.structured ? "structured" : "text-only"}, +${counts.created} memories)`;
        } catch (error) {
          stats.lastSummary = `failed (${error instanceof Error ? error.message : String(error)})`;
          throw error;
        } finally {
          refresh();
        }
      });
      api.commands.register(
        "memory",
        async (args) => {
          const [verb = "", ...rest] = args.trim().split(/\s+/);
          const target = Number(rest[0]);
          const needsId = ["show", "forget", "pin", "unpin"].includes(verb);
          if (needsId && !Number.isInteger(target)) return `Usage: /memory ${verb} <id>`;
          if (verb === "show") {
            const r = db.get(target, project);
            if (!r) return `Memory #${target} not found.`;
            return [
              `**#${r.id} [${r.type}] ${r.title}**`,
              "",
              `scope ${r.scope}${r.topicKey ? ` · topic \`${r.topicKey}\`` : ""} · revisions ${r.revisionCount} · duplicates ${r.duplicateCount}${r.pinned ? " · pinned" : ""}`,
              "",
              r.content,
            ].join("\n");
          }
          if (verb === "forget") {
            const ok = db.forget(target, project);
            if (ok) deps.onWrite();
            return ok ? `Forgot memory #${target}.` : `Memory #${target} not found.`;
          }
          if (verb === "pin" || verb === "unpin") {
            const ok = db.pin(target, project, verb === "pin");
            if (ok) deps.onWrite();
            return ok ? `Memory #${target} ${verb}ned.` : `Memory #${target} not found.`;
          }
          const c = db.count(project);
          if (!args.trim()) {
            const recent = db.recent(project, 15);
            return [
              `**Memory** · ${c.project} project + ${c.personal} personal · project \`${project}\``,
              "",
              ...(recent.length ? recent.map((m) => memoryLine(m, true)) : ["No memories yet."]),
              "",
              "`/memory <query>` search · `/memory show|forget|pin|unpin <id>`",
            ].join("\n");
          }
          let hits = db.search(project, args, { limit: 15 });
          if (!hits.length) hits = db.search(project, args, { limit: 15, mode: "any" });
          return hits.length
            ? [`**Memory search:** ${args}`, "", ...hits.map((m) => memoryLine(m))].join("\n")
            : `No memories match "${args}".`;
        },
        {
          description: "List, search, show, pin or forget memories",
          argumentHint: "[query | show <id> | forget <id> | pin <id>]",
        },
      );
      refresh();
    },
    dispose() {
      store?.close();
      store = undefined;
    },
  });
}
