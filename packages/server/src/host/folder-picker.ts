/**
 * Native folder dialog for "Open a workspace". Browsers cannot hand a page an absolute folder path
 * (`showDirectoryPicker` returns a handle, never a path), so the local server opens the operating
 * system's dialog on its own desktop and returns the chosen path. Every command is spawned with
 * `execFile` (no shell) and fixed arguments; the only inputs are the dialog title and an optional,
 * already validated start directory, passed as separate arguments or environment variables and
 * never interpolated into a script.
 *
 * The pure pieces (PATH lookup, strategy selection, command construction, output parsing) take the
 * platform as a parameter, so all three operating systems are unit tested on any host.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { HttpError } from "../http/errors.ts";

export type PickerTool = "zenity" | "kdialog" | "yad" | "osascript" | "powershell";

/** The dialog tool chosen for this machine. */
export interface PickerStrategy {
  tool: PickerTool;
  /** Absolute path of the executable. */
  file: string;
  platform: NodeJS.Platform;
}

type Env = Record<string, string | undefined>;
type Exists = (file: string) => Promise<boolean>;

const pathApi = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** Case-insensitive environment lookup (Windows spells it `Path`). */
function envValue(env: Env, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

const executable: Exists = async (file) => {
  try {
    await access(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * First `name` on `PATH` (no `which`/`where`): splits `PATH` with the platform's delimiter and, on
 * Windows, tries every `PATHEXT` extension.
 */
export async function findOnPath(
  name: string,
  options: { platform?: NodeJS.Platform; env?: Env; exists?: Exists } = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? executable;
  const api = pathApi(platform);
  const dirs = (envValue(env, "PATH") ?? "").split(api.delimiter).filter(Boolean);
  const extensions =
    platform === "win32" && !api.extname(name)
      ? (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of dirs)
    for (const extension of extensions) {
      const file = api.join(dir, `${name}${extension}`);
      if (await exists(file)) return file;
    }
  return undefined;
}

const LINUX_TOOLS = ["zenity", "kdialog", "yad"] as const;
const UNIX_DESKTOPS = new Set<NodeJS.Platform>(["linux", "freebsd", "openbsd", "netbsd"]);

/**
 * The dialog tool for a platform, or `undefined` when none can show a dialog here:
 * Linux/BSD need a desktop session (`DISPLAY` or `WAYLAND_DISPLAY`) and zenity, kdialog or yad;
 * macOS uses `osascript`; Windows uses Windows PowerShell (or `pwsh`).
 * `ALISIO_NATIVE_PICKER=0` turns the native dialog off (the in-app browser is used instead).
 */
export async function selectPicker(
  options: { platform?: NodeJS.Platform; env?: Env; exists?: Exists } = {},
): Promise<PickerStrategy | undefined> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? executable;
  const lookup = { platform, env, exists };
  if (
    ["0", "off", "false", "no"].includes(
      (envValue(env, "ALISIO_NATIVE_PICKER") ?? "").toLowerCase(),
    )
  )
    return undefined;
  if (UNIX_DESKTOPS.has(platform)) {
    if (!envValue(env, "DISPLAY") && !envValue(env, "WAYLAND_DISPLAY")) return undefined;
    for (const tool of LINUX_TOOLS) {
      const file = await findOnPath(tool, lookup);
      if (file) return { tool, file, platform };
    }
    return undefined;
  }
  if (platform === "darwin") {
    // `osascript` ships with every macOS; PATH may be minimal when launched from a GUI.
    const file = (await findOnPath("osascript", lookup)) ?? "/usr/bin/osascript";
    return { tool: "osascript", file, platform };
  }
  if (platform === "win32") {
    const file =
      (await findOnPath("powershell", lookup)) ??
      (await findOnPath("pwsh", lookup)) ??
      (await (async () => {
        const root = envValue(env, "SystemRoot") ?? "C:\\Windows";
        const system = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        return (await exists(system)) ? system : undefined;
      })());
    return file ? { tool: "powershell", file, platform } : undefined;
  }
  return undefined;
}

/** AppleScript run with `osascript -e … title [start]`: inputs arrive as `argv`, never inlined. */
const APPLESCRIPT = [
  "on run argv",
  "set promptText to item 1 of argv",
  "if (count of argv) > 1 then",
  "set chosen to choose folder with prompt promptText default location (POSIX file (item 2 of argv))",
  "else",
  "set chosen to choose folder with prompt promptText",
  "end if",
  "return POSIX path of chosen",
  "end run",
];

/**
 * Fixed PowerShell script (`-STA` is required by WinForms dialogs). Title and start directory come
 * from environment variables. Output is UTF-8; a cancelled dialog prints nothing. Falls back to
 * the Shell.Application folder browser when WinForms is unavailable.
 */
const POWERSHELL = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "try {",
  "  Add-Type -AssemblyName System.Windows.Forms",
  "  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  "  $dialog.Description = $env:ALISIO_PICKER_TITLE",
  "  $dialog.ShowNewFolderButton = $true",
  "  if ($env:ALISIO_PICKER_START) { $dialog.SelectedPath = $env:ALISIO_PICKER_START }",
  "  $owner = New-Object System.Windows.Forms.Form",
  "  $owner.TopMost = $true",
  "  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
  "  $owner.Dispose()",
  "} catch {",
  "  $shell = New-Object -ComObject Shell.Application",
  "  $folder = $shell.BrowseForFolder(0, $env:ALISIO_PICKER_TITLE, 0x51, 0)",
  "  if ($folder) { [Console]::Out.Write($folder.Self.Path) }",
  "}",
].join("\n");

/** The exact executable, arguments and extra environment for one dialog. */
export function pickerCommand(
  strategy: PickerStrategy,
  options: { title: string; start?: string },
): { file: string; args: string[]; env?: Record<string, string> } {
  const { title, start } = options;
  // A trailing separator makes zenity/yad open *inside* the start directory.
  const inside = start ? `${posix.join(start, "/")}` : undefined;
  switch (strategy.tool) {
    case "zenity":
      return {
        file: strategy.file,
        args: [
          "--file-selection",
          "--directory",
          `--title=${title}`,
          ...(inside ? [`--filename=${inside}`] : []),
        ],
      };
    case "yad":
      return {
        file: strategy.file,
        args: [
          "--file",
          "--directory",
          `--title=${title}`,
          ...(inside ? [`--filename=${inside}`] : []),
        ],
      };
    case "kdialog":
      return {
        file: strategy.file,
        args: ["--getexistingdirectory", ...(start ? [start] : []), "--title", title],
      };
    case "osascript":
      return {
        file: strategy.file,
        args: [...APPLESCRIPT.flatMap((line) => ["-e", line]), title, ...(start ? [start] : [])],
      };
    case "powershell":
      return {
        file: strategy.file,
        args: ["-NoProfile", "-STA", "-Command", POWERSHELL],
        env: { ALISIO_PICKER_TITLE: title, ...(start ? { ALISIO_PICKER_START: start } : {}) },
      };
  }
}

export interface PickerProcessResult {
  /** Exit code (`null` when killed). */
  code: number | null;
  stdout: string;
  stderr?: string;
  /** Killed by the timeout: treated as a cancellation. */
  timedOut?: boolean;
}

export type PickerOutcome = { path: string } | { cancelled: true } | { error: string };

/** Cancel exit codes: 1 (zenity, kdialog, yad, osascript), 5 (zenity timeout), 252 (yad close). */
const CANCEL_CODES = new Set([1, 5, 252]);

/**
 * Maps a dialog's exit to the chosen absolute folder (normalized with the platform's own path
 * rules: macOS trailing slash, Windows backslashes and drive roots, CRLF), a cancellation, or an
 * error.
 */
export function parsePickerOutput(
  platform: NodeJS.Platform,
  result: PickerProcessResult,
): PickerOutcome {
  if (result.timedOut) return { cancelled: true };
  if (result.code !== 0) {
    if (result.code !== null && CANCEL_CODES.has(result.code)) return { cancelled: true };
    if (/\(-128\)/.test(result.stderr ?? "")) return { cancelled: true };
    const detail = (result.stderr ?? "").trim().slice(0, 300);
    return {
      error: `Folder dialog exited with ${result.code ?? "a signal"}${detail ? `: ${detail}` : ""}`,
    };
  }
  const line =
    result.stdout
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)[0]
      ?.trim() ?? "";
  if (!line) return { cancelled: true };
  const api = pathApi(platform);
  if (!api.isAbsolute(line)) return { error: "Folder dialog returned a relative path" };
  let path = api.normalize(line);
  const root = api.parse(path).root;
  while (path.length > root.length && (path.endsWith("/") || path.endsWith(api.sep)))
    path = path.slice(0, -1);
  return { path };
}

/** Runs one dialog process: resolves with its exit, never rejects on a non-zero exit. */
export type PickerRun = (
  file: string,
  args: string[],
  options: { env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
) => Promise<PickerProcessResult>;

const defaultRun: PickerRun = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        timeout: options.timeoutMs,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: { ...process.env, ...options.env },
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        const code = failure ? (typeof failure.code === "number" ? failure.code : null) : 0;
        resolve({
          code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? failure?.message ?? ""),
          ...(failure?.killed || failure?.name === "AbortError" ? { timedOut: true } : {}),
        });
      },
    );
  });

