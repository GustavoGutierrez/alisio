/**
 * Clipboard adapter for the TUI. Command selection is pure and the process spawner is
 * injected, so tests never touch a real clipboard.
 */

/** Resolves with the exit code; rejects when the executable cannot be started. */
export type Spawn = (command: string, args: string[], input: string) => Promise<number>;
export interface ClipboardCommand {
  command: string;
  args: string[];
}
export interface CopyResult {
  ok: boolean;
  /** Tool that succeeded, `osc52` (unverified) or `none`. */
  method: string;
}

export function clipboardCommands(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): ClipboardCommand[] {
  const windows: ClipboardCommand[] = [
    { command: "clip.exe", args: [] },
    {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value $input"],
    },
  ];
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  if (platform === "win32") return windows;
  return [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["-b"] },
    ...(env.WSL_DISTRO_NAME ? windows : []),
  ];
}

export const osc52 = (text: string) =>
  `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;

/**
 * Tries native tools in order (stdin input, no shell) and succeeds only on exit code 0.
 * Otherwise writes OSC 52 when a writer is available; that path cannot be verified, so it
 * reports `ok: false` with method `osc52`.
 */
export async function copyText(
  text: string,
  deps: {
    platform: NodeJS.Platform;
    env: Record<string, string | undefined>;
    spawn: Spawn;
    writeOsc52?: (sequence: string) => void;
  },
): Promise<CopyResult> {
  for (const { command, args } of clipboardCommands(deps.platform, deps.env)) {
    try {
      if ((await deps.spawn(command, args, text)) === 0) return { ok: true, method: command };
    } catch {
      /* Not installed or not startable: try the next tool. */
    }
  }
  if (deps.writeOsc52) {
    deps.writeOsc52(osc52(text));
    return { ok: false, method: "osc52" };
  }
  return { ok: false, method: "none" };
}

/** Real spawner (Bun): no shell, text on stdin, output ignored, bounded by a timeout. */
export const bunSpawn: Spawn = async (command, args, input) => {
  if (!Bun.which(command)) throw new Error(`${command} not found`);
  const child = Bun.spawn([command, ...args], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.stdin.write(input);
  await child.stdin.end();
  const timer = setTimeout(() => child.kill(), 3_000);
  try {
    return await child.exited;
  } finally {
    clearTimeout(timer);
  }
};
