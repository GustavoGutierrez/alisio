import type {
  ModelInfo,
  ModelProvider,
  ProviderCreateRequest,
  ProviderRegistration,
} from "@alisio/sdk";

export interface RegisteredProvider extends ProviderRegistration {
  plugin: string;
  builtin: boolean;
}

/** Additive provider catalog. Registrations are unique by provider id and independently removable. */
export class ProviderRegistry {
  private entries = new Map<string, RegisteredProvider>();

  register(
    registration: ProviderRegistration,
    owner: { plugin: string; builtin: boolean },
  ): () => void {
    if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(registration.id))
      throw new Error(`Invalid provider id: ${registration.id}`);
    if (this.entries.has(registration.id))
      throw new Error(`Duplicate provider: ${registration.id}`);
    const entry = { ...registration, ...owner };
    this.entries.set(entry.id, entry);
    return () => {
      if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
    };
  }

  get(id: string): RegisteredProvider | undefined {
    return this.entries.get(id);
  }

  list(): RegisteredProvider[] {
    return [...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(id: string, request: ProviderCreateRequest): Promise<ModelProvider> {
    const registration = this.entries.get(id);
    if (!registration) throw new Error(`Unknown provider: ${id}`);
    return registration.create(request);
  }
}

/** Mutable facade keeps runner/plugin completion references stable while the active provider changes. */
export class ActiveProvider implements ModelProvider {
  constructor(private current: ModelProvider) {}
  /** Core-only lifecycle access; credentials remain encapsulated by the provider instance. */
  get currentProvider(): ModelProvider {
    return this.current;
  }
  get id() {
    return this.current.id;
  }
  get model() {
    return this.current.model;
  }
  stream(request: Parameters<ModelProvider["stream"]>[0]) {
    return this.current.stream(request);
  }
  listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    return this.current.listModels?.(signal) ?? Promise.resolve([]);
  }
  /** Swap only after the candidate exists; a failed candidate creation leaves the old provider live. */
  async replace(next: ModelProvider, disposePrevious = true): Promise<void> {
    const previous = this.current;
    this.current = next;
    if (!disposePrevious) return;
    try {
      await previous.dispose?.();
    } catch {
      // Activation already committed. A stale provider disposal failure must not roll it back.
    }
  }
  dispose() {
    return this.current.dispose?.();
  }
}

export class UnconfiguredProvider implements ModelProvider {
  readonly id = "unconfigured";
  readonly model = "";
  async *stream(): AsyncIterable<never> {
    throw new Error(
      "No model provider is configured. Use /connect in the TUI or configure one before running headless.",
    );
  }
}
