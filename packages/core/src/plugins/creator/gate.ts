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
 * 3. for every plugin app: load its page once (it must be a non-empty string within the frame
 *    limit whose inline scripts carry the nonce marker, with no inline event handlers and no
 *    outside script or stylesheet, which the frame's CSP would block) and call every action once
 *    through the host's own app-action path with a minimal schema-valid input (`process` actions
 *    are skipped like such tools): a throw, a timeout or data that is not JSON fails;
 * 4. dispose (close the host; its apps must be gone), then activate again on a fresh host and
 *    dispose again.
 *
 * The child still runs with the user's privileges and may reach the network: NOT a sandbox.
 */
import { PLUGIN_APP_LIMITS, type Plugin, type ToolDefinition } from "@alisio/sdk";
import { ToolRegistry } from "../../core/registry.ts";
import { ProofVerifierRegistry } from "../../proof/plugin-verifiers.ts";
import { ProviderRegistry } from "../../providers/registry.ts";
import { PluginAppError } from "../apps.ts";
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
  /** App ids the plugin registered, with their action names (absent from older gate children). */
  apps?: Array<{ id: string; actions: string[] }>;
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

const NONCE_MARKER = "__ALISIO_NONCE__";
/** `type` values of a `<script>` the browser runs (anything else is a data block). */
const SCRIPT_TYPES = new Set(["", "module", "text/javascript", "application/javascript"]);

const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : undefined;
};

/**
 * What the app frame's CSP (`script-src 'nonce-…'`, `style-src 'unsafe-inline'`, no network)
 * would block in `html`: one message per kind of problem. Static and conservative: it reads tags,
 * it does not run the page.
 */
export function appPageProblems(html: string): Array<{ code: string; message: string }> {
  const problems: Array<{ code: string; message: string }> = [];
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[0]);
  const code = scripts.filter((tag) =>
    SCRIPT_TYPES.has((attribute(tag, "type") ?? "").trim().toLowerCase()),
  );
  if (code.some((tag) => attribute(tag, "nonce") !== NONCE_MARKER))
    problems.push({
      code: "app_script_nonce_missing",
      message: `a <script> without nonce="${NONCE_MARKER}", which the app frame does not run`,
    });
  const outside = (url: string | undefined) => url !== undefined && !/^\s*(data|blob):/i.test(url);
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  if (
    code.some((tag) => attribute(tag, "src") !== undefined) ||
    links.some(
      (tag) => /stylesheet/i.test(attribute(tag, "rel") ?? "") && outside(attribute(tag, "href")),
    )
  )
    problems.push({
      code: "app_external_resource",
      message:
        "a script or stylesheet loaded from a file or address; the page must be self-contained (inline <script> and <style>)",
    });
  // Inline handlers (onclick=...) and javascript: URLs never run under a nonce CSP.
  const markup = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  if (
    /<[a-z][^>]*\son[a-z]+\s*=/i.test(markup) ||
    /<[a-z][^>]*=\s*["']?\s*javascript:/i.test(markup)
  )
    problems.push({
      code: "app_inline_handler",
      message:
        "an inline event handler (onclick=...) or javascript: link, which the app frame blocks; use addEventListener in a nonce script",
    });
  return problems;
}

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
  const apps = await checkApps(first.host, plugin.id, request, callMs, issues);
  try {
    await first.host.close();
  } catch (error) {
    const inner = error instanceof AggregateError ? error.errors[0] : error;
    issues.push({ code: "dispose_failed", message: reason(inner) });
  }
  if (first.host.apps.appsOf(plugin.id).length)
    issues.push({
      code: "app_dispose_failed",
      message: "An app was still registered after the plugin was closed",
    });
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
    apps,
    ...(typeof plugin.name === "string" && plugin.name.trim() ? { name: plugin.name.trim() } : {}),
  };
}

/** Gate step 3 (see the module comment): every app's page and every app action, once. */
async function checkApps(
  host: PluginHost,
  pluginId: string,
  request: GateRequest,
  callMs: number,
  issues: GateIssue[],
): Promise<Array<{ id: string; actions: string[] }>> {
  const out: Array<{ id: string; actions: string[] }> = [];
  for (const info of host.apps.appsOf(pluginId)) {
    const app = info.id;
    const definition = host.apps.definition(pluginId, app);
    const actions = Object.entries(definition?.actions ?? {});
    out.push({ id: app, actions: actions.map(([name]) => name) });
    let html: string | undefined;
    try {
      html = await withTimeout(callMs, `The page of the app ${app}`, () =>
        host.apps.html(pluginId, app),
      );
    } catch (error) {
      const cause = (error as { cause?: unknown }).cause ?? error;
      issues.push({
        code: "app_html_failed",
        message: `The page of the app ${app} could not be loaded: ${reason(cause)}`,
      });
    }
    if (html !== undefined && !html.trim())
      issues.push({ code: "app_html_failed", message: `The page of the app ${app} is empty` });
    else if (html !== undefined && Buffer.byteLength(html) > PLUGIN_APP_LIMITS.htmlBytes)
      issues.push({
        code: "app_html_too_large",
        message: `The page of the app ${app} is larger than ${PLUGIN_APP_LIMITS.htmlBytes / 1024 / 1024} MiB`,
      });
    else if (html !== undefined)
      for (const problem of appPageProblems(html))
        issues.push({
          code: problem.code,
          message: `The page of the app ${app} has ${problem.message}`,
        });
    for (const [name, action] of actions) {
      if (action.effect === "process") continue;
      const input = sampleInput(action.inputSchema) ?? {};
      const label = `The action ${name} of the app ${app}`;
      try {
        const result = await withTimeout(callMs, label, () =>
          host.apps.run(
            pluginId,
            app,
            name,
            input,
            { sessionId: "plugin-gate", workspace: request.workspace },
            // The person would approve writes; the gate runs on throwaway state.
            { policy: { write: true, process: false, external: false }, timeoutMs: callMs },
          ),
        );
        JSON.stringify(result ?? null);
      } catch (error) {
        // No minimal input fits the schema (a pattern or a format): only the tests judge it.
        if (error instanceof PluginAppError && error.code === "invalid_input") continue;
        const cause =
          error instanceof PluginAppError && error.code !== "timeout"
            ? (error.cause ?? error)
            : error;
        issues.push({
          code: "app_action_failed",
          message:
            error instanceof TypeError && /serialize|BigInt|circular/i.test(error.message)
              ? `${label} did not return JSON data: ${reason(error)}`
              : `${label} failed: ${reason(cause)}`,
        });
      }
    }
  }
  return out;
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
