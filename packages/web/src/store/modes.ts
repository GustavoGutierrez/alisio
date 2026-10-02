/**
 * Pure helpers of the web modes (spec: modes, goal and background, Phase 1): the Shift+Tab agent
 * shortcut of the composer, the cycle over the server's agent list and the permission-mode view
 * of the session presets. No DOM, no signals: unit-testable.
 */
import type { AgentInfo, PermissionPresetId } from "@alisio/sdk";

/** The slice of a `KeyboardEvent` the shortcut decision reads. */
export interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
}

export interface ShiftTabContext {
  /** The `/` command palette is open (Shift+Tab then keeps its normal meaning). */
  paletteOpen: boolean;
  /** An IME composition is in progress (tracked by the composer on top of `isComposing`). */
  composing: boolean;
  /** The composer is disabled (locked or child session). */
  disabled: boolean;
}

/**
 * Whether a keydown in the composer textarea cycles the main agents: exactly Shift+Tab, not during
 * an IME composition, not with the slash palette open and with no other modifier. Anything else
 * keeps the browser's behavior (Shift+Tab normally moves the focus backwards: the visible agent
 * selector is the accessible way to switch).
 */
export function shiftTabCycles(event: KeyLike, context: ShiftTabContext): boolean {
  return (
    event.key === "Tab" &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.isComposing &&
    !context.composing &&
    !context.paletteOpen &&
    !context.disabled
  );
}

/**
 * The agent after (`step` 1) or before (`step` -1) `current` in the server's list, wrapping around.
 * `GET /api/agents` already returns the stable cycle order (build, plan, then custom agents by
 * name). An unknown current id starts at the first agent. An empty list yields undefined.
 */
export function nextAgentId(
  agents: ReadonlyArray<Pick<AgentInfo, "id">>,
  current: string | undefined,
  step: 1 | -1 = 1,
): string | undefined {
  if (!agents.length) return undefined;
  const index = agents.findIndex((agent) => agent.id === current);
  if (index < 0) return agents[0]?.id;
  return agents[(index + step + agents.length) % agents.length]?.id;
}

/** The id of the agent a session uses: its stored one, else the workspace default, else `build`. */
export function activeAgentId(
  stored: string | undefined,
  agents: ReadonlyArray<Pick<AgentInfo, "id"> & { default?: boolean }>,
): string {
  return stored ?? agents.find((agent) => agent.default)?.id ?? "build";
}

/** Whether choosing `target` needs the "not a sandbox" confirmation (full access, newly chosen). */
export const needsFullAccessConfirm = (
  target: PermissionPresetId,
  current: PermissionPresetId,
): boolean => target === "full-access" && current !== "full-access";
