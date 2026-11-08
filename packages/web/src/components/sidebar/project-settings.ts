/**
 * Pure model of the "Project settings" dialog and of the project menu: name validation and the
 * patch it sends, the facts the dialog shows and the patches its toggles send. The initial bundle
 * only pulls this small module (menu items); the dialog and its texts are lazy chunks.
 */
import type { WorkspaceInfo } from "@alisio/sdk";
import type { MessageKey } from "../../i18n/index.ts";
import { folderName } from "../../store/sessions.ts";

export { folderName };

/** Same limit as `PATCH /api/workspaces/:wid` (`label`). */
export const LABEL_MAX = 200;

export type LabelProblem = "tooLong";

/** Why a draft name cannot be saved (blank is fine: it clears the name). */
export function labelProblem(draft: string): LabelProblem | undefined {
  return draft.trim().length > LABEL_MAX ? "tooLong" : undefined;
}

/**
 * The patch that saves a draft name: the trimmed text, `null` when blank (back to the folder
 * name), `undefined` when nothing changes or the draft is invalid.
 */
export function labelPatch(
  draft: string,
  workspace: Pick<WorkspaceInfo, "label">,
): { label: string | null } | undefined {
  if (labelProblem(draft)) return undefined;
  const next = draft.trim() || null;
  return next === (workspace.label ?? null) ? undefined : { label: next };
}

/** What the dialog shows and what its immediate toggles send. */
export function projectSettingsFacts(workspace: WorkspaceInfo) {
  return {
    folder: folderName(workspace.path),
    path: workspace.path,
    missing: workspace.exists === false,
    pinPatch: { pinned: !workspace.pinned },
    archivePatch: { archived: !workspace.archived },
  };
}

/** Items of a project's "…" menu; `tr` is `t` (a parameter keeps this module DOM- and i18n-free). */
export function projectMenuItems(
  workspace: WorkspaceInfo,
  tr: (key: MessageKey) => string,
): Array<{ id: string; label: string; description?: string }> {
  return [
    { id: "pin", label: tr(workspace.pinned ? "workspace.unpin" : "workspace.pin") },
    { id: "color", label: tr("workspace.color") },
    { id: "settings", label: tr("workspace.settings") },
    { id: "archive", label: tr(workspace.archived ? "workspace.unarchive" : "workspace.archive") },
    ...(workspace.exists === false
      ? []
      : [
          {
            id: "trust",
            label: tr(workspace.trusted ? "trust.revoke" : "trust.grant"),
            description: tr("trust.menuHint"),
          },
        ]),
  ];
}
