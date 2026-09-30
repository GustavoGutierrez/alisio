import { type HealthInfo, UI_BLOCK_KINDS } from "@alisio/sdk";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";

/** Web protocol version (§8.9); independent of `RunEvent.schemaVersion`. */
export const PROTOCOL_VERSION = 1 as const;

export interface ServerStats {
  shuttingDown: boolean;
  activeRuns: number;
  queuedRuns: number;
  openWorkspaces: number;
  subscribers: number;
  pendingApprovals: number;
  sseDropped: number;
}

/** `/api/health` (unauthenticated), `/api/ready` and `/api/metrics`. */
export function registerHealthRoutes(
  router: Router,
  options: {
    version: string;
    remote: boolean;
    stats: () => ServerStats;
    /** A native folder dialog can be opened (detected once, lazily). */
    nativePicker?: () => Promise<boolean>;
    folderBrowser?: boolean;
  },
): void {
  router.get("/api/health", async () => {
    const body: HealthInfo = {
      name: "alisio",
      version: options.version,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        sse: true,
        websocket: false,
        multiWorkspace: true,
        attachments: true,
        uiBlocks: [...UI_BLOCK_KINDS],
        mcpApps: false,
        automation: false,
        remote: options.remote,
        nativePicker: (await options.nativePicker?.()) ?? false,
        folderBrowser: options.folderBrowser ?? false,
      },
    };
    return { body };
  });
  router.get("/api/ready", () => {
    const stats = options.stats();
    if (stats.shuttingDown) throw new HttpError("shutting_down", "Server is shutting down");
    return {
      body: { ready: true, workspaces: stats.openWorkspaces, activeRuns: stats.activeRuns },
    };
  });
  router.get("/api/metrics", () => {
    const { shuttingDown: _, ...metrics } = options.stats();
    return { body: metrics };
  });
}
