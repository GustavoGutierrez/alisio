import type { Policy } from "@alisio/core";
import type { PermissionPresetId, PermissionPresetInfo } from "@alisio/sdk";

export const PRESET_IDS: readonly PermissionPresetId[] = [
  "read-only",
  "ask",
  "workspace-write",
  "full-access",
];
export const DEFAULT_PRESET: PermissionPresetId = "workspace-write";

/** What each preset asks for before the server ceiling is applied (RF-08). */
const WANTED: Record<PermissionPresetId, { policy: Policy; approvals: boolean }> = {
  "read-only": { policy: { write: false, process: false, external: false }, approvals: false },
  ask: { policy: { write: false, process: false, external: false }, approvals: true },
  "workspace-write": { policy: { write: true, process: false, external: false }, approvals: true },
  "full-access": { policy: { write: true, process: true, external: true }, approvals: true },
};

const FLAG: Record<keyof Policy, string> = {
  write: "--allow-write",
  process: "--allow-process",
  external: "--allow-external",
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
  };
  if (ceiling.readOnly && id !== "read-only")
    return {
      id,
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
