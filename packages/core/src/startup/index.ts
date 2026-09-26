/**
 * Startup pipeline: resolve the startup-screen and mascot providers from the extension
 * registry, validate their output, and fall back to the defaults (with a diagnostic) when a
 * provider throws, returns garbage or is too slow. Never throws.
 */
import type {
  MascotContext,
  MascotProvider,
  PluginMetadata,
  StartupContext,
  StartupFact,
  StartupScreenProvider,
  TerminalCapabilities,
} from "@alisio/sdk";
import type { ExtensionConflict, ExtensionRegistry } from "../extensions/registry.ts";
import { DefaultAlisioMascot } from "./mascot.ts";
import { DefaultStartupScreen, shortenPath, startupTips } from "./screen.ts";
import { sanitizeLine, truncate } from "./text.ts";

export { DefaultAlisioMascot } from "./mascot.ts";
export {
  composeSideBySide,
  DefaultStartupScreen,
  infoSection,
  mascotSection,
  pluginsSection,
  shortenPath,
  startupTips,
  tipsSection,
  titleSection,
  welcomeSection,
} from "./screen.ts";
export { padEnd, sanitizeLine, stripAnsi, truncate, visibleWidth } from "./text.ts";

export type StartupDiagnostic =
  | ({ type: "extension_conflict" } & ExtensionConflict)
  | { type: "plugin_hook_failed"; source: string; hook: string; error: string };
export interface StartupInput {
  version: string;
  cwd: string;
  /** Home directory used to shorten the working directory as `~/…`. */
  home?: string;
  model?: string;
  provider?: string;
  userName?: string;
  terminal?: TerminalCapabilities;
  facts?: StartupFact[];
  tipSeed?: number;
}
export interface StartupResult {
  lines: string[];
  screen: string;
  mascot: string;
  diagnostics: StartupDiagnostic[];
}
interface Source {
  extensions: ExtensionRegistry;
  metadata(): PluginMetadata[];
}
const MAX_LINES = 60;
/** Synchronous providers cannot be preempted; output slower than this is discarded. */
const SLOW_MS = 250;
const DEFAULT_TERMINAL: TerminalCapabilities = {
  color: false,
  unicode: true,
  columns: 80,
  interactive: false,
};

function validate(output: unknown, terminal: TerminalCapabilities, maxLines: number): string[] {
  const lines = typeof output === "string" ? output.split("\n") : output;
  if (!Array.isArray(lines) || !lines.every((l) => typeof l === "string"))
    throw new Error("render must return a string or an array of strings");
  if (lines.length > maxLines) throw new Error(`render returned more than ${maxLines} lines`);
  return lines
    .flatMap((l) => l.split("\n"))
    .map((l) => truncate(sanitizeLine(l, terminal), terminal.columns));
}
function timed<T>(fn: () => T): T {
  const started = Date.now();
  const value = fn();
  if (Date.now() - started > SLOW_MS) throw new Error(`render took longer than ${SLOW_MS}ms`);
  return value;
}

export function renderStartup(source: Source, input: StartupInput): StartupResult {
  const terminal = input.terminal ?? DEFAULT_TERMINAL;
  const diagnostics: StartupDiagnostic[] = [];
  for (const conflict of [
    ...source.extensions.conflicts("mascot"),
    ...source.extensions.conflicts("startup-screen"),
  ])
    diagnostics.push({ type: "extension_conflict", ...conflict });
  const fail = (plugin: string, hook: string, error: unknown) =>
    diagnostics.push({
      type: "plugin_hook_failed",
      source: plugin,
      hook,
      error: error instanceof Error ? error.message : String(error),
    });

  // Mascot: validate once at the requested terminal; a failing provider is replaced.
  let mascotId = DefaultAlisioMascot.id;
  let mascotProvider: MascotProvider = DefaultAlisioMascot;
  const chosenMascot = source.extensions.resolve("mascot");
  if (chosenMascot) {
    try {
      timed(() =>
        validate(chosenMascot.provider.render({ terminal, version: input.version }), terminal, 12),
      );
      mascotProvider = chosenMascot.provider;
      mascotId = chosenMascot.provider.id;
    } catch (error) {
      fail(chosenMascot.plugin, "mascot.render", error);
    }
  }
  // The mascot handed to screens is always safe to call.
  const safeMascot: MascotProvider = {
    id: mascotId,
    render(ctx: MascotContext) {
      try {
        return validate(mascotProvider.render(ctx), ctx.terminal, 12);
      } catch {
        return validate(DefaultAlisioMascot.render(ctx), ctx.terminal, 12);
      }
    },
  };
  const context: StartupContext = {
    version: input.version,
    cwd: shortenPath(input.cwd, Math.max(10, terminal.columns - 14), input.home),
    ...(input.model ? { model: input.model } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.userName ? { userName: input.userName } : {}),
    terminal,
    plugins: source.metadata(),
    mascot: safeMascot,
    tips: startupTips(input.tipSeed ?? Math.floor(Date.now() / 86_400_000)),
    ...(input.facts ? { facts: input.facts } : {}),
  };
  const render = (screen: StartupScreenProvider) =>
    timed(() => validate(screen.render(context), terminal, MAX_LINES));
  const chosenScreen = source.extensions.resolve("startup-screen");
  if (chosenScreen)
    try {
      return {
        lines: render(chosenScreen.provider),
        screen: chosenScreen.provider.id,
        mascot: mascotId,
        diagnostics,
      };
    } catch (error) {
      fail(chosenScreen.plugin, "startup-screen.render", error);
    }
  return {
    lines: render(DefaultStartupScreen),
    screen: DefaultStartupScreen.id,
    mascot: mascotId,
    diagnostics,
  };
}
