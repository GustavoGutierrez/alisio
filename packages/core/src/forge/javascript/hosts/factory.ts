/**
 * Chooses the isolate host (spec §6.3, D-20). Node always gets the worker; Bun (directly or as a
 * compiled binary) gets the child process, because `worker.terminate()` does not reliably stop a
 * WASM loop there. `forge.javascript.host` can force either one for diagnosis. The only runtime
 * detection in Forja lives here and reads `process.versions.bun`, not a Bun global.
 */
import type { IsolateHost } from "../../ports.ts";
import { type ProcessHostOptions, ProcessIsolateHost } from "./process-host.ts";
import { type WorkerHostOptions, WorkerIsolateHost } from "./worker-host.ts";

export type HostChoice = "auto" | "worker" | "process";

export function chooseHostKind(
  choice: HostChoice,
  bun: boolean = !!process.versions.bun,
): "worker" | "process" {
  if (choice !== "auto") return choice;
  return bun ? "process" : "worker";
}

export interface IsolateHostFactoryOptions {
  choice: HostChoice;
  /** The verified, compiled module (the worker receives it; the child compiles its own copy). */
  module: () => Promise<WebAssembly.Module>;
  worker?: Omit<WorkerHostOptions, "module">;
  process?: ProcessHostOptions;
  bun?: boolean;
}

export class IsolateHostFactory {
  readonly #options: IsolateHostFactoryOptions;

  constructor(options: IsolateHostFactoryOptions) {
    this.#options = options;
  }

  get kind(): "worker" | "process" {
    return chooseHostKind(this.#options.choice, this.#options.bun);
  }

  async create(): Promise<IsolateHost> {
    if (this.kind === "process") return new ProcessIsolateHost(this.#options.process);
    return new WorkerIsolateHost({ ...this.#options.worker, module: await this.#options.module() });
  }
}
