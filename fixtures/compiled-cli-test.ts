import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "alisio-compiled-")),
  binary = resolve(process.platform === "win32" ? "dist/alisio.exe" : "dist/alisio");
let requests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { messages: Array<{ role: string; content?: string }> };
    requests++;
    const choice =
      requests === 1
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
    if (requests === 2) assert.match(JSON.stringify(body.messages), /fixture content/);
    return new Response(
      `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, ...choice }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  },
});
const execute = async (args: string[]) => {
  const child = Bun.spawn([binary, ...args], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
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
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, stderr);
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
  await writeFile(join(directory, "helper.ts"), 'export const message="external";');
  await writeFile(
    join(directory, "plugin.ts"),
    'import {message} from "./helper.ts";export default {id:"compiled",version:"1.0.0",apiVersion:1,setup(api){api.tools.register({name:"hi",description:message,inputSchema:{type:"object",properties:{}},async execute(){return {content:[{type:"text",text:message}]}}});api.commands.register("hi",async()=>message)}}',
  );
  const plugins = JSON.parse(
    await execute([
      "plugins",
      "doctor",
      "--cwd",
      directory,
      "--plugin",
      join(directory, "plugin.ts"),
    ]),
  );
  assert.equal(plugins.tools.length, 1);
  assert.deepEqual(plugins.commands, ["compiled:hi"]);
  const sessions = JSON.parse(await execute(["sessions", "list"]));
  assert.equal(sessions.length, 1);
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "compiled CLI HTTP tool loop",
        "JSONL output",
        "external TypeScript plugin with dependency",
        "session persistence",
      ],
    }),
  );
} finally {
  await server.stop(true);
  await rm(directory, { recursive: true, force: true });
}
