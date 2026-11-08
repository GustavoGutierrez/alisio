import type {
  ModelInfo,
  ModelProvider,
  ProviderAuthMethod,
  ProviderCreateRequest,
  ProviderRegistration,
} from "@alisio/sdk";
import type { OAuthManager } from "./oauth/manager.ts";

export interface RegisteredProvider extends ProviderRegistration {
  plugin: string;
  builtin: boolean;
}

const AUTH_METHOD_ID = /^[a-z0-9_-]{1,40}$/;

/** A registration declared an invalid `auth` block (D29). */
export class ProviderAuthDeclarationError extends Error {
  readonly code = "PROVIDER_AUTH_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "ProviderAuthDeclarationError";
  }
}

/** Method ids must be non-empty, `^[a-z0-9_-]{1,40}$` and unique within the registration (D29b). */
function validateAuth(providerId: string, auth: unknown): void {
  if (auth === undefined) return;
  if (!Array.isArray(auth))
    throw new ProviderAuthDeclarationError(`Provider ${providerId}: auth must be an array`);
  const seen = new Set<string>();
  for (const method of auth as ProviderAuthMethod[]) {
    const id = method?.id;
    if (typeof id !== "string" || !AUTH_METHOD_ID.test(id))
      throw new ProviderAuthDeclarationError(
        `Provider ${providerId}: invalid auth method id (expected ^[a-z0-9_-]{1,40}$)`,
      );
    if (seen.has(id))
      throw new ProviderAuthDeclarationError(
        `Provider ${providerId}: duplicate auth method id "${id}"`,
      );
    seen.add(id);
  }
}

/** Additive provider catalog. Registrations are unique by provider id and independently removable. */
export class ProviderRegistry {
  private entries = new Map<string, RegisteredProvider>();
  private oauth: OAuthManager | undefined;
  private removedListeners = new Set<(entry: RegisteredProvider) => void>();

  /**
   * Calls `listener` whenever a registration is removed (its plugin was uninstalled or recycled):
   * the point where pending sign-in flows of that registration are cancelled (D28a).
   */
  onRemoved(listener: (entry: RegisteredProvider) => void): () => void {
    this.removedListeners.add(listener);
    return () => void this.removedListeners.delete(listener);
  }

  /** Connects the sign-in custodian; handles are built here, in one place (D19). */
  attachOAuth(manager: OAuthManager): void {
    this.oauth = manager;
  }

  register(
    registration: ProviderRegistration,
    owner: { plugin: string; builtin: boolean },
  ): () => void {
    if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(registration.id))
      throw new Error(`Invalid provider id: ${registration.id}`);
    if (this.entries.has(registration.id))
      throw new Error(`Duplicate provider: ${registration.id}`);
    validateAuth(registration.id, registration.auth);
    const entry = { ...registration, ...owner };
    this.entries.set(entry.id, entry);
    return () => {
      if (this.entries.get(entry.id) !== entry) return;
      this.entries.delete(entry.id);
      for (const listener of [...this.removedListeners])
        try {
          listener(entry);
        } catch {
          /* A listener's failure never blocks the removal. */
        }
    };
  }

  get(id: string): RegisteredProvider | undefined {
    return this.entries.get(id);
  }

  list(): RegisteredProvider[] {
    return [...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Builds a provider. `request.oauth` is set here and only here: only when the registration
   * declares `auth` and a `profile` name is given, bound to that profile and to this registration
   * (least privilege, D19, D21). Whatever a caller passes in `request.oauth` is discarded.
   */
  async create(
    id: string,
    request: ProviderCreateRequest,
    profile?: string,
  ): Promise<ModelProvider> {
    const registration = this.entries.get(id);
    if (!registration) throw new Error(`Unknown provider: ${id}`);
    const { oauth: _ignored, ...rest } = request;
    const handle =
      registration.auth?.length && profile && this.oauth
        ? this.oauth.handleFor(profile, id)
        : undefined;
    return registration.create(handle ? { ...rest, oauth: handle } : rest);
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
