export { requestSemanticActivation, type SemanticActivationDeps } from "./activation.ts";
export { formatSemanticReport } from "./format.ts";
export { composeCollection, decomposeCollection, namespacePrefix } from "./namespace.ts";
export { type RegisteredSemantic, SemanticRegistry } from "./registry.ts";
export {
  DEFAULT_SEMANTIC_CONFIG,
  HEALTH_TIMEOUT_MS as SEMANTIC_HEALTH_TIMEOUT_MS,
  type SemanticConfig,
  SemanticService,
  type SemanticServiceDeps,
  type SemanticStatus,
} from "./service.ts";
export { SEMANTIC_LIMITS } from "./validate.ts";
