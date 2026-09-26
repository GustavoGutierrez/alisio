/**
 * Delegation policy on top of the generic `api.sessions` service: admission limits and a
 * bounded queue, write isolation (worktree / serial / shared), foreground and background
 * tasks, result wrapping, one-way messages, bounded waits and the agent tree model.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ChildRunResult, PanelNode, PluginAPI, RunEvent, SessionStatus } from "@alisio/sdk";
import type { SubagentsConfig } from "./config.ts";
import type { AgentDefinition } from "./definitions.ts";
import * as gitOps from "./git.ts";

export const DELEGATION_TOOLS = ["task", "task_status", "task_wait", "send_message"];
const WRITE_TOOLS = ["write_file", "edit_file"];
type WriteMode = "worktree" | "serial" | "shared";
export interface TaskRecord {
  id: string;
  parentSession: string;
  rootSession: string;
  agent: AgentDefinition;
  title: string;
  background: boolean;
  status: SessionStatus;
  startedAt?: number;
  endedAt?: number;
  tokens: number;
  detail: string;
  snippet?: string;
  writeCapable: boolean;
  worktree?: { path: string; branch: string; base: string; root: string };
  notes: string[];
  result?: string;
  isError?: boolean;
  /** Resolves the pending foreground tool call early (Ctrl+B). */
  detach?: () => void;
  done?: Promise<void>;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const oneLine = (text: string, max = 80) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

class Semaphore {
  private tail: Promise<void> = Promise.resolve();
  /** Runs `fn` after every previously queued holder finished (FIFO). */
  async lock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class SubagentManager {
  tasks = new Map<string, TaskRecord>();
  private running = new Map<string, number>();
  private runningTotal = 0;
  private waiting: Array<{ parent: string; resolve: () => void }> = [];
  private modes = new Map<string, WriteMode>();
  private asking = new Map<string, Promise<{ mode: WriteMode; note?: string }>>();
  private writers = new Map<string, { pending: number; active: number }>();
  private locks = new Map<string, Semaphore>();
  constructor(
    private api: PluginAPI,
    private config: SubagentsConfig,
    private env: { stateHome: string; workspace: string },
    public agents: Map<string, AgentDefinition>,
  ) {}

  rootOf(session: string): string {
    return this.api.sessions.ancestors(session).at(-1) ?? session;
  }
  depthOf(session: string): number {
    return this.api.sessions.get(session)?.depth ?? 0;
  }
  /** Delegation tools granted to a child created by `caller` with this definition. */
  private grantsDelegation(agent: AgentDefinition, childDepth: number): boolean {
    if (childDepth >= this.config.maxDepth) return false;
    return !!agent.tools && (agent.tools.includes("*") || agent.tools.includes("task"));
  }
  private isWriteCapable(agent: AgentDefinition, caller: string): boolean {
    if (agent.readOnly || agent.permission?.write === "deny") return false;
    const caps = this.api.sessions.capabilities(caller);
    if (!caps.write && !caps.approvals) return false;
    if (!agent.tools || agent.tools.includes("*")) return true;
    return agent.tools.some((t) => WRITE_TOOLS.includes(t));
  }

  // ---- admission -------------------------------------------------------------------------
  private canStart(parent: string) {
    return (
      (this.running.get(parent) ?? 0) < this.config.maxConcurrentPerParent &&
      this.runningTotal < this.config.maxConcurrentTotal
    );
  }
  private async admit(parent: string, signal?: AbortSignal): Promise<() => void> {
    if (!this.canStart(parent)) {
      if (this.waiting.length >= this.config.maxQueued)
        throw new Error(
          `Subagent queue is full (${this.config.maxQueued} waiting; limits ${this.config.maxConcurrentPerParent} per parent, ${this.config.maxConcurrentTotal} total). Retry later or wait for running tasks.`,
        );
      await new Promise<void>((resolve, reject) => {
        const entry = { parent, resolve };
        this.waiting.push(entry);
        signal?.addEventListener(
          "abort",
          () => {
            this.waiting = this.waiting.filter((w) => w !== entry);
            reject(signal.reason ?? new Error("Cancelled"));
          },
          { once: true },
        );
      });
    }
    this.running.set(parent, (this.running.get(parent) ?? 0) + 1);
    this.runningTotal++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running.set(parent, (this.running.get(parent) ?? 1) - 1);
      this.runningTotal--;
      const next = this.waiting.findIndex((w) => this.canStart(w.parent));
      if (next >= 0) this.waiting.splice(next, 1)[0]?.resolve();
    };
  }

