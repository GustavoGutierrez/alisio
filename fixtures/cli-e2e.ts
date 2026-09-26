/**
 * End-to-end CLI check against a local OpenAI-compatible fake server.
 * `node` mode runs packages/cli/dist/main.js with plain Node; `binary` runs dist/alisio (Bun).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "./http.ts";

const mode = process.argv[2] === "binary" ? "binary" : "node";
const directory = await mkdtemp(join(tmpdir(), `alisio-${mode}-`));
const command =
  mode === "binary"
    ? [resolve(process.platform === "win32" ? "dist/alisio.exe" : "dist/alisio")]
    : [process.execPath, resolve("packages/cli/dist/main.js")];
let requests = 0;
const firstUserMessages: string[] = [];
const server = await serve(async (req) => {
  const body = (await req.json()) as { messages: Array<{ role: string; content?: string }> };
  requests++;
  firstUserMessages.push(String(body.messages.find((m) => m.role === "user")?.content ?? ""));
  // Stateless: answer after the tool result, otherwise request the tool.
  const answered = body.messages.some((m) => m.role === "tool");
  const choice = !answered
    ? {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "c1",
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: "note.txt" }) },
            },
          ],
        },
        finish_reason: "tool_calls",
      }
    : { delta: { content: "Verified fixture content" }, finish_reason: "stop" };
  if (answered) assert.match(JSON.stringify(body.messages), /fixture content/);
  return new Response(
    `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, ...choice }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
});
const execute = async (args: string[], checkStderr = false, expectCode = 0) => {
  const [program = "", ...prefix] = command;
  const child = spawn(program, [...prefix, ...args], {
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ALISIO_CONFIG_HOME: join(directory, "global"),
      ALISIO_STATE_HOME: join(directory, "state"),
      ALISIO_MODEL: "",
      OPENAI_BASE_URL: "",
      ALISIO_API_MODE: "",
      HERDR_ENV: "0",
    },
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const code = await new Promise<number>((done) => child.on("close", (c) => done(c ?? 1)));
  assert.equal(code, expectCode, stderr);
  if (expectCode) return stderr;
  // node:sqlite's ExperimentalWarning must be silenced; other diagnostics are allowed.
  assert.doesNotMatch(stderr, /ExperimentalWarning/);
  if (checkStderr) assert.doesNotMatch(stderr, /MASCOT-MARKER|SCREEN-MARKER|Alisio v/);
  return stdout;
};
try {
  await writeFile(join(directory, "note.txt"), "fixture content");
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      provider: {
        baseURL: `http://127.0.0.1:${server.port}/v1`,
        model: "test",
        auth: "none",
        apiMode: "chat",
      },
    }),
  );
  const mcpConfig = join(directory, "mcp-config.json");
  await writeFile(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        devforge: {
          command: process.execPath,
          args: [
            "--experimental-strip-types",
            "--disable-warning=ExperimentalWarning",
            resolve("fixtures/mcp-server.ts"),
          ],
          env: { DEV_FORGE_CONFIG: "/fixture/not-a-real-credential.json" },
        },
      },
    }),
  );
  assert.deepEqual(JSON.parse(await execute(["mcp", "list", "--config", mcpConfig])), ["devforge"]);
  const mcpDoctor = await execute([
    "mcp",
    "doctor",
    "devforge",
    "--config",
    mcpConfig,
    "--allow-mcp",
  ]);
  assert.equal(JSON.parse(mcpDoctor).length, 2);
  assert.doesNotMatch(mcpDoctor, /not-a-real-credential/);
  const stdout = await execute([
    "run",
    "Read note.txt",
    "--cwd",
    directory,
    "--config",
    join(directory, "config.json"),
    "--json",
  ]);
  const events = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "run_completed");
  assert.ok(events.some((e) => e.type === "tool_completed"));
  assert.equal(requests, 2);
  // JSONL must not change when a plugin registers a mascot (ids/timestamps/durations aside).
  await writeFile(
    join(directory, "mascot.mjs"),
    'export default {id:"mascot-test",version:"1.0.0",apiVersion:1,extensions:{mascot:{id:"m",render:()=>["MASCOT-MARKER"]}},setup(api){api.extensions.register("startup-screen",{id:"s",render:()=>["SCREEN-MARKER"]},{priority:5})}}',
  );
  const normalize = (text: string) =>
    text
      .trim()
      .split("\n")
      .map((line) => {
        const { runId: _r, sessionId: _s, timestamp: _t, ...event } = JSON.parse(line);
        if (event.data && typeof event.data === "object") delete event.data.durationMs;
        return event;
      });
  const baseArgs = [
    "run",
    "Read note.txt",
    "--cwd",
    directory,
    "--config",
    join(directory, "config.json"),
    "--json",
  ];
  const plain = await execute(baseArgs, true);
  const withMascot = await execute([...baseArgs, "--plugin", join(directory, "mascot.mjs")], true);
  assert.deepEqual(normalize(withMascot), normalize(plain));
  assert.doesNotMatch(plain + withMascot, /MASCOT-MARKER|SCREEN-MARKER|Alisio v/);
  const quiet = await execute([...baseArgs.slice(0, -1), "--quiet", "--no-banner"], true);
  assert.doesNotMatch(quiet, /MASCOT-MARKER|Alisio v/);

  // Bun (binary) loads TypeScript plugins directly; Node plugins ship JavaScript.
  const ext = mode === "binary" ? "ts" : "mjs";
  await writeFile(join(directory, `helper.${ext}`), 'export const message="external";');
  await writeFile(
    join(directory, `plugin.${ext}`),
    `import {message} from "./helper.${ext}";export default {id:"compiled",version:"1.0.0",apiVersion:1,setup(api){api.tools.register({name:"hi",description:message,inputSchema:{type:"object",properties:{}},async execute(){return {content:[{type:"text",text:message}]}}});api.commands.register("hi",async()=>message)}}`,
  );
  const plugins = JSON.parse(
    await execute([
      "plugins",
      "doctor",
      "--cwd",
      directory,
      "--plugin",
      join(directory, `plugin.${ext}`),
    ]),
  );
  assert.equal(plugins.tools.length, 1);
  assert.deepEqual(plugins.commands, ["compiled:hi"]);
  assert.deepEqual(plugins.builtin, [
    "deepseek",
    "opencode",
    "opencode-go",
    "openai-compatible",
    "memory",
    "subagents",
  ]);

  // `alisio install npm:<name>` installs into the global plugins directory through a PATH-shim fake
  // npm (no network), persists the npm name in the global config, refuses headless without --yes
  // and under --read-only, and `plugins list` shows the installed package.
  const installDir = await mkdtemp(join(tmpdir(), `alisio-${mode}-install-`));
  try {
    const binDir = join(installDir, "bin");
    await mkdir(binDir, { recursive: true });
    const shimJs = join(binDir, "shim.js");
    const callsFile = join(installDir, "config", "npm-calls.json");
    await writeFile(
      shimJs,
      `import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const prefix = args[args.indexOf("--prefix") + 1];
const target = args[args.length - 1];
const at = target.lastIndexOf("@");
const name = at > 0 ? target.slice(0, at) : target;
const dir = join(prefix, "node_modules", name);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "7.7.7", keywords: ["alisio-plugin"] }));
writeFileSync(join(prefix, "..", "npm-calls.json"), JSON.stringify(args));
`,
    );
    await writeFile(join(binDir, "npm"), `#!/bin/sh\nexec node ${JSON.stringify(shimJs)} "$@"\n`);
    await chmod(join(binDir, "npm"), 0o755);
    const installEnv = {
      ...process.env,
      PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      ALISIO_CONFIG_HOME: join(installDir, "config"),
      ALISIO_STATE_HOME: join(installDir, "state"),
      HERDR_ENV: "0",
    };
    const runInstall = async (args: string[], expectCode: number) => {
      const [program = "", ...prefix] = command;
      const child = spawn(program, [...prefix, ...args], {
        cwd: directory,
        stdio: ["ignore", "pipe", "pipe"],
        env: installEnv,
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      const code = await new Promise<number>((done) => child.on("close", (c) => done(c ?? 1)));
      assert.equal(code, expectCode, stderr);
      return { stdout, stderr };
    };
    const refused = await runInstall(["install", "npm:plugin-e2e"], 1);
    assert.match(refused.stderr, /--yes/);
    const readOnlyRefused = await runInstall(
      ["install", "npm:plugin-e2e", "--yes", "--read-only"],
      1,
    );
    assert.match(readOnlyRefused.stderr, /--read-only/);
    const installed = await runInstall(["install", "npm:plugin-e2e", "--yes"], 0);
    assert.match(installed.stdout, /plugin-e2e/);
    const installConfig = JSON.parse(
      await readFile(join(installDir, "config", "config.json"), "utf8"),
    ) as { plugins: string[] };
    assert.deepEqual(installConfig.plugins, ["plugin-e2e"]);
    assert.deepEqual(JSON.parse(await readFile(callsFile, "utf8")), [
      "install",
      "--prefix",
      join(installDir, "config", "plugins"),
      "plugin-e2e",
    ]);
    const list = JSON.parse((await runInstall(["plugins", "list"], 0)).stdout) as {
      global: string[];
    };
    assert.ok(
      list.global.some((p) => p.includes("node_modules") && p.includes("plugin-e2e")),
      `global plugins list did not include the installed package: ${list.global.join(",")}`,
    );
  } finally {
    await rm(installDir, { recursive: true, force: true });
  }
  // Headless prompt template: `run "/init"` renders the built-in template as the user turn.
  firstUserMessages.length = 0;
  await execute([
    "run",
    "/init focus on tests",
    "--cwd",
    directory,
    "--config",
    join(directory, "config.json"),
    "--json",
    "--allow-write",
  ]);
  assert.match(firstUserMessages[0] ?? "", /create or update the root `AGENTS\.md`/);
  assert.match(firstUserMessages[0] ?? "", /focus on tests/);
  const refused = await execute(
    ["run", "/init", "--cwd", directory, "--config", join(directory, "config.json"), "--read-only"],
    false,
    1,
  );
  assert.match(refused, /needs write access.*--read-only/);
  const sessions = JSON.parse(await execute(["sessions", "list"]));
  assert.equal(sessions.length, 5);
  // `alisio setup` (renamed from `alisio init`, which now behaves like any unknown command).
  const setupDirectory = await mkdtemp(join(tmpdir(), `alisio-${mode}-setup-`));
  try {
    const setupOutput = await execute(["setup", "--cwd", setupDirectory]);
    assert.match(setupOutput, /Created .*config\.json/);
    const scaffolded = JSON.parse(
      await readFile(join(setupDirectory, ".alisio", "config.json"), "utf8"),
    );
    assert.equal(scaffolded.provider.model, "YOUR_MODEL_ID");
    const setupAgain = await execute(["setup", "--cwd", setupDirectory], false, 1);
    assert.match(setupAgain, /Configuration exists/);
    // `init` is no longer a subcommand: commander's own default behavior (no special-casing)
    // rejects it, since the root command's default action takes no positional arguments.
    const unknownInit = await execute(["init", "--cwd", setupDirectory], false, 1);
    assert.match(unknownInit, /error:/i);
    const helpOutput = await execute(["--help"]);
    assert.match(helpOutput, /\bsetup\b/);

    // Headless paths (doctor, and `run`/`--json` elsewhere) never prompt for trust and keep the
    // exact pre-existing behavior: without --trust-project, a distinguishing custom baseURL in
    // `.alisio/config.json` is never read, and no trust-store entry is ever created for it.
    await writeFile(
      join(setupDirectory, ".alisio", "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        provider: { baseURL: "https://headless-trust-marker.example/v1", model: "x" },
      }),
    );
    const doctorUntrusted = JSON.parse(await execute(["doctor", "--cwd", setupDirectory]));
    assert.equal(doctorUntrusted.provider.baseURL, "https://api.openai.com/v1");
    const trustList = JSON.parse(await execute(["trust", "list"], false, 0).catch(() => "[]"));
    assert.ok(
      !trustList.some((e: { workspace: string }) => e.workspace.includes(setupDirectory)),
      "headless doctor must never create a trust-store entry",
    );
    // With --trust-project (today's explicit, one-run trust), the custom baseURL DOES load, and
    // that explicit flag still never persists a trust-store entry either.
    const doctorTrusted = JSON.parse(
      await execute(["doctor", "--cwd", setupDirectory, "--trust-project"]),
    );
    assert.equal(doctorTrusted.provider.baseURL, "https://headless-trust-marker.example/v1");
  } finally {
    await rm(setupDirectory, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({
      ok: true,
      runtime: mode,
      checks: [
        "CLI HTTP tool loop",
        "compatible MCP config list/doctor with fake stdio server and redacted direct env",
        "JSONL output",
        `external ${ext === "ts" ? "TypeScript" : "JavaScript"} plugin with dependency`,
        "built-in memory plugin loaded",
        "session persistence",
        "no node:sqlite ExperimentalWarning",
        "JSONL unchanged with a mascot/startup-screen plugin; no banner in run mode",
        "headless prompt template /init; --read-only refusal",
        "alisio setup scaffolds config; alisio init is now an unknown command",
        "headless doctor never prompts/persists trust; --trust-project still loads project config",
        "alisio install with a PATH-shim fake npm: global install, config entry, --yes/--read-only refusals, plugins list",
      ],
    }),
  );
} finally {
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
