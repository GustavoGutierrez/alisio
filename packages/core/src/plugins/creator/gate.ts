/**
 * Child side of the creator's delivery gate. It runs in its own process with throwaway config,
 * state and home directories (see `gate-runner.ts`) and checks an INSTALLED copy of a plugin
 * package with the real host, the way Alisio loads it at startup:
 *
 * 1. resolve the package from a plugins root (`node_modules/<name>`, its real `exports`), import
 *    it and activate it with a real `PluginHost` and `ToolRegistry` (strict Ajv, name rules,
 *    duplicates, view schemas);
 * 2. call every tool once with a minimal schema-valid input (tools whose effect reaches programs
 *    or the network are skipped), bounded in time: a throw or a value that is not a tool result
 *    fails, a returned `isError` result is a handled answer and passes;
 * 3. dispose (close the host), then activate again on a fresh host and dispose again.
 *
 * The child still runs with the user's privileges and may reach the network: NOT a sandbox.
 */
import type { Plugin, ToolDefinition } from "@alisio/sdk";
import { ToolRegistry } from "../../core/registry.ts";
import { ProofVerifierRegistry } from "../../proof/plugin-verifiers.ts";
import { ProviderRegistry } from "../../providers/registry.ts";
import { sanitizePluginDiagnostic } from "../diagnostic.ts";
import { PluginHost, pluginPrefix } from "../host.ts";
import { sampleInput } from "./schema-sample.ts";

export interface GateRequest {
  /** npm name of the installed package. */
  packageName: string;
  /** Root holding `node_modules/<packageName>` (a throwaway copy of `<config home>/plugins`). */
  pluginsRoot: string;
  /** Throwaway state root for `api.paths`. */
  stateRoot: string;
  configHome: string;
  /** Working directory handed to tool calls. */
  workspace: string;
  /** Per smoke call (default 5 s). */
  callTimeoutMs?: number;
}

export interface GateIssue {
  code: string;
  message: string;
}

export interface GateReport {
  ok: boolean;
  issues: GateIssue[];
  /** Tool names as the plugin registered them (without the host prefix). */
  tools: string[];
  /** The plugin's declared display name, when it has one. */
  name?: string;
}

export const GATE_MARKER = "@@ALISIO_GATE@@";
/** Printed first by a working gate child: without it the runtime could not run the gate at all. */
export const GATE_READY_MARKER = "@@ALISIO_GATE_READY@@";
const SKIPPED_EFFECTS = new Set(["process", "external", undefined]);

const reason = (error: unknown) =>
  sanitizePluginDiagnostic(error instanceof Error ? error.message : String(error));

function withTimeout<T>(ms: number, what: string, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    run(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took too long (${ms} ms)`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const isToolResult = (value: unknown): boolean =>
  !!value &&
  typeof value === "object" &&
  Array.isArray((value as { content?: unknown }).content) &&
  (value as { content: unknown[] }).content.every(
    (part) =>
      !!part && typeof part === "object" && typeof (part as { type?: unknown }).type === "string",
  );

function newHost(request: GateRequest): { host: PluginHost; registry: ToolRegistry } {
  const registry = new ToolRegistry();
  const state = new Map<string, unknown>();
  const host = new PluginHost(
    registry,
    {
      getState: (plugin, key) => state.get(`${plugin}\0${key}`),
      setState: (plugin, key, value) => void state.set(`${plugin}\0${key}`, value),
    },
    { disposeTimeoutMs: 5_000 },
    new ProviderRegistry(),
  );
  host.setProofVerifiers(new ProofVerifierRegistry());
  host.setPluginEnvironment({
    stateRoot: request.stateRoot,
    configHome: request.configHome,
    options: () => ({}),
  });
  return { host, registry };
}

/** Runs the whole gate; never throws (every failure is an issue). */
export async function checkInstalledPlugin(request: GateRequest): Promise<GateReport> {
  const issues: GateIssue[] = [];
  const tools: string[] = [];
  const callMs = request.callTimeoutMs ?? 5_000;
  let plugin: Plugin;
  let base: string;
  const first = newHost(request);
  try {
    ({ plugin, base } = await first.host.inspect(request.packageName, {
      from: request.workspace,
      globalRoots: [request.pluginsRoot],
    }));
    await first.host.activate(plugin, base);
  } catch (error) {
    return { ok: false, issues: [{ code: "activation_failed", message: reason(error) }], tools };
  }
  const prefix = `${pluginPrefix(plugin.id)}_`;
  for (const definition of first.registry.list() as ToolDefinition[]) {
    const name = definition.name.startsWith(prefix)
      ? definition.name.slice(prefix.length)
      : definition.name;
    tools.push(name);
    if (SKIPPED_EFFECTS.has(definition.effect)) continue;
    let input: Record<string, unknown>;
    try {
      input = first.registry.parse(
        definition.name,
        JSON.stringify(sampleInput(definition.inputSchema) ?? {}),
      );
    } catch {
      // No minimal input fits the schema (a pattern or a format): only the tests judge this tool.
      continue;
    }
    try {
      const result = await withTimeout(callMs, `The tool ${name}`, () =>
        Promise.resolve(
          definition.execute(input, {
            signal: AbortSignal.timeout(callMs),
            workspace: request.workspace,
            emit: () => {},
          }),
        ),
      );
      if (!isToolResult(result))
        issues.push({
          code: "tool_smoke_failed",
          message: `The tool ${name} did not return a tool result ({ content: [...] })`,
        });
    } catch (error) {
      issues.push({
        code: "tool_smoke_failed",
        message: `The tool ${name} failed: ${reason(error)}`,
      });
    }
  }
  try {
    await first.host.close();
  } catch (error) {
    const inner = error instanceof AggregateError ? error.errors[0] : error;
    issues.push({ code: "dispose_failed", message: reason(inner) });
  }
  const second = newHost(request);
  try {
    await withTimeout(callMs * 2, "The second activation", () =>
      second.host.activate(plugin, base),
    );
    await second.host.close().catch(() => {});
  } catch (error) {
    issues.push({ code: "reactivate_failed", message: reason(error) });
  }
  return {
    ok: issues.length === 0,
    issues,
    tools,
    ...(typeof plugin.name === "string" && plugin.name.trim() ? { name: plugin.name.trim() } : {}),
  };
}

/**
 * Body of the gate child process: reads the request (last argv item, JSON), refuses to run
 * without `ALISIO_PLUGIN_GATE=1` (set only by the gate runner), prints one marked report line
 * and exits, whatever the plugin left running.
 */
export async function runPluginGateChild(
  argv: string[] = process.argv,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (env.ALISIO_PLUGIN_GATE !== "1") {
    process.stderr.write("__plugin-gate is internal and is started by the plugin creator\n");
    process.exit(2);
  }
  // The handshake comes before any plugin code runs: what fails after it is the plugin's doing.
  await new Promise<void>((resolve) =>
    process.stdout.write(`${GATE_READY_MARKER}\n`, () => resolve()),
  );
  let report: GateReport;
  try {
    report = await checkInstalledPlugin(JSON.parse(argv.at(-1) ?? "{}") as GateRequest);
  } catch (error) {
    report = {
      ok: false,
      issues: [{ code: "activation_failed", message: reason(error) }],
      tools: [],
    };
  }
  process.stdout.write(`\n${GATE_MARKER}${JSON.stringify(report)}\n`, () => process.exit(0));
}
