/**
 * Command fingerprint v1 (specs/011, Fase 0 decision): `sha256(JSON.stringify({v:1, argv, cwd}))`.
 * `run_process` uses `[command, ...args]`; `shell` and `bg_run` use `["sh","-c", normalized]`; the
 * working directory is relative to the workspace with `/` and `.` by default. No environment.
 */
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

export type CommandTool = "run_process" | "shell";

/** The canonical workspace-relative directory: forward slashes, no `./` prefix, `.` when empty. */
export function normalizeCwd(cwd: string): string {
  return (
    cwd
      .split("\\")
      .join("/")
      .replace(/^(\.\/)+/, "")
      .replace(/\/+$/, "") || "."
  );
}

/** Directory of a call relative to the workspace (`.` when it is the workspace itself). */
export function relativeCwd(workspace: string, cwd: string | undefined): string {
  if (!cwd) return ".";
  const abs = isAbsolute(cwd) ? cwd : resolve(workspace, cwd);
  return normalizeCwd(relative(workspace, abs));
}

export function commandFingerprint(argv: readonly string[], cwd: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ v: 1, argv, cwd: normalizeCwd(cwd) }))
    .digest("hex");
}

/** Trims and collapses whitespace runs OUTSIDE single/double quotes; quoted text stays verbatim. */
export function normalizeShell(command: string): string {
  let out = "";
  let quote: string | undefined;
  let pendingSpace = false;
  for (const ch of command.trim()) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = undefined;
    } else if (/\s/.test(ch)) {
      pendingSpace = true;
    } else {
      if (pendingSpace) out += " ";
      pendingSpace = false;
      out += ch;
      if (ch === '"' || ch === "'") quote = ch;
    }
  }
  return out;
}

/** Fingerprint of a call as the tool received it. */
export function callFingerprint(
  tool: CommandTool,
  input: { command: string; args?: readonly string[] },
  cwd: string,
): string {
  const argv =
    tool === "run_process"
      ? [input.command, ...(input.args ?? [])]
      : ["sh", "-c", normalizeShell(input.command)];
  return commandFingerprint(argv, cwd);
}

const SHELL_OPERATORS = /[|&;<>()$`\\*?~#{}!\n]/;

/**
 * Splits a plain command line into an argv (single and double quotes group words). Returns
 * undefined when the line needs a shell (operators, expansions, unbalanced quotes): only the
 * shell form can then match it.
 */
export function splitCommand(command: string): string[] | undefined {
  const argv: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word ??= "";
    } else if (/\s/.test(ch)) {
      if (word !== undefined) argv.push(word);
      word = undefined;
    } else if (SHELL_OPERATORS.test(ch)) {
      return undefined;
    } else {
      word = (word ?? "") + ch;
    }
  }
  if (quote) return undefined;
  if (word !== undefined) argv.push(word);
  return argv.length ? argv : undefined;
}

/**
 * Every fingerprint a call may have to satisfy the criterion command `command` run in `cwd`: the
 * `shell` form always and the `run_process` form when the line is a plain argv.
 */
export function criterionFingerprints(command: string, cwd: string): string[] {
  const out = [callFingerprint("shell", { command }, cwd)];
  const argv = splitCommand(command);
  if (argv) out.unshift(commandFingerprint(argv, cwd));
  return out;
}
