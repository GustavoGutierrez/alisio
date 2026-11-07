/**
 * Shared state and calls of the plugin tabs: the one install/uninstall that may run at a time, the
 * "don't ask again this session" choice Module-level (not in the
 * app store) so it stays in the lazy settings chunk.
 */
import { signal } from "@preact/signals";
import { api, showToast } from "../../store/app.ts";
import {
  type InstallResultView,
  installOutcome,
  type UninstallResultView,
} from "./catalog-model.ts";
import { cs } from "./catalog-strings.ts";
import { errorMessage } from "./shared.tsx";

/** The package whose install or uninstall is running (the server runs one at a time). */
export const working = signal<string | undefined>();
/** "Don't ask again this session" for the install warning. */
export const sessionPrefs = { skipInstallWarning: false };

export const installPackage = (name: string, version: string) =>
  api.request<InstallResultView>("POST", "/api/plugins/install", {
    package: name,
    version,
    confirmed: true,
  });

export const uninstallPackage = (name: string) =>
  api.request<UninstallResultView>("DELETE", `/api/plugins/package/${encodeURIComponent(name)}`);

/** Toast for a finished install; remembers that a restart is needed. */
export function announceInstall(name: string, result: InstallResultView): void {
  const outcome = installOutcome(name, result);
  showToast(cs(outcome.key, outcome.params));
}

export const failureText = (
  key: "install.failed" | "uninstall.failed",
  name: string,
  error: unknown,
) => cs(key, { name, message: errorMessage(error) });
