/**
 * What runs inside an isolate (spec §6.3, D-20, D-21): the worker thread body and the child
 * process body. Both build a `GuestTransport` over their channel and hand it to `runGuest`.
 *
 * The process variant refuses to run unless `ALISIO_FORGE_ISOLATE=1` is set (the host sets it
 * with an otherwise empty environment), so the hidden `__forge-isolate` command cannot be
 * mistaken for something a user runs. It talks only through stdin/stdout frames and exits when
 * the execution reaches its terminal message.
 *
 * Erasable TypeScript only (D-33).
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { runGuest } from "../vm-runner.ts";
import { loadQuickJsModule } from "../wasm.ts";
import { encodeFrame, FrameDecoder } from "./framing.ts";

export interface WorkerIsolateData {
  forgeIsolate: 1;
  module: WebAssembly.Module;
  flag: SharedArrayBuffer;
}

/** Body of a worker thread started by `WorkerIsolateHost`. */
export async function runWorkerIsolate(): Promise<void> {
  const data = workerData as WorkerIsolateData | undefined;
  if (isMainThread || !parentPort || data?.forgeIsolate !== 1) return;
  const port = parentPort;
  await runGuest({
    module: data.module,
    flag: new Int32Array(data.flag),
    transport: {
      send: (message) => port.postMessage(message),
      onMessage: (handler) => port.on("message", handler),
    },
  });
  // The terminal message is posted; leaving the thread lets the parent observe a clean `exit`.
  process.exit(0);
}

/** Body of the child process started by `ProcessIsolateHost` (or by `alisio __forge-isolate`). */
export async function runProcessIsolate(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (env.ALISIO_FORGE_ISOLATE !== "1") {
    process.stderr.write("__forge-isolate is internal and is started by the Forja process host\n");
    process.exit(2);
  }
  const module = await loadQuickJsModule();
  const decoder = new FrameDecoder(8 * 1024 * 1024);
  let handler: (message: unknown) => void = () => {};
  process.stdin.on("data", (chunk: Buffer) => {
    try {
      for (const message of decoder.push(chunk)) handler(message);
    } catch {
      process.exit(3);
    }
  });
  process.stdin.on("end", () => process.exit(0));
  await runGuest({
    module,
    transport: {
      send: (message) => process.stdout.write(encodeFrame(message)),
      onMessage: (next) => {
        handler = next;
      },
    },
  });
  // Exit once the last frame is flushed.
  process.stdout.write("", () => process.exit(0));
}
