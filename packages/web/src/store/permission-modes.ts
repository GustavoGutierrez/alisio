/**
 * The permission-mode view of the session presets, used by the permissions popover only (its own
 * chunk, so these helpers stay out of the initial bundle). Pure: no DOM, no signals.
 */
import type { PermissionMode, PermissionPresetId, PermissionPresetInfo } from "@alisio/sdk";

const MODE_ORDER: readonly PermissionMode[] = ["ask", "auto", "full"];

export interface ModeChoice {
  mode: PermissionMode;
  preset: PermissionPresetId;
  available: boolean;
  checked: boolean;
  /** Why it is unavailable, or which effects still ask because of the server flags. */
  reason?: string;
}

/**
 * The three modes the `/permission` popover offers (never `read-only`), from the session presets.
 * A mode whose preset the server cannot offer is listed as unavailable with the reason.
 */
export function modeChoices(
  presets: ReadonlyArray<PermissionPresetInfo>,
  current: PermissionPresetId,
): ModeChoice[] {
  return MODE_ORDER.flatMap((mode) => {
    const preset = presets.find((candidate) => candidate.mode === mode);
    return preset
      ? [
          {
            mode,
            preset: preset.id,
            available: preset.available,
            checked: preset.id === current,
            ...(preset.reason ? { reason: preset.reason } : {}),
          },
        ]
      : [];
  });
}

/** The mode of a preset, or undefined for `read-only`. */
export const modeOfPreset = (
  presets: ReadonlyArray<PermissionPresetInfo>,
  preset: PermissionPresetId,
): PermissionMode | undefined => presets.find((candidate) => candidate.id === preset)?.mode;
