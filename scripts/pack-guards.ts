/** Manifest guards shared by `pack-check.ts` and its tests. */

/** Semantic engines (vector stores, inference runtimes) must never ship inside the host (spec 029, D2). */
const FORBIDDEN_HOST_DEPENDENCY = /^(@lancedb\/|onnxruntime-|@huggingface\/transformers$)/;

/**
 * Names of `dependencies` a published host package must not declare. Only `dependencies` count:
 * a plugin may list them elsewhere, and host dev dependencies never reach the tarball.
 */
export function forbiddenHostDependencies(manifest: {
  dependencies?: Record<string, string>;
}): string[] {
  return Object.keys(manifest.dependencies ?? {}).filter((name) =>
    FORBIDDEN_HOST_DEPENDENCY.test(name),
  );
}

/** The D2 failure message naming the package, or `undefined` when the manifest is clean. */
export function hostDependencyViolation(
  packageName: string,
  manifest: { dependencies?: Record<string, string> },
): string | undefined {
  const found = forbiddenHostDependencies(manifest);
  return found.length > 0
    ? `${packageName}: host packages must not depend on semantic engines (${found.join(", ")}); they live in a provider plugin (spec 029, D2)`
    : undefined;
}