export interface FolderPicker {
  /** A dialog can be shown on this machine. */
  available(): Promise<boolean>;
  /** A dialog is open right now. */
  readonly busy: boolean;
  /**
   * Opens the dialog and waits for the user. Rejects with 409 `picker_busy` while another dialog
   * is open and 503 `picker_unavailable` when no dialog can be shown or it fails to start.
   */
  pick(options: {
    title: string;
    start?: string;
    signal?: AbortSignal;
  }): Promise<{ path: string } | { cancelled: true }>;
}

/**
 * A picker over the selected strategy. `strategy` defaults to `selectPicker()` (detected once);
 * `run` is injectable so tests never open a real dialog.
 */
export function createNativePicker(
  options: { strategy?: PickerStrategy | undefined; run?: PickerRun; timeoutMs?: number } = {},
): FolderPicker {
  const detected: Promise<PickerStrategy | undefined> =
    "strategy" in options
      ? Promise.resolve(options.strategy)
      : selectPicker().catch(() => undefined);
  const run = options.run ?? defaultRun;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  let open = false;
  return {
    available: async () => !!(await detected),
    get busy() {
      return open;
    },
    async pick({ title, start, signal }) {
      if (open) throw new HttpError("picker_busy", "A folder dialog is already open");
      open = true;
      try {
        const strategy = await detected;
        if (!strategy)
          throw new HttpError("picker_unavailable", "No native folder dialog on this server");
        const command = pickerCommand(strategy, { title, ...(start ? { start } : {}) });
        const result = await run(command.file, command.args, {
          timeoutMs,
          ...(command.env ? { env: command.env } : {}),
          ...(signal ? { signal } : {}),
        });
        const outcome = parsePickerOutput(strategy.platform, result);
        if ("error" in outcome)
          throw new HttpError("picker_unavailable", "The folder dialog could not be opened", {
            reason: outcome.error,
          });
        return outcome;
      } finally {
        open = false;
      }
    },
  };
}
