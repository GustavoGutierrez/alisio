import type { DecisionProvider } from "@alisio/sdk";

const PROVIDER_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export interface RegisteredDecisionProvider {
  owner: string;
  provider: DecisionProvider;
}

/** Catalog of decision providers. Registering never activates: the configuration picks one. */
export class DecisionRegistry {
  private entries = new Map<string, RegisteredDecisionProvider>();
  private listeners = new Set<() => void>();

  /** Notified after every successful registration and removal (never throws into callers). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Observers cannot break registration. */
      }
    }
  }

  /** Returns the function that removes this registration (a no-op once it was replaced). */
  register(owner: string, provider: DecisionProvider): () => void {
    if (!provider || typeof provider !== "object") throw new Error("Invalid decision provider");
    if (typeof provider.id !== "string" || !PROVIDER_ID.test(provider.id))
      throw new Error(`Invalid decision provider id: ${String(provider.id)}`);
    if (typeof provider.name !== "string" || !provider.name.trim())
      throw new Error(`Decision provider ${provider.id} needs a name`);
    const capabilities = provider.capabilities as Record<string, unknown> | undefined;
    if (
      !capabilities ||
      typeof capabilities.select !== "boolean" ||
      typeof capabilities.boolean !== "boolean" ||
      typeof capabilities.ordinal !== "boolean"
    )
      throw new Error(`Decision provider ${provider.id} needs boolean capabilities`);
    if (typeof provider.decide !== "function")
      throw new Error(`Decision provider ${provider.id} needs a decide function`);
    if (this.entries.has(provider.id))
      throw new Error(`Duplicate decision provider: ${provider.id}`);
    const entry = { owner, provider };
    this.entries.set(provider.id, entry);
    this.changed();
    return () => {
      if (this.entries.get(provider.id) !== entry) return;
      this.entries.delete(provider.id);
      this.changed();
    };
  }

  get(id: string): RegisteredDecisionProvider | undefined {
    return this.entries.get(id);
  }

  list(): Array<{
    id: string;
    name: string;
    owner: string;
    capabilities: DecisionProvider["capabilities"];
  }> {
    return [...this.entries.values()]
      .map(({ owner, provider }) => ({
        id: provider.id,
        name: provider.name,
        owner,
        capabilities: { ...provider.capabilities },
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
