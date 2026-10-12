/**
 * Where the application finds the scratchpad of a session and which folders the retention sweep
 * may look at (spec §9.4, D19). Thin glue over `session-dir.ts`: the privacy rules live there, the
 * choice of root lives in `session-path.ts`.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSessionDir, findSessionScratchpad, type SessionDir } from "./session-dir.ts";
import { scratchBaseName, tmpRootChoice } from "./session-path.ts";

export interface ScratchpadProviderOptions {
  /** The root session of `session` (a child session shares its root's scratchpad). */
  rootOf: (session: string) => string;
  /** Workspace of a root session; names its folder. */
  workspaceOf: (rootSessionId: string) => string;
  workspaceKey: (workspace: string) => string;
  /** Home of the `<stateHome>/scratch` fallback. */
  stateHome: string;
  /** `forge.scratch.root`, read on every first use so a changed setting applies. */
  configRoot: () => string | null | undefined;
  /** Reports the diagnostic of a session that fell back to the state folder. */
  onDiagnostic?: (message: string) => void;
  env?: Record<string, string | undefined>;
}

export type ScratchpadProvider = (session: string) => Promise<string | undefined>;

/**
 * The verified scratchpad of the session's ROOT session, created on first use and remembered.
 * Any failure (no usable folder) means "no scratchpad" for that call and is retried next time.
 */
export function createScratchpadProvider(options: ScratchpadProviderOptions): ScratchpadProvider {
  const dirs = new Map<string, Promise<SessionDir>>();
  return async (session) => {
    try {
      const rootSessionId = options.rootOf(session);
      let pending = dirs.get(rootSessionId);
      if (!pending) {
        const workspace = options.workspaceOf(rootSessionId);
        pending = ensureSessionDir({
          rootSessionId,
          workspace,
          workspaceKey: options.workspaceKey(workspace),
          stateHome: options.stateHome,
          configRoot: options.configRoot() ?? null,
          ...(options.env ? { env: options.env } : {}),
        });
        dirs.set(rootSessionId, pending);
        pending.then(
          (dir) => {
            if (dir.diagnostic) options.onDiagnostic?.(dir.diagnostic);
          },
          () => dirs.delete(rootSessionId),
        );
      }
      return (await pending).scratchpad;
    } catch {
      return undefined;
    }
  };
}

/**
 * The scratchpad of the session's ROOT session only if its folder already exists: nothing is
 * created. For read-only surfaces (the HTTP listing).
 */
export function createScratchpadLookup(options: ScratchpadProviderOptions): ScratchpadProvider {
  return async (session) => {
    try {
      const rootSessionId = options.rootOf(session);
      const workspace = options.workspaceOf(rootSessionId);
      return await findSessionScratchpad({
        rootSessionId,
        workspace,
        workspaceKey: options.workspaceKey(workspace),
        stateHome: options.stateHome,
        configRoot: options.configRoot() ?? null,
        ...(options.env ? { env: options.env } : {}),
      });
    } catch {
      return undefined;
    }
  };
}

export interface ScratchRootsOptions {
  /**
   * The store is not the user's default one (an embedder or a test passed its own database): it
   * cannot tell which sessions of the shared temporary root exist, so that root is left alone.
   */
  customStore: boolean;
  /** `<stateHome>/scratch` of this application's state. */
  stateHome: string;
  configRoot: string | null | undefined;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  uid?: number;
  osTmpdir?: string;
}

/** The scratch roots the janitor sweeps: `<tmp>/alisio-<uid>` (default store only) and `<state>/scratch`. */
export function scratchSweepRoots(options: ScratchRootsOptions): string[] {
  const roots = [join(options.stateHome, "scratch")];
  if (options.customStore) return roots;
  const platform = options.platform ?? process.platform;
  const uid = platform === "win32" ? undefined : (options.uid ?? process.getuid?.());
  const tmp = tmpRootChoice({
    env: (options.env ?? process.env).ALISIO_TMPDIR,
    config: options.configRoot,
    os: options.osTmpdir ?? tmpdir(),
  });
  return [join(tmp, scratchBaseName(platform, uid)), ...roots];
}
