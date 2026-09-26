/** Contract test using the real Herdr CLI and an isolated protocol responder (not a real PTY server). */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { HerdrBridge } from "../packages/core/src/integrations/herdr.ts";
import { runProcess } from "../packages/core/src/runtime/process.ts";

const binary = process.env.HERDR_TEST_BIN;
if (!binary) throw new Error("HERDR_TEST_BIN is required");
const directory = await mkdtemp(join(tmpdir(), "alisio-herdr-")),
  socket = join(directory, "server.sock");
const received: Array<{ id: string; method: string; params: Record<string, unknown> }> = [];
const server = createServer((connection) => {
  let buffer = "";
  connection.on("data", (chunk) => {
    buffer += chunk.toString();
    const line = buffer.indexOf("\n");
    if (line < 0) return;
    const request = JSON.parse(buffer.slice(0, line));
    received.push(request);
    connection.end(
      `${JSON.stringify({ id: request.id, ok: true, result: { agents: [], submitted: true } })}\n`,
    );
  });
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(socket, resolve);
}).catch(async (error) => {
  await rm(directory, { recursive: true, force: true });
  throw error;
});
const execute = async (args: string[], signal: AbortSignal) => {
  const r = await runProcess(binary, args, {
    cwd: directory,
    signal,
    env: { PATH: process.env.PATH ?? "", HERDR_SOCKET_PATH: socket },
    timeoutMs: 3000,
  });
  assert.equal(r.exitCode, 0, r.stderr);
  return r.stdout;
};
try {
  const bridge = new HerdrBridge(
    { HERDR_ENV: "1", HERDR_BIN_PATH: binary, HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: socket },
    execute,
    (message) => {
      throw new Error(message);
    },
  );
  await bridge.report("idle", "alisio-session");
  await bridge.report("working", "alisio-session");
  const registry = new ToolRegistry();
  bridge.registerTools(registry);
  const ctx = { workspace: directory, signal: AbortSignal.timeout(5000), emit: () => {} };
  await registry.get("herdr_agents").execute({}, ctx);
  await registry
    .get("herdr_prompt")
    .execute({ target: "w1:p2", text: "Review the changes; do not modify files" }, ctx);
  await registry.get("herdr_read").execute({ target: "w1:p2", lines: 20 }, ctx);
  await registry.get("herdr_wait").execute({ target: "w1:p2", timeoutMs: 1000 }, ctx);
  await bridge.close();
  assert.deepEqual(
    received.map((r) => r.method),
    [
      "pane.report_agent",
      "pane.report_agent",
      "agent.list",
      "agent.prompt",
      "agent.read",
      "agent.wait",
      "pane.release_agent",
    ],
  );
  assert.equal(received[0]?.params.agent, "alisio");
  assert.equal(received[0]?.params.state, "idle");
  assert.equal(received[0]?.params.agent_session_id, "alisio-session");
  assert.equal(received[3]?.params.text, "Review the changes; do not modify files");
  console.log(JSON.stringify({ ok: true, methods: received.map((r) => r.method) }));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
