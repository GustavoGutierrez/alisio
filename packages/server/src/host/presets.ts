import {
  PERMISSION_MODE_TABLE,
  type PermissionMode,
  type Policy,
  presetToMode,
  READ_ONLY_POLICY,
} from "@alisio/core";
import type { PermissionPresetId, PermissionPresetInfo } from "@alisio/sdk";

export const PRESET_IDS: readonly PermissionPresetId[] = [
  "read-only",
  "ask",
  "workspace-write",
  "full-access",
];
export const DEFAULT_PRESET: PermissionPresetId = "workspace-write";

/** The policy of a permission mode (the table lives in core, shared with the TUI). */
const ofMode = (mode: PermissionMode): { policy: Policy; approvals: boolean } => ({
  policy: { ...PERMISSION_MODE_TABLE[mode].policy },
  approvals: PERMISSION_MODE_TABLE[mode].approvals,
});

/** What each preset asks for before the server ceiling is applied (RF-08). */
const WANTED: Record<PermissionPresetId, { policy: Policy; approvals: boolean }> = {
  "read-only": { policy: { ...READ_ONLY_POLICY }, approvals: false },
  ask: ofMode("ask"),
  "workspace-write": ofMode("auto"),
  "full-access": ofMode("full"),
};

const FLAG: Record<keyof Policy, string> = {
  write: "--allow-write",
  process: "--allow-process",
  external: "--allow-external",
  analysis: "--allow-analysis",
};

/**
 * The capability ceiling of a workspace: the policy its app was launched with (the `alisio serve`
 * flags) and whether approvals exist at all (not under `--read-only`).
 */
export interface Ceiling {
  policy: Readonly<Policy>;
  approvals: boolean;
  readOnly: boolean;
}

/**
 * A preset narrowed by the ceiling: an effect the launch flags do not allow degrades to asking
 * (the runner only ever narrows its own policy). Under `--read-only` only `read-only` exists.
 */
export function presetInfo(id: PermissionPresetId, ceiling: Ceiling): PermissionPresetInfo {
  const wanted = WANTED[id];
  const policy: Policy = {
    write: wanted.policy.write && ceiling.policy.write,
    process: wanted.policy.process && ceiling.policy.process,
    external: wanted.policy.external && ceiling.policy.external,
    // `alisio serve --allow-analysis` pre-allows Python analysis where the preset allows
    // processes (full-access); elsewhere python_run asks.
    ...(wanted.policy.process && ceiling.policy.analysis ? { analysis: true } : {}),
  };
  const mode = presetToMode(id);
  if (ceiling.readOnly && id !== "read-only")
    return {
      id,
      ...(mode ? { mode } : {}),
      available: false,
      reason: "The server was started with --read-only",
      policy: { write: false, process: false, external: false },
      approvals: false,
    };
  const degraded = (Object.keys(FLAG) as Array<keyof Policy>).filter(
    (effect) => wanted.policy[effect] && !ceiling.policy[effect],
  );
  return {
    id,
    ...(mode ? { mode } : {}),
    available: true,
    ...(degraded.length
      ? {
          reason: `${degraded.join(", ")} still ask: the server was started without ${degraded.map((e) => FLAG[e]).join(", ")}`,
        }
      : {}),
    policy,
    approvals: wanted.approvals && ceiling.approvals,
  };
}

export const presetInfos = (ceiling: Ceiling): PermissionPresetInfo[] =>
  PRESET_IDS.map((id) => presetInfo(id, ceiling));

/** The stored preset of a session, falling back to the default (or `read-only` when forced). */
export function sessionPreset(
  options: Record<string, unknown> | undefined,
  ceiling: Ceiling,
): PermissionPresetId {
  const stored = options?.preset;
  const id = PRESET_IDS.includes(stored as PermissionPresetId)
    ? (stored as PermissionPresetId)
    : DEFAULT_PRESET;
  return presetInfo(id, ceiling).available ? id : "read-only";
}
