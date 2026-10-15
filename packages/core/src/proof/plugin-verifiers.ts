/**
 * Registry of the Proof verifiers plugins contribute (`api.proof.registerVerifier`, specs/011
 * 3.8). Criteria bind to a verifier as `<pluginId>:<id>`, exactly like plugin commands, so two
 * plugins cannot shadow each other. The registry holds code only: it never creates criteria or
 * evidence, and it grants no permission (a verifier's tool calls go through the core gate).
 */
import type { ProofVerifierRegistration } from "@alisio/sdk";

const VERIFIER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DESCRIBE_MAX = 500;

export interface RegisteredVerifier {
  plugin: string;
  verifier: ProofVerifierRegistration;
}

export class ProofVerifierRegistry {
  private readonly verifiers = new Map<string, RegisteredVerifier>();

  /** Registers `verifier` for `plugin`; returns the function that removes exactly this entry. */
  register(plugin: string, verifier: ProofVerifierRegistration): () => void {
    if (typeof verifier?.id !== "string" || !VERIFIER_ID.test(verifier.id))
      throw new Error(`Invalid verifier id: ${String(verifier?.id)}`);
    if (typeof verifier.describe !== "string" || !verifier.describe.trim())
      throw new Error("A verifier needs a description");
    if (typeof verifier.run !== "function") throw new Error("A verifier needs a run function");
    const key = `${plugin}:${verifier.id}`;
    if (this.verifiers.has(key)) throw new Error(`Duplicate verifier ${key}`);
    const entry: RegisteredVerifier = {
      plugin,
      verifier: { ...verifier, describe: verifier.describe.trim().slice(0, DESCRIBE_MAX) },
    };
    this.verifiers.set(key, entry);
    return () => {
      if (this.verifiers.get(key) === entry) this.verifiers.delete(key);
    };
  }

  get(verifierId: string): RegisteredVerifier | undefined {
    return this.verifiers.get(verifierId);
  }

  /** What is registered, sorted by id (no handlers). */
  list(): Array<{ verifierId: string; plugin: string; describe: string }> {
    return [...this.verifiers.entries()]
      .map(([verifierId, { plugin, verifier }]) => ({
        verifierId,
        plugin,
        describe: verifier.describe,
      }))
      .sort((a, b) => (a.verifierId < b.verifierId ? -1 : a.verifierId > b.verifierId ? 1 : 0));
  }
}
