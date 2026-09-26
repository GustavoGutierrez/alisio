/**
 * Startup banner policy and terminal capability detection (pure), plus the glue that builds
 * the startup context from an application. Rendering itself lives in @alisio/core.
 */
import { homedir, userInfo } from "node:os";
import type { StartupInput, StartupResult, TerminalCapabilities } from "@alisio/core";

type Env = Record<string, string | undefined>;
export interface BannerPolicyInput {
  mode: "tui" | "readline" | "run";
  json?: boolean;
  quiet?: boolean;
  /** `false` when --no-banner is given. */
  banner?: boolean;
  stdoutTTY: boolean;
  stderrTTY: boolean;
  env: Env;
}
/**
 * Banner only for interactive sessions: never for run/resume-with-prompt, --json, --quiet,
 * --no-banner, CI, or when the target stream is not a terminal.
 */
export function bannerPolicy(input: BannerPolicyInput): boolean {
  if (input.mode === "run" || input.json || input.quiet || input.banner === false) return false;
  if (input.env.CI && input.env.CI !== "false" && input.env.CI !== "0") return false;
  // The TUI draws on stdout; readline mode prints the banner to stderr.
  return input.mode === "tui" ? input.stdoutTTY : input.stderrTTY;
}
export function terminalCapabilities(input: {
  env: Env;
  columns: number;
  tty: boolean;
}): TerminalCapabilities {
  const { env } = input;
  const dumb = env.TERM === "dumb";
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return {
    color: input.tty && !dumb && env.NO_COLOR === undefined,
    unicode: !dumb && !/^(C|POSIX)(\.|$)/i.test(locale),
    columns: input.columns > 0 ? input.columns : 80,
    interactive: input.tty,
  };
}

interface AppLike {
  workspace: string;
  config: { provider: { baseURL: string } };
  provider: { model: string };
  providerInfo?: {
    id: string;
    profile: Record<string, string | number | boolean>;
    persisted: boolean;
  };
  plugins: Parameters<typeof import("@alisio/core").renderStartup>[0] & {
    builtins: Set<string>;
  };
  runner: { policy: { write: boolean; process: boolean }; approvals: boolean };
}
/** Startup input from an application: provider host only, never keys or full URLs. */
export function startupInput(
  app: AppLike,
  options: { version: string; model?: string; readOnly?: boolean; terminal: TerminalCapabilities },
): StartupInput {
  let host = "unknown";
  try {
    host = new URL(String(app.providerInfo?.profile.baseURL ?? app.config.provider.baseURL)).host;
  } catch {
    /* keep unknown */
  }
  const state = (on: boolean) => (on ? "on" : app.runner.approvals ? "ask" : "off");
  let user: string | undefined;
  try {
    user = userInfo().username;
  } catch {
    user = undefined;
  }
  return {
    version: options.version,
    cwd: app.workspace,
    home: homedir(),
    model: options.model ?? app.provider.model,
    provider: host,
    ...(user ? { userName: user } : {}),
    terminal: options.terminal,
    facts: [
      {
        label: "access",
        value: options.readOnly
          ? "read-only"
          : `write:${state(app.runner.policy.write)} process:${state(app.runner.policy.process)}`,
      },
      { label: "memory", value: app.plugins.builtins.has("memory") ? "on" : "off" },
      ...(!(options.model ?? app.provider.model)
        ? [{ label: "model", value: "⚠ not configured — use /connect" }]
        : (options.model ?? app.provider.model) === "YOUR_MODEL_ID"
          ? [{ label: "model", value: "⚠ placeholder — edit .alisio/config.json" }]
          : []),
    ],
  };
}
export type { StartupResult };
