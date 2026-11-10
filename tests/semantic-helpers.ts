import {
  type SemanticConfig,
  SemanticRegistry,
  SemanticService,
} from "../packages/core/src/semantic/index.ts";
import { memoryEmbedding, memoryStore } from "./fixtures/memory-semantic.ts";

export function setupSemantic(
  config: Partial<SemanticConfig> = {},
  options: { embedding?: Parameters<typeof memoryEmbedding>[0]; register?: boolean } = {},
) {
  const registry = new SemanticRegistry();
  const cfg: SemanticConfig = {
    enabled: true,
    embedding: "mem-embed",
    store: "mem-store",
    embedTimeoutMs: 1000,
    queryTimeoutMs: 1000,
    ...config,
  };
  const embedding = memoryEmbedding(options.embedding);
  const store = memoryStore();
  if (options.register !== false) {
    registry.registerEmbedding("provider-plugin", embedding);
    registry.registerStore("provider-plugin", store);
  }
  const service = new SemanticService({ registry, config: () => cfg });
  return { registry, cfg, embedding, store, service, api: service.forPlugin("consumer") };
}
