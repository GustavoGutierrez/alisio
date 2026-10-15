/**
 * End-to-end CLI check against a local OpenAI-compatible fake server.
 * `node` mode runs packages/cli/dist/main.js with plain Node; `binary` runs dist/alisio (Bun).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
/**
 * A fake model for the data tools: inspect a CSV, query the dataset it names, then answer with the
 * number the query returned (the dataset engine is a child process of the CLI, so this also runs
 * the compiled binary as its own data engine).
 */
let dataRequests = 0;
const dataServer = await serve(async (req) => {
  const body = (await req.json()) as { messages: Array<{ role: string; content?: string }> };
  dataRequests++;
  const results = body.messages.filter((m) => m.role === "tool");
  const call = (name: string, input: unknown) => ({
    delta: {
      tool_calls: [
        {
          index: 0,
          id: `d${results.length}`,
          type: "function",
          function: { name, arguments: JSON.stringify(input) },
        },
      ],
    },
    finish_reason: "tool_calls",
  });
  const id = /ds_[0-9A-Z]+/.exec(String(results[0]?.content ?? ""))?.[0] ?? "ds_missing";
  const choice =
    results.length === 0
      ? call("data_inspect", { path: "sales.csv" })
      : results.length === 1
        ? call("data_query", { datasetId: id, sql: "SELECT sum(revenue) AS total FROM data" })
        : {
            delta: {
              content: `Total revenue ${/total\\+n(\d+)/.exec(JSON.stringify(results[1]?.content))?.[1]}`,
            },
            finish_reason: "stop",
          };
  return new Response(
    `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, ...choice }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
});
/**
 * A fake model for the background tasks: start a long-running command with `bg_run`, read its
 * output with `bg_output`, then answer. `run` waits for no task: it stops the one still running
 * when it ends and says so on stderr.
 */
let bgRequests = 0;
const bgServer = await serve(async (req) => {
  const body = (await req.json()) as { messages: Array<{ role: string; content?: string }> };
  bgRequests++;
  const results = body.messages.filter((m) => m.role === "tool");
  const call = (name: string, input: unknown) => ({
    delta: {
      tool_calls: [
        {
          index: 0,
          id: `bg${results.length}`,
          type: "function",
          function: { name, arguments: JSON.stringify(input) },
        },
      ],
    },
    finish_reason: "tool_calls",
  });
  const id = /task_[0-9A-Z]+/.exec(String(results[0]?.content ?? ""))?.[0] ?? "task_missing";
  const choice =
    results.length === 0
      ? call("bg_run", {
          command: `${JSON.stringify(process.execPath)} -e "console.log('bg-ready'); setTimeout(() => {}, 60000)"`,
          label: "e2e sleeper",
        })
      : results.length === 1
        ? call("bg_list", {})
        : { delta: { content: `Task ${id} is listed` }, finish_reason: "stop" };
  return new Response(
    `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, ...choice }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
});
/**
 * A fake model for Forja's `js_run`: the first turn calls js_run (a script that reads a file through
 * the gate, or, when the prompt says HANG, a busy loop), the second repeats what the tool said.
 */
