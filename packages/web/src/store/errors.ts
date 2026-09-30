/** User-facing text of a failed action (toasts): known API errors get a localized explanation. */
import { t } from "../i18n/index.ts";
import { ApiRequestError } from "../net/api.ts";

export function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const path = (error.details as { path?: unknown } | undefined)?.path;
    const where = { path: typeof path === "string" ? path : "" };
    if (error.code === "workspace_missing") return t("error.workspaceMissing", where);
    if (error.code === "workspace_archived") return t("error.workspaceArchived", where);
    if (error.code === "picker_busy") return t("error.pickerBusy");
  }
  return error instanceof Error ? error.message : String(error);
}
