/**
 * Pure logic of the TUI modes (spec: modes, goal and background, Phase 1): the Shift+Tab agent
 * cycle, the `/permission` menu and transitions, and the `/reload` guard. No terminal output and
 * no I/O, so it is unit-testable without a TTY; `app.ts` wires it to the editor and the pickers.
 */
import {
  type ActiveAgent,
  FULL_ACCESS_WARNING,
  PERMISSION_MODE_TABLE,
  PERMISSION_MODES,
  PERMISSION_MODES_LOCKED,
  type PermissionMode,
  type PermissionModeLabel,
} from "@alisio/core";
import { Key, matchesKey } from "@earendil-works/pi-tui";

export const CYCLE_BLOCKED_HINT =
  "A turn is running: wait for it to finish before switching agents";

/** What the input listener must do with a keypress. */
export type ShiftTabDecision =
  | { type: "ignore" }
  /** A turn is running: say so and consume the key. */
  | { type: "blocked"; hint: string }
  | { type: "cycle" };

export interface ShiftTabState {
  /** A turn (or compaction) is running. */
  busy: boolean;
  /** A picker, menu or panel owns the keyboard. */
  picker: boolean;
  /** The slash/file autocomplete list is visible in the editor. */
  autocomplete: boolean;
  /** The subagent tree panel has the focus instead of the editor. */
  panelFocused: boolean;
}

/**
 * Shift+Tab cycles the main agents only when the editor owns the keyboard: with a picker, the
 * autocomplete list or the agents panel open the key is left alone (not consumed), and during a
 * turn it is consumed with a hint, because an agent switch applies from the next prompt.
 */
export function shiftTabDecision(data: string, state: ShiftTabState): ShiftTabDecision {
  if (!matchesKey(data, Key.shift("tab"))) return { type: "ignore" };
  if (state.picker || state.autocomplete || state.panelFocused) return { type: "ignore" };
  if (state.busy) return { type: "blocked", hint: CYCLE_BLOCKED_HINT };
  return { type: "cycle" };
}

/** The one-line hint after cycling to `agent`; it names the model the agent declares, if any. */
export function agentCycleHint(agent: ActiveAgent, currentModel: string): string {
  const base = `Agent: ${agent.name}${agent.readOnly ? " (read-only)" : ""} · Shift+Tab cycles agents`;
  return agent.model && agent.model !== currentModel
    ? `${base} · it declares model ${agent.model}: run /agents to apply it`
    : base;
}

/** The mode name shown in the header and the status row (`locked` is shown as `read-only`). */
export const modeDisplay = (mode: PermissionModeLabel): string =>
  mode === "locked" ? "read-only" : mode;

export interface PermissionMenuRow {
  value: PermissionMode | "status" | "manage";
  label: string;
  description: string;
}

/** The five rows of the `/permission` menu, in order (decision P2). */
export function permissionMenuRows(current: PermissionModeLabel): PermissionMenuRow[] {
  const locked = current === "locked";
  const mode = (id: PermissionMode, label: string): PermissionMenuRow => ({
    value: id,
    label: `${label}${current === id ? " (current)" : ""}`,
    description: locked
      ? "Locked: Alisio was started with --read-only"
      : id === "full"
        ? `${PERMISSION_MODE_TABLE[id].summary} Not a sandbox.`
        : PERMISSION_MODE_TABLE[id].summary,
  });
  return [
    mode("ask", "Use ask mode"),
    mode("auto", "Use auto mode"),
    mode("full", "Use full access mode"),
    {
      value: "status",
      label: "Status",
      description: "Show the current mode and what runs without asking",
    },
    {
      value: "manage",
      label: "Manage saved permissions…",
      description: "Review and revoke the permissions saved for this session",
    },
  ];
}

export type ModeTransition =
  | { ok: true; mode: PermissionMode; message: string; warning?: string; changed: boolean }
  | { ok: false; message: string };

/**
 * Moves to `target`. Refused under `--read-only` (there is no approval handler to widen); setting
 * the mode that is already active still succeeds, because it also resets "allow for this session"
 * widenings. Full access always carries the not-a-sandbox warning.
 */
export function permissionTransition(
  current: PermissionModeLabel,
  target: PermissionMode,
): ModeTransition {
  if (current === "locked") return { ok: false, message: PERMISSION_MODES_LOCKED };
  const spec = PERMISSION_MODE_TABLE[target];
  return {
    ok: true,
    mode: target,
    changed: current !== target,
    message: `Permission mode: ${target}. ${spec.summary}`,
    ...(target === "full" ? { warning: FULL_ACCESS_WARNING } : {}),
  };
}

export const isPermissionMode = (value: string): value is PermissionMode =>
  (PERMISSION_MODES as readonly string[]).includes(value);

export const RELOAD_BUSY =
  "Reload is only available between turns: wait for the current turn to finish.";

/** A reason to refuse `/reload` right now, or undefined when it is safe. */
export function reloadGuard(state: {
  busy: boolean;
  runningChildren: number;
  queuedPrompts: boolean;
  /** Live background tasks (`bg_run`): closing the old application would kill them. */
  backgroundTasks?: number;
}): string | undefined {
  if (state.busy) return RELOAD_BUSY;
  if (state.backgroundTasks)
    return `Reload would stop ${state.backgroundTasks} running background task${state.backgroundTasks === 1 ? "" : "s"}: stop ${state.backgroundTasks === 1 ? "it" : "them"} with /tasks or wait for ${state.backgroundTasks === 1 ? "it" : "them"} to finish, then reload.`;
  if (state.runningChildren > 0)
    return `Reload is unavailable while ${state.runningChildren} subagent${state.runningChildren === 1 ? " is" : "s are"} running: wait for ${state.runningChildren === 1 ? "it" : "them"} to finish or cancel with Ctrl+K in the agents panel.`;
  if (state.queuedPrompts) return "Reload is unavailable while an approval or question is waiting.";
  return undefined;
}
