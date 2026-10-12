/**
 * The JavaScript topics of `forge_guide` (spec §8.3): `js.api`, `js.patterns` and `js.tools`. Pure
 * functions of the engine's live state (effective limits, host) and, for `js.tools`, of the tools
 * a script can call right now. No I/O here; the provider gathers the state.
 */
import type { IsolationLevel } from "@alisio/sdk";
import type { ForgeLimits } from "../limits.ts";

/** What the guide needs to know about the running JavaScript engine. */
export interface JavascriptGuideState {
  /** Engine build, e.g. `quickjs-wasi@3.6.2`. */
  version: string;
  isolation: IsolationLevel;
  host: "worker" | "process";
  limits: ForgeLimits;
}

/** One line of the permission-filtered catalog summary. */
export interface CatalogSummaryEntry {
  name: string;
  effect: string;
}

/** The most entries `js.tools` lists (spec §8.3). */
export const TOOLS_GUIDE_MAX_ENTRIES = 40;

const KiB = 1024;
const MiB = 1024 * KiB;

const size = (bytes: number): string =>
  bytes >= MiB && bytes % MiB === 0
    ? `${bytes / MiB} MiB`
    : bytes >= KiB
      ? `${Math.round(bytes / KiB)} KiB`
      : `${bytes} B`;

const seconds = (ms: number): string => `${Math.round((ms / 1000) * 10) / 10} s`;

export function jsApiGuide(state: JavascriptGuideState): string {
  const l = state.limits;
  const where =
    state.host === "worker" ? "a worker thread of this process" : "a child process of this program";
  return [
    `# js_run API (${state.version})`,
    "",
    `Isolation: ${state.isolation}. A fresh VM per run, hosted in ${where}. No imports, require, network, files, timers or WebAssembly. The body is an async function: use await and \`return\` a small JSON value.`,
    "",
    "## Globals",
    "- `tools.call(name, input?)`: call another tool; resolves to its JSON result (or its text), rejects with an error that has `code` and `message`. `callTool` is the same.",
    "- `catalog.search(query, {limit?})`: `[{name, effect, summary}]`. `catalog.describe(name)`: `{name, effect, description, inputSchema}`. Call it before using a tool you do not know.",
    "- `state.get(key)`, `state.set(key, value)`, `state.delete(key)`: small JSON kept for later runs of this session; committed only if the run succeeds.",
    "- `text(value)`: explicit output for the model. `progress({message, completed?, total?})`: live progress. `console.log/warn/error` go to the output too.",
    "- `parallel.map(items, fn, {concurrency?})`: results in input order; no new item starts after the first failure and it rejects with that error. `parallel.settle(...)`: every result as `{ok:true,value}` or `{ok:false,error:{code,message}}`.",
    "",
    "## Effective limits now",
    `- Time ${seconds(l.timeoutMs)} per run (\`timeoutMs\` can only lower it); heap ${size(l.memoryBytes)}; stack ${size(l.stackBytes)}; source ${size(l.maxSourceBytes)}.`,
    `- Nested calls: ${l.maxToolCalls} per run, ${l.maxConcurrency} at once (\`Promise.all\` does not avoid this); input ${size(l.maxCallInputBytes)}, response ${size(l.maxCallResponseBytes)} each.`,
    `- Returned to you: at most ${l.maxOutputChars} characters (\`OUTPUT_LIMIT\` beyond that); retained output ${size(l.maxRetainedOutputBytes)}.`,
    "",
    "## Permissions",
    "Nested calls pass the same gate as a direct call of this session and never open an approval: a tool that needs one fails with `APPROVAL_REQUIRED`; call it directly instead. `js.tools` lists what is callable now.",
    "",
    "## Errors you can catch",
    "`TOOL_UNAVAILABLE`, `TOOL_INPUT_INVALID`, `TOOL_FAILED`, `PERMISSION_DENIED`, `APPROVAL_REQUIRED`, `BUDGET_EXCEEDED`, `OUTPUT_LIMIT`. Anything else a script throws is `SCRIPT_RUNTIME`.",
  ].join("\n");
}

export function jsPatternsGuide(state: JavascriptGuideState): string {
  const l = state.limits;
  return [
    "# js_run patterns",
    "",
    "## #filtering",
    `Filter, aggregate or count INSIDE the script and return the result, not the data: the model sees at most ${l.maxOutputChars} characters.`,
    "```js",
    'const rows = await tools.call("<tool>", { /* input */ });  // check the shape with catalog.describe',
    "const big = rows.filter((r) => r.size > 1000);",
    "return { total: rows.length, big: big.length, sample: big.slice(0, 5) };",
    "```",
    "",
    "## #parallel",
    `Use \`parallel.map(items, fn, {concurrency: 4})\` for independent reads: up to ${l.maxConcurrency} run at once, ${l.maxToolCalls} in total. It stops at the first failure. Use \`parallel.settle\` when partial results are fine and report the failed ones.`,
    "```js",
    'const results = await parallel.settle(paths, (p) => tools.call("read_file", { path: p, limit: 50 }));',
    "return results.map((r, i) => (r.ok ? { path: paths[i], ok: true } : { path: paths[i], error: r.error.code }));",
    "```",
    "",
    "## #pagination",
    "Loop until the tool says there is no more, and keep only what you need from each page. Count calls: the budget is shared by the whole run.",
    "",
    "## #state",
    "`state.set('cursor', value)` survives to the next run, but only when this run succeeds. Keep it small JSON; large data belongs in a scratchpad file.",
    "",
    "## #files",
    "Scripts cannot touch files. To keep a long script, write it to the scratchpad with the file tools and run it with `js_run` `codePath` (a .js file); edit it between runs instead of resending the code. Intermediate results go to scratchpad files the same way.",
    "",
    "## #errors",
    "Wrap risky calls in try/catch and return `{ error: e.code }`. A script that throws ends the run; one that returns a value is a success even if some calls failed (check `calls` in the result).",
  ].join("\n");
}

export function jsToolsGuide(catalog: readonly CatalogSummaryEntry[] | undefined): string {
  const head = ["# Tools a script can call now", ""];
  if (!catalog)
    return [
      ...head,
      "The tool list depends on the live session and is not available here. Inside a script, `await catalog.search('')` lists what is callable and `await catalog.describe(name)` gives the schema.",
    ].join("\n");
  const sorted = [...catalog].sort((a, b) => a.name.localeCompare(b.name));
  const shown = sorted.slice(0, TOOLS_GUIDE_MAX_ENTRIES);
  const more = sorted.length - shown.length;
  return [
    ...head,
    `Only tools this session's permissions allow without asking are listed (${sorted.length}). Others fail with \`APPROVAL_REQUIRED\` or \`PERMISSION_DENIED\`; call those directly.`,
    "",
    ...shown.map((tool) => `- ${tool.name} (${tool.effect})`),
    ...(more > 0 ? [`- ... and ${more} more: use \`catalog.search(query)\``] : []),
    "",
    "Details and input schemas: `await catalog.describe(name)` inside the script. Never reachable from a script: `js_run`, `forge_guide`, `task`, `task_wait`, `send_message`, `ask_user_question`. `python_run` only when this run allows analysis or process effects.",
  ].join("\n");
}
