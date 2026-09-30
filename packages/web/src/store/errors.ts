/** User-facing text of a failed action (toasts): known API errors get a localized explanation. */
import { t } from "../i18n/index.ts";
import { ApiRequestError } from "../net/api.ts";

export function errorText(error: unknown): string {
  if (error instanceof ApiRequestError && error.code === "workspace_missing") {
    const path = (error.details as { path?: unknown } | undefined)?.path;
    return t("error.workspaceMissing", { path: typeof path === "string" ? path : "" });
  }
  return error instanceof Error ? error.message : String(error);
}
