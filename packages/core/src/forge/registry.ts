/**
 * Engine registry + null object (spec §4.2, D17). An engine is kept only when its self-description
 * says it is ready; otherwise an `UnavailableEngine` takes its place, exposes the reason and never
 * runs code. Fail closed: a throwing or mismatched self-check is "not ready".
 */
import type { EngineDescriptor, EngineId, EngineLanguage } from "@alisio/sdk";
import { ForgeError } from "./errors.ts";
import type {
  EngineOutcome,
  ExecutionEngine,
  ExecutionRequest,
  PreparedExecution,
  TerminationReport,
  TrustedExecutionContext,
} from "./ports.ts";

const languageOf = (id: EngineId): EngineLanguage =>
  id.startsWith("javascript-") ? "javascript" : "python";

export class UnavailableEngine implements ExecutionEngine {
  readonly id: EngineId;
  readonly #descriptor: EngineDescriptor;

  constructor(descriptor: EngineDescriptor) {
    this.id = descriptor.id;
    this.#descriptor = descriptor;
  }

  async describe(): Promise<EngineDescriptor> {
    return this.#descriptor;
  }

  #unavailable(): ForgeError {
    return new ForgeError(
      "ENGINE_UNAVAILABLE",
      this.#descriptor.reason ?? `engine ${this.id} is not ready`,
    );
  }

  async prepare(
    _request: ExecutionRequest,
    _ctx: TrustedExecutionContext,
  ): Promise<PreparedExecution> {
    throw this.#unavailable();
  }

  async run(): Promise<EngineOutcome> {
    throw this.#unavailable();
  }

  /** Nothing ever runs here, so there is nothing left to stop. */
  async terminate(): Promise<TerminationReport> {
    return { confirmed: true, method: "interrupt", elapsedMs: 0 };
  }

  async dispose(): Promise<void> {}
}

/** A descriptor for an engine that cannot report one itself. */
function unavailableDescriptor(id: EngineId, reason: string): EngineDescriptor {
  return {
    id,
    language: languageOf(id),
    version: "unavailable",
    isolation: "none",
    ready: false,
    reason,
    capabilities: {
      cooperativeInterrupt: false,
      hardTermination: false,
      hardMemoryLimit: false,
      networkDeniedByOS: false,
      toolCalls: false,
    },
  };
}

export class EngineRegistry {
  readonly #engines = new Map<EngineId, ExecutionEngine>();
  readonly #descriptors = new Map<EngineId, EngineDescriptor>();

  /** Runs the engine's self-check and keeps it only if ready. Returns the descriptor in force. */
  async register(engine: ExecutionEngine): Promise<EngineDescriptor> {
    let descriptor: EngineDescriptor;
    try {
      descriptor = await engine.describe();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      descriptor = unavailableDescriptor(engine.id, `self-check failed: ${message}`);
    }
    if (descriptor.id !== engine.id) {
      descriptor = unavailableDescriptor(
        engine.id,
        `self-check described ${descriptor.id} instead of ${engine.id}`,
      );
    }
    if (!descriptor.ready) {
      descriptor = {
        ...descriptor,
        reason: descriptor.reason ?? `engine ${engine.id} is not ready`,
      };
      this.#engines.set(engine.id, new UnavailableEngine(descriptor));
    } else {
      this.#engines.set(engine.id, engine);
    }
    this.#descriptors.set(engine.id, descriptor);
    return descriptor;
  }

  /** The registered engine, or an unavailable one: never `undefined`, never a silent fallback. */
  get(id: EngineId): ExecutionEngine {
    return (
      this.#engines.get(id) ??
      new UnavailableEngine(unavailableDescriptor(id, `engine ${id} is not registered`))
    );
  }

  descriptors(): Partial<Record<EngineId, EngineDescriptor>> {
    return Object.fromEntries(this.#descriptors);
  }
}
