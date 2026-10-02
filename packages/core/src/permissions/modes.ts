/**
 * Permission modes (`ask`, `auto`, `full`): the ONE table that maps a mode to the runner policy,
 * shared by the TUI (`/permission`) and the web presets (`host/presets.ts`). Pure: no I/O.
 *
 * A mode only decides which EFFECTS run without asking. It is not a sandbox and it does not change
 * path confinement (`PathAccess` still asks per external directory) or the `analysis` pre-grant.
 */
import type { PermissionMode, PermissionPresetId } from "@alisio/sdk";
import type { Policy } from "../core/contracts.ts";

export type { PermissionMode };
export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "auto", "full"];

/** The effects a mode lets run without asking. `analysis` is never part of a mode. */
export type ModePolicy = Pick<Policy, "write" | "process" | "external">;

export interface PermissionModeSpec {
  /** Effects allowed without asking; the rest ask (or are denied when `approvals` is false). */
  policy: ModePolicy;
  /** Whether the effects that are not allowed ask for approval. */
  approvals: boolean;
  /** The web preset that implements this mode. */
  preset: Exclude<PermissionPresetId, "read-only">;
  label: string;
  summary: string;
}

/** The single mapping table (decision P3). Auto = fixed rules, no model classifier. */
export const PERMISSION_MODE_TABLE: Readonly<Record<PermissionMode, PermissionModeSpec>> = {
  ask: {
    policy: { write: false, process: false, external: false },
    approvals: true,
    preset: "ask",
    label: "Ask",
    summary: "Every write, command and network call asks first.",
  },
  auto: {
    policy: { write: true, process: false, external: false },
    approvals: true,
    preset: "workspace-write",
    label: "Auto",
    summary:
      "File edits inside the workspace run without asking; commands, network calls and external directories still ask.",
  },
  full: {
    policy: { write: true, process: true, external: true },
    approvals: true,
    preset: "full-access",
    label: "Full access",
    summary: "Writes, commands and network calls run without asking.",
  },
};

/** The read-only preset: nothing runs and nothing can be approved. Not selectable as a mode. */
export const READ_ONLY_POLICY: ModePolicy = { write: false, process: false, external: false };

export const FULL_ACCESS_WARNING =
  "Full access: writes, commands and network calls run without asking. This is not a sandbox: anything the agent runs has your user's permissions.";
export const PERMISSION_MODES_LOCKED =
  "Permission modes are locked: Alisio was started with --read-only.";
export const PERMISSION_USAGE = "Usage: /permission [ask|auto|full|status]";

/** The mode a web preset implements; `read-only` has none. */
export function presetToMode(preset: PermissionPresetId): PermissionMode | undefined {
  return PERMISSION_MODES.find((mode) => PERMISSION_MODE_TABLE[mode].preset === preset);
}

/** The web preset of a mode. */
export function modeToPreset(mode: PermissionMode): PermissionPresetId {
  return PERMISSION_MODE_TABLE[mode].preset;
}

/** `ask`, `auto` or `full` (also the preset spellings `full-access` and `workspace-write`). */
export function parsePermissionMode(text: string): PermissionMode | undefined {
  const value = text.trim().toLowerCase();
  if (value === "full-access") return "full";
  if (value === "workspace-write") return "auto";
  return PERMISSION_MODES.find((mode) => mode === value);
}

export type PermissionCommand =
  | { type: "menu" }
  | { type: "status" }
  | { type: "set"; mode: PermissionMode }
  | { type: "invalid"; input: string };

/** Parses the arguments of `/permission` (`ask|auto|full|status`; none opens the menu). */
export function parsePermissionCommand(args: string): PermissionCommand {
  const text = args.trim().toLowerCase();
  if (!text) return { type: "menu" };
  if (text === "status") return { type: "status" };
  const mode = parsePermissionMode(text);
  return mode ? { type: "set", mode } : { type: "invalid", input: args.trim() };
}

/** What a TUI shows for its mode: a real mode, a flag combination that matches none, or locked. */
export type PermissionModeLabel = PermissionMode | "custom" | "locked";

export interface ModeFlags {
  allowWrite?: boolean;
  allowProcess?: boolean;
  allowExternal?: boolean;
  readOnly?: boolean;
}

/**
 * The initial mode label of a TUI process from its launch flags: `--read-only` is locked, no flags
 * is `ask`, `--allow-write` alone is `auto`, the three allow flags are `full`, anything else is
 * `custom`. It only LABELS the state: no policy is applied at startup.
 */
export function modeFromFlags(flags: ModeFlags): PermissionModeLabel {
  if (flags.readOnly) return "locked";
  const { allowWrite: write, allowProcess: process, allowExternal: external } = flags;
  if (!write && !process && !external) return "ask";
  if (write && !process && !external) return "auto";
  if (write && process && external) return "full";
  return "custom";
}

export type EffectState = "on" | "ask" | "off";

/** How one effect behaves under a policy: runs, asks, or is denied. */
export function effectState(allowed: boolean, approvals: boolean): EffectState {
  return allowed ? "on" : approvals ? "ask" : "off";
}

/** Markdown status of the permission state of a session (shared wording for TUI and API callers). */
export function describePermissionStatus(input: {
  mode: PermissionModeLabel;
  policy: Readonly<Policy>;
  approvals: boolean;
}): string {
  const { mode, policy, approvals } = input;
  const row = (label: string, allowed: boolean) => `- ${label}: ${effectState(allowed, approvals)}`;
  const head =
    mode === "locked"
      ? "Permission mode: **locked** (read-only)"
      : mode === "custom"
        ? "Permission mode: **custom** (launch flags that match no mode)"
        : `Permission mode: **${mode}** — ${PERMISSION_MODE_TABLE[mode].summary}`;
  return [
    head,
    "",
    row("write", policy.write),
    row("process", policy.process),
    row("external (network, MCP, plugin tools)", policy.external),
    ...(policy.analysis ? ["- Python analysis: pre-allowed (--allow-analysis)"] : []),
    "",
    "`on` runs without asking, `ask` prompts first, `off` is denied. Paths outside the workspace ask per directory. Modes are not a sandbox.",
  ].join("\n");
}