  // ---- write isolation -------------------------------------------------------------------
  private async decideMode(
    root: string,
    repo: string | undefined,
  ): Promise<{ mode: WriteMode; note?: string }> {
    const configured = this.config.parallelWrites;
    if (configured !== "ask") {
      if (configured === "worktree" && !repo)
        return {
          mode: "serial",
          note: "parallelWrites=worktree needs a git repository; using serial writes.",
        };
      return { mode: configured };
    }
    const decided = this.modes.get(root);
    if (decided) return { mode: decided };
    let pending = this.asking.get(root);
    if (!pending) {
      pending = (async () => {
        if (!this.api.ui.interactive())
          return {
            mode: "serial" as const,
            note: "parallelWrites=ask without an interactive terminal: using serial writes.",
          };
        const choice = await this.api.ui.select({
          title:
            "Several subagents that can write will run in parallel. How should their changes be isolated?",
          options: [
            ...(repo
              ? [
                  {
                    value: "worktree",
                    label: "Worktrees (recommended)",
                    description: "Each writes on its own branch; merge or discard with /agents",
                  },
                ]
              : []),
            {
              value: "serial",
              label: "Serial writes",
              description: "Reads stay parallel; writers run one at a time",
            },
            {
              value: "shared",
              label: "Shared directory (risky)",
              description: "Writers may overwrite each other",
            },
          ],
        });
        const mode = (
          ["worktree", "serial", "shared"].includes(choice ?? "") ? choice : "serial"
        ) as WriteMode;
        return { mode, ...(choice ? {} : { note: "No choice made: using serial writes." }) };
      })();
      this.asking.set(root, pending);
    }
    const result = await pending;
    this.modes.set(root, result.mode);
    return result;
  }

