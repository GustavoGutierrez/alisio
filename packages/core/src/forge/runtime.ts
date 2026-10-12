/**
 * Assembly of the Forja engines for one application (spec §4.1): the engine registry with the
 * JavaScript engine's self-check, the kernel and the status the CLI and the API report. Nothing
 * runs here: it builds the objects, and `register()` is the only step that touches the file system
 * (to verify the WASM). Fail closed (D17): an engine that does not verify is registered as
 * unavailable, `js_run` is not offered and `status()` says why.
 */
import type { EngineDescriptor } from "@alisio/sdk";
import type { Config } from "../config.ts";
import { JavaScriptEngine } from "./javascript/engine.ts";
import { IsolateHostFactory } from "./javascript/hosts/factory.ts";
import { JAVASCRIPT_ENGINE_VERSION, QUICKJS_WASM_SHA256 } from "./javascript/runtime-manifest.ts";
import { loadQuickJsModule } from "./javascript/wasm.ts";
import type { SqliteExecutionJournal } from "./journal.ts";
import { ExecutionKernel, type KernelConfig } from "./kernel.ts";
import { type ForgeLimits, mergeLimits } from "./limits.ts";
import { EngineRegistry } from "./registry.ts";
import { createJavaScriptSelector } from "./selector.ts";
import { SlotTable } from "./slots.ts";
import type { SqliteStateStore } from "./state-store.ts";

/** One table per process: the per-process cap is shared by every application in it (D-29). */
const processSlots = new SlotTable();

export interface ForgeStatus {
  engines: EngineDescriptor[];
  javascript: {
    /** The WASM verified and the host can start, whatever `enabled` says. */
    verified: boolean;
    /** Why it did not verify. */
    verification?: string;
    enabled: boolean;
    host: "worker" | "process";
    hostSetting: "auto" | "worker" | "process";
    wasmSha256: string;
    version: string;
    limits: ForgeLimits;
  };
  scratch: { enabled: boolean; retentionDays: number; maxBytes: number };
  state: { enabled: boolean };
  guides: { enabled: boolean };
}

export interface ForgeRuntime {
  engines: EngineRegistry;
  engine: JavaScriptEngine;
  kernel: ExecutionKernel;
  /** The JavaScript engine verified and may be offered (`js_run`). */
  jsReady: boolean;
  status(): Promise<ForgeStatus>;
  /** Starts a real isolate and runs a trivial script (`alisio forge status --probe`). */
  probe(): ReturnType<JavaScriptEngine["probe"]>;
}

export interface ForgeRuntimeDeps {
  forge: () => Config["forge"];
  journal: SqliteExecutionJournal;
  state: SqliteStateStore;
  /** Overrides the host factory (tests). */
  hosts?: IsolateHostFactory;
}

const kernelConfig = (forge: Config["forge"]): KernelConfig => {
  const js = forge.javascript;
  return {
    enabled: js.enabled,
    stateEnabled: forge.state.enabled,
    limits: {
      timeoutMs: js.timeoutMs,
      memoryBytes: js.memoryBytes,
      stackBytes: js.stackBytes,
      maxToolCalls: js.maxToolCalls,
      maxConcurrency: js.maxConcurrency,
      maxOutputChars: js.maxOutputChars,
    },
  };
};

export async function createForgeRuntime(deps: ForgeRuntimeDeps): Promise<ForgeRuntime> {
  const hosts =
    deps.hosts ??
    new IsolateHostFactory({ choice: deps.forge().javascript.host, module: loadQuickJsModule });
  const engine = new JavaScriptEngine({ hosts });
  const engines = new EngineRegistry();
  let jsReady = false;
  // A disabled engine is never loaded or verified: nothing happens at startup with Forja off.
  if (deps.forge().javascript.enabled) jsReady = (await engines.register(engine)).ready;
  const kernel = new ExecutionKernel({
    engines,
    selector: createJavaScriptSelector(),
    journal: deps.journal,
    state: deps.state,
    slots: processSlots,
    config: () => kernelConfig(deps.forge()),
  });
  return {
    engines,
    engine,
    kernel,
    jsReady,
    probe: () => engine.probe(),
    status: () => describeForge(deps.forge(), engine),
  };
}

/** The engine's state as `alisio forge status` and the API report it. */
export async function describeForge(
  forge: Config["forge"],
  engine: JavaScriptEngine,
): Promise<ForgeStatus> {
  // Always a fresh self-check: `verified` says whether the engine WOULD run, `enabled` whether it may.
  const verification = await engine.describe();
  const enabled = forge.javascript.enabled;
  const descriptor: EngineDescriptor =
    !enabled && verification.ready
      ? { ...verification, ready: false, reason: "disabled by config (forge.javascript.enabled)" }
      : verification;
  return {
    engines: [descriptor],
    javascript: {
      verified: verification.ready,
      ...(verification.ready ? {} : { verification: verification.reason ?? "not verified" }),
      enabled,
      host: engine.hostKind,
      hostSetting: forge.javascript.host,
      wasmSha256: QUICKJS_WASM_SHA256,
      version: JAVASCRIPT_ENGINE_VERSION,
      limits: mergeLimits({ global: kernelConfig(forge).limits }),
    },
    // The folder (`scratch.root`) is a host path: it stays out of what the surfaces show.
    scratch: {
      enabled: forge.scratch.enabled,
      retentionDays: forge.scratch.retentionDays,
      maxBytes: forge.scratch.maxBytes,
    },
    state: { enabled: forge.state.enabled },
    guides: { enabled: forge.guides.enabled },
  };
}

/** A throwaway engine for the CLI: no application, no database. */
export function forgeEngineFor(forge: Config["forge"]): JavaScriptEngine {
  return new JavaScriptEngine({
    hosts: new IsolateHostFactory({ choice: forge.javascript.host, module: loadQuickJsModule }),
  });
}
