/**
 * Parent side of the creator's delivery gate (see `gate.ts`): extracts the built `.tgz` into a
 * throwaway plugins root (the installed layout, no npm, no network), then runs the gate in a child
 * process of the SAME runtime that loads plugins (this executable; the compiled binary re-runs
 * itself with the hidden `__plugin-gate` command) with throwaway HOME, config and state homes and
 * none of the parent's environment beyond PATH and locale. Bounded in time and output.
 * The child runs the plugin with the user's privileges and may reach the network: NOT a sandbox.
 */
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isBunCompiled } from "../../forge/javascript/hosts/process-host.ts";
import { isMissingCommand, runProcess } from "../../runtime/process.ts";
import { sanitizePluginDiagnostic } from "../diagnostic.ts";
import { extractPluginTarball } from "../tarball.ts";
import { GATE_MARKER, GATE_READY_MARKER, type GateReport, type GateRequest } from "./gate.ts";

export const GATE_TIMEOUT_MS = 30_000;
const PASSED = ["PATH", "SystemRoot", "COMSPEC", "LANG", "PATHEXT", "WINDIR"];

/** The child's whole environment: PATH/locale, throwaway homes under `root`, the gate marker. */
export function gateEnvironment(
  root: string,
  extra: Record<string, string>,
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSED) {
    const value = parent[key];
    if (value) env[key] = value;
  }
  const home = join(root, "home");
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: home,
    TEMP: home,
    TMP: home,
    ALISIO_CONFIG_HOME: join(root, "config"),
    ALISIO_STATE_HOME: join(root, "state"),
    ALISIO_PLUGIN_GATE: "1",
    NO_COLOR: "1",
    ...extra,
  };
}

export interface GateCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** The entry file the runtime runs (absent for the compiled binary's hidden command). */
  entry?: string;
}

/** How to start the gate child from this process (see the module comment). */
export function gateCommand(
  options: { compiled?: boolean; electron?: boolean; base?: string; execPath?: string } = {},
): GateCommand {
  const command = options.execPath ?? process.execPath;
  // The desktop host is the Electron binary acting as Node; its children need the same flag.
  const env: Record<string, string> =
    (options.electron ?? !!process.versions.electron) ? { ELECTRON_RUN_AS_NODE: "1" } : {};
  if (options.compiled ?? isBunCompiled()) return { command, args: ["__plugin-gate"], env: {} };
  const base = options.base ?? import.meta.url;
  const typescript = base.endsWith(".ts");
  const entry = fileURLToPath(new URL(`./gate-entry.${typescript ? "ts" : "js"}`, base));
  // From source under Node (tests): the core uses non-erasable TypeScript and source exports.
  const flags =
    typescript && !process.versions.bun
      ? [
          "--experimental-transform-types",
          "--conditions=alisio-source",
          "--disable-warning=ExperimentalWarning",
        ]
      : [];
  return { command, args: [...flags, entry], env, entry };
}

export interface InstalledGateResult extends GateReport {
  /** Files the package ships (paths inside the package). */
  packaged: string[];
}

/** Installs `tarball` into a throwaway root and runs the gate on that copy. Never throws. */
export async function runInstalledGate(
  tarball: string,
  packageName: string,
  options: { timeoutMs?: number; command?: GateCommand } = {},
): Promise<InstalledGateResult> {
  const root = await mkdtemp(join(tmpdir(), "alisio-gate-"));
  const fail = (message: string, code = "activation_failed"): InstalledGateResult => ({
    ok: false,
    issues: [{ code, message: sanitizePluginDiagnostic(message) }],
    tools: [],
    packaged: [],
  });
  // The check itself could not run here: the build fails closed, never passes unchecked.
  const unavailable = (why: string) =>
    fail(
      `Alisio could not run its plugin check in this installation (${why}), so the plugin cannot be delivered`,
      "gate_unavailable",
    );
  try {
    const pluginsRoot = join(root, "config", "plugins");
    let packaged: string[];
    try {
      packaged = await extractPluginTarball(
        tarball,
        join(pluginsRoot, "node_modules", packageName),
      );
    } catch (error) {
      return fail(`The package could not be unpacked: ${(error as Error).message}`);
    }
    const work = join(root, "work");
    await mkdir(work, { recursive: true });
    await mkdir(join(root, "home"), { recursive: true });
    const request: GateRequest = {
      packageName,
      pluginsRoot,
      stateRoot: join(root, "state"),
      configHome: join(root, "config"),
      workspace: work,
    };
    const command = options.command ?? gateCommand();
    if (
      command.entry &&
      !(await access(command.entry).then(
        () => true,
        () => false,
      ))
    )
      return unavailable("its check program is missing");
    const timeoutMs = options.timeoutMs ?? GATE_TIMEOUT_MS;
    const timer = AbortSignal.timeout(timeoutMs);
    let stdout = "";
    try {
      const result = await runProcess(command.command, [...command.args, JSON.stringify(request)], {
        cwd: work,
        signal: timer,
        timeoutMs: timeoutMs + 1_000,
        env: gateEnvironment(root, command.env),
        maxBytes: 256_000,
        onOverflow: "truncate",
        killGraceMs: 1_000,
        // Kept live: a run stopped at the deadline still shows whether the handshake came.
        onData: (chunk, stream) => {
          if (stream === "stdout" && stdout.length < 256_000) stdout += chunk;
        },
      });
      stdout = result.stdout || stdout;
    } catch (error) {
      if (timer.aborted && stdout.includes(GATE_READY_MARKER))
        return fail(`Starting the plugin took too long (${timeoutMs} ms)`);
      return unavailable(
        isMissingCommand(error) ? "its runtime was not found" : "it did not start",
      );
    }
    if (!stdout.split("\n").some((l) => l.trim() === GATE_READY_MARKER))
      return unavailable(timer.aborted ? "it did not answer in time" : "it did not start");
    const line = stdout
      .split("\n")
      .reverse()
      .find((l) => l.startsWith(GATE_MARKER));
    if (!line)
      return fail(
        timer.aborted
          ? `Starting the plugin took too long (${timeoutMs} ms)`
          : "The plugin stopped Alisio's check before it finished",
      );
    const report = JSON.parse(line.slice(GATE_MARKER.length)) as GateReport;
    return { ...report, packaged };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