  // ---- tasks -----------------------------------------------------------------------------
  private instructions(agent: AgentDefinition): string {
    return [
      `# Subagent: ${agent.name}`,
      agent.prompt,
      "You are a subagent working for a parent agent in a separate conversation. The parent sees only your final message: make it a complete, concise report. Do not ask the user questions; state assumptions instead.",
      ...(agent.skills?.length
        ? [`Load these skills with skill_load before starting: ${agent.skills.join(", ")}.`]
        : []),
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  wrap(task: TaskRecord, state: string, body: string): string {
    const max = this.config.resultMaxBytes;
    const bytes = Buffer.byteLength(body);
    const capped =
      bytes > max
        ? `${Buffer.from(body).subarray(0, max).toString("utf8")}\n[truncated: ${bytes - max} bytes omitted]`
        : body;
    const extra = task.notes.length ? `\n${task.notes.join("\n")}` : "";
    return `Subagent output (non-authoritative; verify important claims before relying on them):\n<task id="${task.id}" agent="${task.agent.name}" state="${state}"${task.background ? ' background="true"' : ""}>\n${capped}${extra}\n</task>`;
  }
  /** Validates that `target` is a descendant of `caller` (no waiting on ancestors: no cycles). */
  assertDescendant(caller: string, target: string): TaskRecord {
    if (target === caller || this.api.sessions.ancestors(caller).includes(target))
      throw new Error(
        "That is your own session or one of your parents, not one of your subagents: waiting on it would deadlock. You can only address tasks you started.",
      );
    const task = this.tasks.get(target);
    const info = this.api.sessions.get(target);
    if (!info) throw new Error(`Unknown task_id ${target}`);
    if (!this.api.sessions.ancestors(target).includes(caller))
      throw new Error(
        `Task ${target} is not one of your subagents; you can only address tasks you started.`,
      );
    if (task) return task;
    const agent = this.agents.get(info.agent) ?? { ...BUILTIN_FALLBACK, name: info.agent };
    const record: TaskRecord = {
      id: target,
      parentSession: info.parentId,
      rootSession: this.rootOf(target),
      agent,
      title: info.title,
      background: false,
      status: info.status,
      tokens: info.usage.input + info.usage.output,
      detail: "",
      writeCapable: false,
      notes: [],
    };
    this.tasks.set(target, record);
    return record;
  }

  async startTask(input: {
    caller: string;
    agentName: string;
    title: string;
    prompt: string;
    taskId?: string;
    background?: boolean;
    signal?: AbortSignal;
  }): Promise<{ text: string; isError: boolean }> {
    if (input.taskId) {
      const task = this.assertDescendant(input.caller, input.taskId);
      if (this.api.sessions.isRunning(task.id))
        return {
          text: this.wrap(
            task,
            "running",
            "Task is already running; use send_message or task_wait.",
          ),
          isError: true,
        };
      task.background = !!input.background;
      return this.execute(task, input.prompt, input.background ? undefined : input.signal);
    }
    const agent = this.agents.get(input.agentName);
    if (!agent || agent.mode === "primary")
      throw new Error(
        `Unknown subagent_type "${input.agentName}". Available: ${[...this.agents.values()]
          .filter((a) => a.mode !== "primary" && !a.hidden)
          .map((a) => a.name)
          .join(", ")}`,
      );
    const childDepth = this.depthOf(input.caller) + 1;
    if (childDepth > this.config.maxDepth)
      throw new Error(`Maximum subagent depth ${this.config.maxDepth} reached`);
    const root = this.rootOf(input.caller);
    const writeCapable = this.isWriteCapable(agent, input.caller);
    const notes: string[] = [];
    let mode: WriteMode | undefined;
    let worktree: TaskRecord["worktree"];
    const id = randomUUID();
    if (writeCapable) {
      // Gather writers spawned in the same turn before deciding whether isolation is needed.
      const group = this.writers.get(root) ?? { pending: 0, active: 0 };
      this.writers.set(root, group);
      group.pending++;
      await sleep(40);
      const concurrent = group.pending + group.active >= 2;
      group.pending--;
      group.active++;
      const workspace = this.api.sessions.workspace(input.caller);
      const repo = await gitOps.repoRoot(workspace);
      const decided =
        this.config.parallelWrites === "ask" ? this.modes.get(root) : this.config.parallelWrites;
      if (concurrent || decided) {
        const choice = await this.decideMode(root, repo);
        mode = choice.mode;
        if (choice.note) notes.push(`Note: ${choice.note}`);
      }
      if (mode === "worktree" && repo && concurrent) {
        if (await gitOps.isDirty(repo))
          notes.push(
            "Warning: the main working tree has uncommitted changes that this worktree does not include.",
          );
        const path = join(this.config.worktreeDir ?? join(this.env.stateHome, "worktrees"), id);
        const branch = `alisio/${id}`;
        const base = await gitOps.addWorktree(repo, path, branch);
        worktree = { path, branch, base, root: repo };
      }
    }
    const grants = this.grantsDelegation(agent, childDepth);
    const deny = [...(agent.disallowedTools ?? []), ...(grants ? [] : DELEGATION_TOOLS)];
    const info = this.api.sessions.spawn({
      parentId: input.caller,
      id,
      title: input.title,
      agent: agent.name,
      instructions: this.instructions(agent),
      tools: {
        ...(agent.tools && !agent.tools.includes("*")
          ? { allow: [...agent.tools, ...(grants ? DELEGATION_TOOLS : [])] }
          : {}),
        deny,
      },
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.readOnly ? { readOnly: true } : {}),
      ...(agent.permission ? { permission: agent.permission } : {}),
      ...(worktree ? { workspace: worktree.path } : {}),
      maxTurns: agent.maxTurns ?? this.config.maxTurns,
      timeoutMs: this.config.timeoutMs,
      ...(this.config.maxTokensPerChild ? { maxTokens: this.config.maxTokensPerChild } : {}),
    });
    const task: TaskRecord = {
      id: info.id,
      parentSession: input.caller,
      rootSession: root,
      agent,
      title: input.title,
      background: !!(input.background ?? agent.background),
      status: "queued",
      tokens: 0,
      detail: "queued",
      writeCapable,
      notes,
      ...(worktree ? { worktree } : {}),
    };
    this.tasks.set(task.id, task);
    const releaseWriter = () => {
      const group = this.writers.get(root);
      if (group && writeCapable) group.active = Math.max(0, group.active - 1);
    };
    const lock = writeCapable && mode !== "worktree" && mode !== "shared";
    return this.execute(task, input.prompt, task.background ? undefined : input.signal, {
      lock,
      onFinish: releaseWriter,
    });
  }

  private execute(
    task: TaskRecord,
    prompt: string,
    signal: AbortSignal | undefined,
    options: { lock?: boolean; onFinish?: () => void } = {},
  ): Promise<{ text: string; isError: boolean }> {
    let detached = false;
    let detach: () => void = () => {};
    const detachedResult = new Promise<{ text: string; isError: boolean }>((resolve) => {
      detach = () => {
        detached = true;
        task.background = true;
        resolve({
          text: this.wrap(
            task,
            "running",
            "Moved to the background by the user. You will receive a <task-notification> when it finishes; do not poll.",
          ),
          isError: false,
        });
      };
    });
    task.detach = detach;
    const work = (async () => {
      let release: (() => void) | undefined;
      try {
        release = await this.admit(task.parentSession, signal);
        const run = async (): Promise<ChildRunResult> => {
          task.status = "running";
          task.startedAt = Date.now();
          task.detail = "starting";
          this.refresh();
          return this.api.sessions.run(task.id, prompt, signal ? { signal } : {});
        };
        const result = options.lock ? await this.lockFor(task.rootSession).lock(run) : await run();
        task.status = result.status;
        task.tokens = Math.max(task.tokens, result.usage.input + result.usage.output);
        if (task.worktree && result.status === "completed") await this.summarizeWorktree(task);
        task.result =
          result.status === "completed"
            ? this.wrap(task, "completed", result.text || "(no final message)")
            : this.wrap(
                task,
                result.status,
                `Error: ${result.error ?? result.status}. Resume with task_id="${task.id}".`,
              );
        task.isError = result.status !== "completed";
      } catch (error) {
        task.status = signal?.aborted ? "cancelled" : "failed";
        this.api.sessions.setStatus(task.id, task.status);
        task.result = this.wrap(
          task,
          task.status,
          `Error: ${error instanceof Error ? error.message : String(error)}. Resume with task_id="${task.id}".`,
        );
        task.isError = true;
      } finally {
        release?.();
        options.onFinish?.();
        task.endedAt = Date.now();
        task.detach = undefined;
        this.refresh();
      }
      if (task.background || detached) this.notifyParent(task);
    })();
    task.done = work.then(() => {});
    this.refresh();
    if (task.background)
      return Promise.resolve({
        text: this.wrap(
          task,
          "running",
          "Started in the background. You will receive a <task-notification> when it finishes; do not poll. Use task_status or task_wait only if you truly need to block.",
        ),
        isError: false,
      });
    return Promise.race([
      work.then(() => ({ text: task.result ?? "", isError: !!task.isError })),
      detachedResult,
    ]);
  }
  private lockFor(root: string): Semaphore {
    let lock = this.locks.get(root);
    if (!lock) {
      lock = new Semaphore();
      this.locks.set(root, lock);
    }
    return lock;
  }
  private async summarizeWorktree(task: TaskRecord) {
    const wt = task.worktree;
    if (!wt) return;
    try {
      const committed = await gitOps.commitAll(wt.path, `alisio task ${task.id}: ${task.title}`);
      if (!committed) {
        await gitOps.removeWorktree(wt.root, wt.path, wt.branch, true);
        task.worktree = undefined;
        task.notes.push(`No changes were made; worktree and branch ${wt.branch} were removed.`);
        return;
      }
      const diff = await gitOps.diffSummary(wt.root, wt.base, wt.branch);
      task.notes.push(
        `Branch: ${wt.branch} (worktree ${wt.path})`,
        `Changed files: ${diff.files.join(", ") || "(none)"}`,
        `Diffstat:\n${diff.stat}`,
        `The user can merge it with /agents merge ${task.id} or drop it with /agents discard ${task.id}.`,
      );
    } catch (error) {
      task.notes.push(`Worktree summary failed: ${String(error)}`);
    }
  }
  /** Bounded synthetic completion message delivered to the parent's next turn. */
  private notifyParent(task: TaskRecord) {
    const body = (task.result ?? "").slice(0, this.config.resultMaxBytes + 2_000);
    this.api.sessions.enqueue(
      task.parentSession,
      `<task-notification id="${task.id}" agent="${task.agent.name}" state="${task.status}">\n${body}\n</task-notification>`,
    );
  }

  async wait(
    caller: string,
    target: string,
    timeoutMs: number,
  ): Promise<{ text: string; isError: boolean }> {
    const task = this.assertDescendant(caller, target);
    const bounded = Math.max(0, Math.min(timeoutMs, this.config.waitMaxMs));
    if (task.done && !task.result) await Promise.race([task.done, sleep(bounded)]);
    if (task.result) return { text: task.result, isError: !!task.isError };
    const info = this.api.sessions.get(target);
    return {
      text: this.wrap(
        task,
        info?.status ?? task.status,
        `Still ${info?.status ?? task.status} after ${bounded}ms.`,
      ),
      isError: false,
    };
  }
  sendMessage(caller: string, target: string, text: string): string {
    const task = this.assertDescendant(caller, target);
    if (this.api.sessions.isRunning(target)) {
      this.api.sessions.enqueue(target, `Message from the parent agent:\n${text}`);
      return `Queued for task ${target}'s next turn.`;
    }
    task.background = true;
    void this.execute(task, `Message from the parent agent:\n${text}`, undefined);
    return `Task ${target} resumed in the background with your message; a <task-notification> will arrive when it finishes.`;
  }
  cancel(id: string): number {
    const n = this.api.sessions.cancel(id);
    const task = this.tasks.get(id);
    if (task && task.status === "queued") task.status = "cancelled";
    this.refresh();
    return n;
  }
  backgroundAll(root: string): number {
    let n = 0;
    for (const task of this.tasks.values())
      if (
        task.rootSession === root &&
        !task.background &&
        task.detach &&
        task.status === "running"
      ) {
        task.detach();
        n++;
      }
    return n;
  }

  // ---- live tree ---------------------------------------------------------------------------
  observe(event: Readonly<RunEvent>) {
    const task = this.tasks.get(event.sessionId);
    if (!task) return;
    const d = (event.data ?? {}) as Record<string, unknown>;
    if (event.type === "tool_started")
      task.detail = oneLine(`${String(d.name)} ${summarizeArgs(String(d.arguments ?? ""))}`);
    else if (event.type === "text_delta") {
      task.snippet = `${task.snippet ?? ""}${String(d.delta)}`.slice(-160);
      task.detail = `✎ ${oneLine(task.snippet, 78)}`;
    } else if (event.type === "tool_completed" || event.type === "turn_completed")
      task.snippet = "";
    if (event.type === "turn_completed") {
      const usage = d.usage as { input?: number; output?: number } | undefined;
      if (usage) task.tokens += (usage.input ?? 0) + (usage.output ?? 0);
    }
  }
  nodes(root: string): PanelNode[] {
    const out: PanelNode[] = [];
    const visit = (parent: string) => {
      for (const task of [...this.tasks.values()]
        .filter((t) => t.parentSession === parent)
        .sort(
          (a, b) =>
            (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER),
        )) {
        out.push({
          id: task.id,
          ...(parent !== root ? { parentId: parent } : {}),
          label: task.agent.name,
          ...(task.agent.color ? { color: task.agent.color } : {}),
          status: task.status,
          ...(task.startedAt ? { startedAt: task.startedAt } : {}),
          ...(task.endedAt ? { endedAt: task.endedAt } : {}),
          tokens: task.tokens,
          detail: task.detail || task.title,
          sessionId: task.id,
        });
        visit(task.id);
      }
    };
    visit(root);
    return out;
  }
  refresh: () => void = () => {};
}
const BUILTIN_FALLBACK: AgentDefinition = {
  name: "agent",
  description: "",
  prompt: "",
  mode: "subagent",
  hidden: false,
  background: false,
  source: "session",
};
function summarizeArgs(args: string): string {
  try {
    const value = JSON.parse(args) as Record<string, unknown>;
    for (const key of ["path", "command", "pattern", "query", "description", "name"])
      if (typeof value[key] === "string") return String(value[key]);
    return "";
  } catch {
    return "";
  }
}
