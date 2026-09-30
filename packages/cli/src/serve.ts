/**
 * `alisio serve`: loaded only by the serve action, and it loads `@alisio/server` only then, so
 * `alisio`, `alisio run` and the TUI never load the HTTP server (spec §3.4, T-12).
 */
import { spawn } from "node:child_process";
import type { AppOptions } from "@alisio/core";

export interface ServeFlags {
  port: string;
  host: string;
  allowRemote?: boolean;
  open: boolean;
  maxWorkspaces: string;
  maxRuns: string;
}

/** The operating system's URL opener for `platform`, as `[command, ...args]`. */
export function browserCommand(platform: NodeJS.Platform, url: string): string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd", "/c", "start", '""', url];
  return ["xdg-open", url];
}

/** Opens `url` in the default browser; failures are reported, never fatal. */
export function openBrowser(url: string): void {
  const [command = "", ...args] = browserCommand(process.platform, url);
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () =>
      process.stderr.write("Could not open a browser; open the URL above manually.\n"),
    );
    child.unref();
  } catch {
    process.stderr.write("Could not open a browser; open the URL above manually.\n");
  }
}

/** Parsed option keys that are not `AppOptions` (serve flags and UI-only globals). */
const SERVE_ONLY_KEYS = new Set([
  "port",
  "host",
  "allowRemote",
  "open",
  "maxWorkspaces",
  "maxRuns",
  "json",
  "quiet",
  "banner",
  "tui",
  "baseUrl",
  "herdr",
  "disablePlugin",
  "addDir",
  "agents",
]);

function positiveInt(value: string, flag: string, min = 1): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min)
    throw new Error(`${flag} expects an integer >= ${min}, got "${value}"`);
  return parsed;
}

/** Starts the server, prints the launch URL and stops cleanly on SIGINT/SIGTERM. */
export async function serve(
  flags: ServeFlags,
  app: AppOptions & Record<string, unknown>,
  version: string,
): Promise<void> {
  const port = positiveInt(flags.port, "--port", 0);
  if (port > 65_535) throw new Error(`--port expects a value up to 65535, got "${flags.port}"`);
  const { startServer, isLoopbackHost } = await import("@alisio/server");
  if (!isLoopbackHost(flags.host) && !flags.allowRemote)
    throw new Error(
      `--host ${flags.host} is not a loopback address: add --allow-remote to expose the server on the network (no TLS; prefer an SSH tunnel).`,
    );
  // Global CLI options minus the serve flags and the UI-only ones: the rest are app options.
  const {
    cwd,
    onEvent: _onEvent,
    approve: _approve,
    approveExternalDirectory: _approveDirectory,
    ...rest
  } = app;
  const base = Object.fromEntries(
    Object.entries(rest).filter(([key]) => !SERVE_ONLY_KEYS.has(key)),
  ) as Omit<AppOptions, "cwd">;
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({
      host: flags.host,
      port,
      allowRemote: !!flags.allowRemote,
      version,
      maxOpenWorkspaces: positiveInt(flags.maxWorkspaces, "--max-workspaces"),
      maxConcurrentRuns: positiveInt(flags.maxRuns, "--max-runs"),
      defaultWorkspace: cwd ?? process.cwd(),
      app: base,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE")
      throw new Error(
        `Port ${port} is already in use: choose another with --port <n> (0 picks a free one).`,
      );
    throw error;
  }
  process.stdout.write(`Alisio web UI: ${server.launchUrl}\n`);
  if (!isLoopbackHost(flags.host))
    process.stderr.write(
      `Warning: listening on ${flags.host} (--allow-remote). Anyone who can reach this address and obtains the token can drive the agent; traffic is not encrypted.\n`,
    );
  if (!server.webInstalled)
    process.stderr.write(
      "The web UI assets are not installed in this build; only the HTTP API is served.\n",
    );
  process.stderr.write("Press Ctrl+C to stop.\n");
  if (flags.open) openBrowser(server.launchUrl);
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(130);
    stopping = true;
    process.stderr.write("Stopping Alisio server…\n");
    // Safety net: shutdown is bounded internally; never hang the terminal.
    setTimeout(() => process.exit(1), 8_000).unref();
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
