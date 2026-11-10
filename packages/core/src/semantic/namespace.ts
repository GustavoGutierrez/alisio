/** Collections are stored as `<pluginId>/<collection>` (spec 029, D4). Plugin ids never contain `/`. */
export const namespacePrefix = (pluginId: string): string => `${pluginId}/`;

export const composeCollection = (pluginId: string, collection: string): string =>
  `${namespacePrefix(pluginId)}${collection}`;

/** The consumer-visible name, or `null` when the stored name belongs to another plugin. */
export function decomposeCollection(pluginId: string, stored: string): string | null {
  const prefix = namespacePrefix(pluginId);
  return stored.startsWith(prefix) && stored.length > prefix.length
    ? stored.slice(prefix.length)
    : null;
}
