/**
 * Opening and revealing local files with the desktop's default application, portably and without
 * a shell: arguments are an array (no `cmd /c start`, no `sh -c`), so a file name can never inject
 * a command. Only paths returned by the artifact store are opened, never a path the model wrote.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { dirname } from "node:path";

export interface Launch {
  command: string;
  args: string[];
}

export type OpenOutcome = { ok: true } | { ok: false; reason: "no-desktop" | "unavailable" };

export interface OpenDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawn?: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;
}

/** Commands that open `path` with the default app, in fallback order. */
export function openCommands(path: string, platform: NodeJS.Platform): Launch[] {
  if (platform === "darwin") return [{ command: "open", args: [path] }];
  if (platform === "win32") return [{ command: "explorer.exe", args: [path] }];
  return [
    { command: "xdg-open", args: [path] },
    { command: "gio", args: ["open", path] },
  ];
}

/** Commands that show `path` selected in the file manager (its folder on Linux/BSD). */
export function revealCommands(path: string, platform: NodeJS.Platform): Launch[] {
  if (platform === "darwin") return [{ command: "open", args: ["-R", path] }];
  if (platform === "win32") return [{ command: "explorer.exe", args: [`/select,${path}`] }];
  return [
    { command: "xdg-open", args: [dirname(path)] },
    { command: "gio", args: ["open", dirname(path)] },
  ];
}

/**
 * Whether a desktop session can show a window: never over SSH; on Linux/BSD only with a display
 * (`DISPLAY` or `WAYLAND_DISPLAY`). macOS and Windows always have one locally.
 */
export function desktopAvailable(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (platform === "darwin" || platform === "win32") return true;
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** Starts one detached launcher; resolves false when it cannot start (e.g. `ENOENT`). */
function start(launch: Launch, deps: OpenDeps): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = (deps.spawn ?? spawn)(launch.command, launch.args, {
        detached: true,
        stdio: "ignore",
        shell: false,
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

async function run(launches: Launch[], deps: OpenDeps): Promise<OpenOutcome> {
  const platform = deps.platform ?? process.platform;
  if (!desktopAvailable(platform, deps.env ?? process.env))
    return { ok: false, reason: "no-desktop" };
  for (const launch of launches) if (await start(launch, deps)) return { ok: true };
  return { ok: false, reason: "unavailable" };
}

/** Opens a file with the default application. */
export const openPath = (path: string, deps: OpenDeps = {}) =>
  run(openCommands(path, deps.platform ?? process.platform), deps);

/** Shows a file in the system file manager. */
export const revealPath = (path: string, deps: OpenDeps = {}) =>
  run(revealCommands(path, deps.platform ?? process.platform), deps);

/** The notice shown when nothing could be opened (the caller offers "Copy path"). */
export const cannotOpenMessage = (path: string, outcome: Exclude<OpenOutcome, { ok: true }>) =>
  outcome.reason === "no-desktop"
    ? `Can't open files here (no desktop session). Path: ${path}`
    : `No program to open files was found. Path: ${path}`;
