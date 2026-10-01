/**
 * Entry point of the data engine process. The host bundles this file and the modules it imports
 * into one script (`scripts/analysis-data-engine.ts` → `engine-source.ts`) and runs it with the
 * current runtime (`node`, `bun`, or the compiled binary acting as `bun`). Requests arrive as one
 * JSON object per line on stdin; answers leave the same way on stdout.
 */
import type { EngineRequest, EngineResponse } from "./engine-types.ts";
import { EngineError, runFinalize, runIngest } from "./ingest-worker.ts";
import { LineSplitter } from "./json.ts";
import { closeConnections, QueryRejected, runQuery } from "./query-worker.ts";

const send = (message: EngineResponse) => process.stdout.write(`${JSON.stringify(message)}\n`);

async function handle(req: EngineRequest): Promise<void> {
  try {
    switch (req.op) {
      case "ingest": {
        const result = await runIngest(req, (rows) => send({ id: req.id, type: "progress", rows }));
        send({ id: req.id, type: "result", result });
        return;
      }
      case "finalize":
        send({
          id: req.id,
          type: "result",
          result: runFinalize(req.target, req.sourceName, req.sourceSha256),
        });
        return;
      case "query":
        send({ id: req.id, type: "result", result: runQuery(req) });
        return;
      case "close":
        closeConnections(req.db);
        send({ id: req.id, type: "result", result: {} });
        return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof EngineError
        ? error.code
        : error instanceof QueryRejected
          ? "query_rejected"
          : req.op === "query"
            ? "sql_error"
            : "engine_error";
    send({ id: (req as { id: number }).id, type: "error", code, message });
  }
}

let chain: Promise<void> = Promise.resolve();
const lines = new LineSplitter((line) => {
  if (!line.trim()) return;
  let request: EngineRequest;
  try {
    request = JSON.parse(line) as EngineRequest;
  } catch {
    return;
  }
  chain = chain.then(() => handle(request));
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (text: string) => lines.write(text));
process.stdin.on("end", () => {
  lines.end();
  chain.then(() => closeConnections());
});
