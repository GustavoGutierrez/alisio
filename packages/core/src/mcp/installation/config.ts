/**
 * Global-only installer preference (`mcp.install.timeoutSeconds`): how long the initial download
 * may take. A project layer is never consulted, so a repository cannot stretch it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configHome } from "../../config.ts";

export const DEFAULT_INSTALL_TIMEOUT_MS = 180_000;
export const MIN_INSTALL_TIMEOUT_MS = 30_000;
export const MAX_INSTALL_TIMEOUT_MS = 600_000;

export const clampInstallTimeout = (ms: number): number =>
  Math.min(MAX_INSTALL_TIMEOUT_MS, Math.max(MIN_INSTALL_TIMEOUT_MS, Math.round(ms)));

export function readInstallTimeoutMs(): number {
  try {
    const raw = JSON.parse(readFileSync(join(configHome(), "config.json"), "utf8")) as {
      mcp?: { install?: { timeoutSeconds?: unknown } };
    };
    const seconds = raw.mcp?.install?.timeoutSeconds;
    return typeof seconds === "number" && Number.isFinite(seconds)
      ? clampInstallTimeout(seconds * 1000)
      : DEFAULT_INSTALL_TIMEOUT_MS;
  } catch {
    return DEFAULT_INSTALL_TIMEOUT_MS;
  }
}