let forgeRequests = 0;
let forgeHit: (() => void) | undefined;
const forgeServer = await serve(async (req) => {
  const body = (await req.json()) as { messages: Array<{ role: string; content?: string }> };
  forgeRequests++;
  const results = body.messages.filter((m) => m.role === "tool");
  const prompt = String(body.messages.find((m) => m.role === "user")?.content ?? "");
  const hang = prompt.includes("HANG");
  if (hang && results.length === 0) forgeHit?.();
  const code = hang
    ? "while (true) {}"
    : "const f = await tools.call('read_file', { path: 'note.txt' }); text('seen'); return JSON.stringify(f).includes('fixture content');";
  const choice =
    results.length === 0
      ? {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "j0",
                type: "function",
                function: {
                  name: "js_run",
                  arguments: JSON.stringify({ code, ...(hang ? { timeoutMs: 120000 } : {}) }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        }
      : {
          delta: { content: `Forge says ${JSON.stringify(String(results[0]?.content ?? ""))}` },
          finish_reason: "stop",
        };
  return new Response(
    `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, ...choice }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
});
/**
 * A fake model for Proof: it runs `node -e 0` through `run_process` once, then answers. A criterion
 * bound to that command ends up verified from the captured evidence; any other stays unchecked.
 */
const proofServer = await serve(async (req) => {
  const body = (await req.json()) as { messages: Array<{ role: string; content?: string }> };
  const answered = body.messages.some((m) => m.role === "tool");
  const choice = answered
    ? { delta: { content: "Done" }, finish_reason: "stop" }
    : {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "proof_call_1",
              type: "function",
              function: {
                name: "run_process",
                arguments: JSON.stringify({ command: "node", args: ["-e", "0"] }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      };
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
/** Runs the CLI and returns the exit code with both streams (for exit-code contracts). */
const executeAny = async (args: string[]) => {
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
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const code = await new Promise<number>((done) => child.on("close", (c) => done(c ?? 1)));
  return { code, stdout, stderr };
};
/** Like `execute` but returns stderr too (for diagnostics such as the ripgrep hint). */
const executeWithStderr = async (args: string[]) => {
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
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const code = await new Promise<number>((done) => child.on("close", (c) => done(c ?? 1)));
  assert.equal(code, 0, stderr);
  return { stdout, stderr };
};
/**
 * `alisio serve --no-open --port 0`: the launch URL is printed, /api/health answers without a
 * cookie, /api/metrics needs the cookie obtained from the token, and SIGTERM stops it cleanly.
 */
const serveSmoke = async () => {
  const [program = "", ...prefix] = command;
  const child = spawn(program, [...prefix, "serve", "--no-open", "--port", "0"], {
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ALISIO_CONFIG_HOME: join(directory, "global"),
      ALISIO_STATE_HOME: join(directory, "state"),
      HERDR_ENV: "0",
    },
  });
  let stdout = "",
    stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
  try {
    const launch = await new Promise<string>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`serve did not start: ${stderr}`)), 15_000);
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
        const match = /(http:\/\/127\.0\.0\.1:\d+)\/\?token=([\w-]+)/.exec(stdout);
        if (match) {
          clearTimeout(timer);
          done(match[0]);
        }
      });
    });
    const base = new URL(launch).origin;
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { protocolVersion: number }).protocolVersion, 1);
    assert.equal((await fetch(`${base}/api/metrics`)).status, 401);
    const exchange = await fetch(launch, { redirect: "manual" });
    assert.equal(exchange.status, 303);
    const cookie = String(exchange.headers.get("set-cookie")).split(";")[0] ?? "";
    assert.equal((await fetch(`${base}/api/metrics`, { headers: { Cookie: cookie } })).status, 200);
  } finally {
    child.kill("SIGTERM");
  }
  assert.equal(await exited, 0, stderr);
};
/**
 * `alisio run` + a termination signal: the run is aborted, the application closes and every
 * plugin's `dispose()` runs (a sentinel file proves it). SIGTERM and SIGHUP behave like SIGINT.
 */
const signalDispose = async (signal: "SIGTERM" | "SIGHUP" | "SIGINT") => {
  const sentinel = join(directory, `disposed-${signal}.txt`);
  const ext = mode === "binary" ? "ts" : "mjs";
  const pluginFile = join(directory, `dispose-${signal}.${ext}`);
  await writeFile(
    pluginFile,
    `import { writeFileSync } from "node:fs";export default {id:"disposer",version:"1.0.0",apiVersion:1,setup(){},dispose(){writeFileSync(${JSON.stringify(sentinel)},"disposed")}}`,
  );
  let hit: (() => void) | undefined;
  const requested = new Promise<void>((resolve) => {
    hit = resolve;
  });
  // A model that never answers: the run is still in flight when the signal arrives.
  const hanging = await serve(async () => {
    hit?.();
    await new Promise(() => {});
    return new Response("");
  });
  const config = join(directory, `signal-${signal}.json`);
  await writeFile(
    config,
    JSON.stringify({
      provider: {
        baseURL: `http://127.0.0.1:${hanging.port}/v1`,
        model: "test",
        auth: "none",
        apiMode: "chat",
      },
    }),
  );
  const [program = "", ...prefix] = command;
  const child = spawn(
    program,
    [
      ...prefix,
      "run",
      "Wait forever",
      "--cwd",
      directory,
      "--config",
      config,
      "--plugin",
      pluginFile,
    ],
    {
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
    },
  );
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
  try {
    await Promise.race([
      requested,
      new Promise((_, fail) =>
        setTimeout(() => fail(new Error(`run never asked: ${stderr}`)), 20_000),
      ),
    ]);
    child.kill(signal);
    await Promise.race([
      exited,
      new Promise((_, fail) =>
        setTimeout(() => fail(new Error(`run ignored ${signal}: ${stderr}`)), 20_000),
      ),
    ]);
    assert.equal(await readFile(sentinel, "utf8"), "disposed", `${signal}: ${stderr}`);
  } finally {
    child.kill("SIGKILL");
    await hanging.close();
  }
};
/** Runs the (possibly relocated) CLI to completion and returns its stdout. */
let forgeCommandForExecute: string[] | undefined;
const executeForge = async (args: string[]) => {
  const [program = "", ...prefix] = forgeCommandForExecute ?? command;
  const child = spawn(program, [...prefix, ...args], {
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ALISIO_CONFIG_HOME: join(directory, "global"),
      ALISIO_STATE_HOME: join(directory, "state"),
      HERDR_ENV: "0",
    },
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const code = await new Promise<number>((done) => child.on("close", (c) => done(c ?? 1)));
  assert.equal(code, 0, stderr);
  return stdout;
};
let forgeSessions = 0;
const rgAvailable = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
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
  await writeFile(
    join(directory, "data-config.json"),
    JSON.stringify({
      provider: {
        baseURL: `http://127.0.0.1:${dataServer.port}/v1`,
        model: "test",
        auth: "none",
        apiMode: "chat",
      },
    }),
  );
  await writeFile(
    join(directory, "bg-config.json"),
    JSON.stringify({
      provider: {
        baseURL: `http://127.0.0.1:${bgServer.port}/v1`,
        model: "test",
        auth: "none",
        apiMode: "chat",
      },
    }),
  );
  // Background tasks: bg_run and bg_list pass the process policy (--allow-process); the task is
  // still running when `run` ends, so it is stopped and the CLI says so.
  const bgRun = await executeWithStderr([
    "run",
    "Start a sleeper",
    "--cwd",
    directory,
    "--config",
    join(directory, "bg-config.json"),
    "--allow-process",
    "--json",
  ]);
  const bgEvents = bgRun.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(bgEvents.at(-1).type, "run_completed");
  assert.equal(bgRequests, 3);
  assert.deepEqual(
    bgEvents.filter((e) => e.type === "tool_completed").map((e) => e.data.name),
    ["bg_run", "bg_list"],
  );
  assert.equal(
    bgEvents.some((e) => e.type === "tool_failed"),
    false,
    bgRun.stdout,
  );
  assert.match(bgRun.stderr, /1 background task was still running and was stopped/);
  // Proof (specs/011): `run --proof` judges the run against its criteria and exits 0, 10 or 11.
  await writeFile(
    join(directory, "proof-config.json"),
    JSON.stringify({
      provider: {
        baseURL: `http://127.0.0.1:${proofServer.port}/v1`,
        model: "test",
        auth: "none",
        apiMode: "chat",
      },
    }),
  );
  const proofArgs = (...more: string[]) => [
    "run",
    "Run the check",
    "--cwd",
    directory,
    "--config",
    join(directory, "proof-config.json"),
    "--allow-process",
    "--json",
    "--proof",
    ...more,
  ];
  const verified = await executeAny(
    proofArgs("--criterion", "The check passes", "--verify", "node -e 0"),
  );
  assert.equal(verified.code, 0, verified.stderr);
  const verifiedLedger = JSON.parse(verified.stdout.trim().split("\n").at(-1) ?? "{}");
  assert.equal(verifiedLedger.type, "proof_ledger");
  assert.equal(verifiedLedger.schema, "proof/v1");
  assert.equal(verifiedLedger.ledger.criteria[0].status, "verified");
  assert.equal(verifiedLedger.ledger.criteria[0].evidenceIds.length, 1);
  const unchecked = await executeAny(
    proofArgs("--criterion", "A check nobody ran", "--verify", "node -e 1"),
  );
  assert.equal(unchecked.code, 11, unchecked.stderr);
  assert.equal(
    JSON.parse(unchecked.stdout.trim().split("\n").at(-1) ?? "{}").ledger.criteria[0].status,
    "not_checked",
  );
  const invalid = await executeAny(proofArgs("--verify", "node -e 0"));
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /--verify needs a --criterion/);
  // Forja (phase 3b): js_run runs a script in the QuickJS-WASM isolate (a worker on Node, a child
  // process of the binary itself on Bun), reads a file through the gate, and stops on SIGINT.
  // The binary is also copied to a path with spaces to prove nothing depends on a clean path.
  // The provider rides on `--config`; the host is a global-only key, so it goes to the user's own
  // config file. Forja is on by default: nothing here switches it on.
  const forgeConfigFile = async (name: string, host: "auto" | "process") => {
    const file = join(directory, name);
    await writeFile(
      file,
      JSON.stringify({
        provider: {
          baseURL: `http://127.0.0.1:${forgeServer.port}/v1`,
          model: "test",
          auth: "none",
          apiMode: "chat",
        },
      }),
    );
    await mkdir(join(directory, "global"), { recursive: true });
    await writeFile(
      join(directory, "global", "config.json"),
      JSON.stringify({ forge: { javascript: { host } } }),
    );
    return file;
  };
  const spacedDirectory = join(directory, "dir with spaces", "sub dir");
  let forgeCommand = command;
  if (mode === "binary") {
    await mkdir(spacedDirectory, { recursive: true });
    const copy = join(spacedDirectory, process.platform === "win32" ? "alisio.exe" : "alisio");
    await copyFile(command[0] ?? "", copy);
    await chmod(copy, 0o755);
    forgeCommand = [copy];
    forgeCommandForExecute = [copy];
  }
  const forgeEnv = {
    ...process.env,
    ALISIO_CONFIG_HOME: join(directory, "global"),
    ALISIO_STATE_HOME: join(directory, "state"),
    ALISIO_MODEL: "",
    OPENAI_BASE_URL: "",
    ALISIO_API_MODE: "",
    HERDR_ENV: "0",
  };
  const forgeRun = (args: string[]) => {
    forgeSessions++;
    const [program = "", ...prefix] = forgeCommand;
    const child = spawn(program, [...prefix, ...args], {
      cwd: directory,
      stdio: ["ignore", "pipe", "pipe"],
      env: forgeEnv,
    });
    const out = { stdout: "", stderr: "" };
    child.stdout.on("data", (d: Buffer) => {
      out.stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      out.stderr += d.toString();
    });
    const closed = new Promise<number>((done) => child.on("close", (c) => done(c ?? 1)));
    return { child, out, closed };
  };
  for (const [name, host] of mode === "binary"
    ? ([["forge-auto.json", "auto"]] as const)
    : ([
        ["forge-auto.json", "auto"],
        ["forge-process.json", "process"],
      ] as const)) {
    const config = await forgeConfigFile(name, host);
    const status = JSON.parse(
      (await executeForge(["forge", "status", "--probe", "--json", "--config", config])).trim(),
    );
    assert.equal(status.engines[0].ready, true, JSON.stringify(status));
    assert.equal(
      status.javascript.host,
      host === "process" || mode === "binary" ? "process" : "worker",
    );
    assert.equal(status.probe.ok, true, JSON.stringify(status.probe));
    // The JavaScript engine first, then the Python backends (wasm is not installed in a fresh state).
    assert.deepEqual(
      status.engines.map((e: { id: string }) => e.id),
      ["javascript-quickjs", "python-oci", "python-wasm", "python-managed"],
    );
    assert.equal(status.engines[2].ready, false);
    const before = forgeRequests;
    const run = forgeRun([
      "run",
      "Read note.txt with a script",
      "--cwd",
      directory,
      "--config",
      config,
      "--json",
    ]);
    assert.equal(await run.closed, 0, run.out.stderr);
    assert.equal(forgeRequests - before, 2);
    const events = run.out.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.at(-1).type, "run_completed");
    const done = events.filter((e) => e.type === "tool_completed");
    assert.deepEqual(
      done.map((e) => [e.data.name, e.data.isError]),
      [["js_run", false]],
    );
    assert.match(JSON.stringify(events), /status: succeeded\\nvalue: true/);
    assert.ok(
      events.some((e) => e.type === "tool_progress" && e.data.data?.kind === "forge"),
      "forge progress is streamed",
    );
    assert.equal(
      events.some((e) => e.type === "tool_started" && e.data.name === "execute"),
      false,
    );
  }
  // Cancelling a run in the middle of a busy loop stops it, and leaves no isolate behind.
  {
    const config = await forgeConfigFile("forge-cancel.json", "auto");
    const hit = new Promise<void>((resolve) => {
      forgeHit = resolve;
    });
    const run = forgeRun([
      "run",
      "HANG in a script",
      "--cwd",
      directory,
      "--config",
      config,
      "--json",
    ]);
    await hit;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const isolatePattern = `${directory}.*__forge-isolate|__forge-isolate.*${directory}`;
    if (mode === "binary" && process.platform !== "win32") {
      // Positive control: while the script spins, the binary's isolate process exists.
      const alive = spawnSync("pgrep", ["-f", isolatePattern], { encoding: "utf8" });
      assert.notEqual(alive.stdout.trim(), "", "the isolate process was not found while running");
    }
    const stopped = Date.now();
    run.child.kill("SIGINT");
    const code = await Promise.race([
      run.closed,
      new Promise<number>((_, fail) =>
        setTimeout(() => fail(new Error(`js_run was not cancelled: ${run.out.stderr}`)), 15_000),
      ),
    ]);
    assert.ok(Date.now() - stopped < 15_000);
    assert.notEqual(code, undefined);
    if (process.platform !== "win32") {
      // Nothing of this run may stay alive: the isolate process carries our unique folder name.
      const left = spawnSync("pgrep", ["-f", isolatePattern], { encoding: "utf8" });
      assert.equal(left.stdout.trim(), "", `an isolate process survived: ${left.stdout}`);
    }
  }
  await writeFile(join(directory, "sales.csv"), "region,revenue\nWest,10\nEast,20\nWest,5\n");
  const dataOut = await execute([
    "run",
    "Inspect sales.csv",
    "--cwd",
    directory,
    "--config",
    join(directory, "data-config.json"),
    "--json",
  ]);
  const dataEvents = dataOut
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(dataEvents.at(-1).type, "run_completed");
  assert.equal(dataRequests, 3);
  const completed = dataEvents.filter((e) => e.type === "tool_completed");
  assert.equal(completed.length, 2);
  assert.match(JSON.stringify(dataEvents), /Total revenue 35/);
  assert.equal(
    dataEvents.some((e) => e.type === "tool_failed"),
    false,
    dataOut,
  );
  // The analysis runtime and its retention (phase 4): status reports the mode, the container
  // settings and the retention defaults; `sweep` runs the janitor over this state folder and
  // leaves the dataset the run above just used (it was used a moment ago).
  const analysisStatus = JSON.parse(await execute(["analysis", "status", "--cwd", directory]));
  assert.equal(analysisStatus.mode, "auto");
  assert.equal(analysisStatus.isolation, "preferred");
  // The backends table: every Python backend with its isolation, the host never presented as isolated.
  assert.deepEqual(
    analysisStatus.backends.map((b: { id: string; isolation: string }) => [b.id, b.isolation]),
    [
      ["python-oci", "os-container"],
      ["python-wasm", "wasm-process"],
      ["python-managed", "none"],
    ],
  );
  assert.deepEqual(
    { jobsDays: 30, intermediateDays: 7, artifactsDays: 0 },
    {
      jobsDays: analysisStatus.retention.jobsDays,
      intermediateDays: analysisStatus.retention.intermediateDays,
      artifactsDays: analysisStatus.retention.artifactsDays,
    },
  );
  assert.equal(analysisStatus.oci.engine, "docker");
  // FP-AC-26: the standalone binary runs Pyodide in a Node child. With no node on PATH the wasm
  // backend is not ready and says why; the other backends are unaffected. (A Node run uses itself.)
  const wasmNeedsNode = async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), `alisio-${mode}-nopath-`));
    const [program = "", ...prefix] = command;
    const probe = spawnSync(program, [...prefix, "analysis", "status", "--cwd", directory], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: emptyPath,
        ALISIO_CONFIG_HOME: join(directory, "global"),
        ALISIO_STATE_HOME: join(directory, "state"),
        HERDR_ENV: "0",
      },
    });
    await rm(emptyPath, { recursive: true, force: true });
    assert.equal(probe.status, 0, probe.stderr);
    const backends = JSON.parse(probe.stdout).backends as Array<{
      id: string;
      ready: boolean;
      reason?: string;
    }>;
    const wasm = backends.find((b) => b.id === "python-wasm");
    assert.equal(wasm?.ready, false);
    assert.match(
      wasm?.reason ?? "",
      mode === "binary"
        ? /no node .* was found on PATH/
        : /Pyodide is not installed|Pyodide needs Node/,
    );
    assert.ok(backends.some((b) => b.id === "python-managed"));
  };
  await wasmNeedsNode();
  // Reliability lab: `eval list` (the bundled suites exist only in a source checkout, not in the
  // standalone binary), and `eval compare` exit codes (0 / 3).
  const evalReport = (suiteVersion: string) => ({
    schemaVersion: 1,
    suiteId: "e2e",
    suiteVersion,
    conditions: {
      harnessVersion: "dev",
      configHash: "sha256:aaa",
      provider: "fake",
      model: "fake-model",
      mode: "live",
      k: 5,
      seedBase: 1,
    },
    tasks: [
      {
        taskId: "t1",
        k: 5,
        successRate: { value: 1, wilsonLow: 0.57, wilsonHigh: 1 },
        passAtK: true,
        passPowK: true,
        measured: { medianWallMs: 1000 },
      },
    ],
    runs: [],
    summary: { tasks: 1, passed: 5, errored: 0, budgetExceeded: 0 },
  });
  const evalDirectory = join(directory, "eval-reports");
  for (const version of ["1.0.0", "2.0.0"]) {
    await mkdir(join(evalDirectory, version), { recursive: true });
    await writeFile(
      join(evalDirectory, version, "report.json"),
      JSON.stringify(evalReport(version)),
    );
  }
  const listed = JSON.parse(await execute(["eval", "list", "--json"])) as {
    suites: Array<{ id: string; origin: string }>;
  };
  assert.deepEqual(
    listed.suites.map((suite) => suite.id).sort(),
    mode === "binary" ? [] : ["long-context", "smoke-coding", "tool-sequences"],
  );
  assert.ok(listed.suites.every((suite) => suite.origin === "bundled"));
  assert.match(
    await execute(["eval", "compare", join(evalDirectory, "1.0.0"), join(evalDirectory, "1.0.0")]),
    /# Comparison: e2e 1\.0\.0/,
  );
  assert.match(
    await execute(
      ["eval", "compare", join(evalDirectory, "1.0.0"), join(evalDirectory, "2.0.0")],
      false,
      3,
    ),
    /different suite versions/,
  );
  const swept = JSON.parse(await execute(["analysis", "sweep", "--force", "--cwd", directory]));
  assert.equal(swept.datasetsDeleted, 0);
  assert.equal(swept.errors, 0);
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
        const { runId: _r, sessionId: _s, timestamp: _t, eventId: _e, ...event } = JSON.parse(line);
        if (event.data && typeof event.data === "object") {
          delete event.data.durationMs;
          delete event.data.ttftMs;
        }
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
  assert.deepEqual(plugins.builtin, ["openai-compatible", "memory", "subagents"]);

  // `alisio run "/plugin:name args"` runs a registered plugin command without calling the model;
  // unknown slash names still reach the model.
  const pluginArgs = ["--cwd", directory, "--config", join(directory, "config.json")];
  const before = requests;
  const direct = await execute([
    "run",
    "/compiled:hi there",
    ...pluginArgs,
    "--plugin",
    join(directory, `plugin.${ext}`),
  ]);
  assert.equal(direct.trim(), "external");
  const directJson = JSON.parse(
    await execute([
      "run",
      "/compiled:hi",
      ...pluginArgs,
      "--json",
      "--plugin",
      join(directory, `plugin.${ext}`),
    ]),
  );
  assert.deepEqual(
    [directJson.type, directJson.command, directJson.text],
    ["command_result", "compiled:hi", "external"],
  );
  assert.equal(requests, before, "a plugin command must not call the model");

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
  // Reliability lab, live: the provider is resolved from the config, one task runs in a throwaway
  // copy of its fixture against the fake server, and the three report files are written.
  const labSuite = join(directory, "lab-suite");
  await mkdir(join(labSuite, "fixtures", "read-note"), { recursive: true });
  await writeFile(join(labSuite, "fixtures", "read-note", "note.txt"), "fixture content");
  await writeFile(
    join(labSuite, "suite.json"),
    JSON.stringify({
      schemaVersion: 1,
      suiteId: "lab",
      suiteVersion: "1.0.0",
      description: "e2e",
      tasks: [
        {
          id: "read-note",
          prompt: "Read note.txt",
          fixture: "fixtures/read-note",
          budget: { maxTurns: 6, maxWallMs: 60000 },
          policy: { mode: "auto" },
          verifiers: [
            { kind: "file-contains", id: "kept", path: "note.txt", text: "fixture content" },
          ],
        },
      ],
    }),
  );
  const labOut = join(directory, "lab-report");
  const labLines = (
    await execute([
      "eval",
      "run",
      "lab",
      "--suite-dir",
      labSuite,
      "--yes",
      "--k",
      "2",
      "--json",
      "--allow-write",
      "--cwd",
      directory,
      "--config",
      join(directory, "config.json"),
      "--out",
      labOut,
    ])
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(labLines.length, 3);
  assert.deepEqual(
    labLines.slice(0, 2).map((r: { status: string }) => r.status),
    ["pass", "pass"],
  );
  assert.equal(labLines[2].tasks[0].k, 2);
  for (const file of ["report.json", "report.md", "runs.jsonl"])
    assert.ok((await readFile(join(labOut, file), "utf8")).length > 0);
  // Cassettes: record the task once live, replay it without calling the model, then change what the
  // harness asks (the prompt) and see the replay exit 2 with the diverged field.
  const labArgs = [
    "--suite-dir",
    labSuite,
    "--yes",
    "--allow-write",
    "--cwd",
    directory,
    "--config",
    join(directory, "config.json"),
  ];
  await execute(["eval", "record", "lab", ...labArgs]);
  const cassette = await readFile(join(labSuite, "cassettes", "read-note.cassette.jsonl"), "utf8");
  assert.match(cassette, /^\{"v":1,"cassetteVersion":1,/);
  const beforeReplay = requests;
  const replayLines = (
    await execute([
      "eval",
      "run",
      "lab",
      "--mode",
      "replay",
      "--json",
      "--out",
      join(directory, "lab-replay"),
      ...labArgs,
    ])
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(requests, beforeReplay, "a replay must not call the model");
  assert.equal(replayLines[0].mode, "replay");
  assert.equal(replayLines[0].status, "pass");
  const labSuiteFile = join(labSuite, "suite.json");
  await writeFile(
    labSuiteFile,
    (await readFile(labSuiteFile, "utf8")).replace("Read note.txt", "Read note.txt twice"),
  );
  const diverged = await execute(
    [
      "eval",
      "run",
      "lab",
      "--mode",
      "replay",
      "--out",
      join(directory, "lab-diverged"),
      ...labArgs,
    ],
    false,
    2,
  );
  assert.match(diverged, /DIVERGED .*messages\[0\]\.user\.text/s);
  const sessions = JSON.parse(await execute(["sessions", "list"]));
  assert.equal(sessions.length, 11 + forgeSessions); // includes the two plugin-command runs, the two Proof runs and the Forja runs
  // v4 run journal written by this runtime (Node or the Bun binary): one terminal row per run,
  // and the partial unique index on (session, request_id) exists.
  {
    const { DatabaseSync } = process.getBuiltinModule(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    const journal = new DatabaseSync(join(directory, "state", "sessions.sqlite"));
    try {
      const runs = journal
        .prepare("SELECT status, count(*) AS n FROM runs GROUP BY status")
        .all() as { status: string; n: number }[];
      assert.ok(
        runs.some((r) => r.status === "completed" && r.n > 0),
        JSON.stringify(runs),
      );
      assert.ok(!runs.some((r) => r.status === "running" || r.status === "queued"));
      assert.ok(journal.prepare("SELECT 1 FROM sqlite_master WHERE name='runs_request'").get());
    } finally {
      journal.close();
    }
  }
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
    assert.match(helpOutput, /\bserve\b/);
    const serveHelp = await execute(["serve", "--help"]);
    assert.match(serveHelp, /--allow-remote/);
    assert.match(serveHelp, /--no-open/);
    const remoteRefused = await execute(["serve", "--host", "0.0.0.0", "--no-open"], false, 1);
    assert.match(remoteRefused, /--allow-remote/);
    await serveSmoke();
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) await signalDispose(signal);

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
    // Doctor explains how to install ripgrep when it is missing; no hint needed when present.
    if (!rgAvailable) {
      const { stdout: doctorStdout, stderr: doctorStderr } = await executeWithStderr([
        "doctor",
        "--cwd",
        setupDirectory,
      ]);
      assert.deepEqual(JSON.parse(doctorStdout).ripgrep, null);
      assert.match(doctorStderr, /apt install ripgrep/);
      assert.match(doctorStderr, /brew install ripgrep/);
    }
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
        "data_inspect + data_query on a CSV through the data engine process",
        "alisio analysis status (mode, container settings, retention) and analysis sweep",
        "compatible MCP config list/doctor with fake stdio server and redacted direct env",
        "bg_run + bg_list through the process policy; run stops the task still running and says so",
        "forge status --probe and js_run in the isolate (reads a file through the gate, streams progress); SIGINT cancels a busy loop and leaves no isolate behind",
        "JSONL output",
        `external ${ext === "ts" ? "TypeScript" : "JavaScript"} plugin with dependency`,
        "built-in memory plugin loaded",
        "session persistence",
        "v4 run journal (runs table, partial unique index)",
        "no node:sqlite ExperimentalWarning",
        "JSONL unchanged with a mascot/startup-screen plugin; no banner in run mode",
        "headless prompt template /init; --read-only refusal",
        "alisio setup scaffolds config; alisio init is now an unknown command",
        "alisio run: SIGTERM, SIGHUP and SIGINT abort the run and dispose plugins (sentinel file)",
        "alisio serve: --help, --allow-remote refusal, health/token/cookie smoke, SIGTERM exit",
        "headless doctor never prompts/persists trust; --trust-project still loads project config",
        "alisio eval list/compare/run: a live run against the fake server writes its report files; exit 0 and 3 (incompatible suites); eval record + replay without calling the model, exit 2 on divergence",
        "alisio run --proof: criteria from --criterion/--verify, the proof/v1 ledger as the final --json event, exit 0 (verified) and 11 (unchecked), a --verify without --criterion refused",
        "alisio install with a PATH-shim fake npm: global install, config entry, --yes/--read-only refusals, plugins list",
      ],
    }),
  );
} finally {
  await server.close();
  await dataServer.close();
  await forgeServer.close();
  await bgServer.close();
  await proofServer.close();
  await rm(directory, { recursive: true, force: true });
}
