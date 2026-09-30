/**
 * The renderer resolution rule (spec §10.4, T-17), generic so it is testable without views:
 * eager views return synchronously, lazy ones load once (cached), and anything unknown or failing
 * to load resolves to the fallback.
 */
export function createResolver<V>(options: {
  sync: Partial<Record<string, V>>;
  loaders: Partial<Record<string, () => Promise<V>>>;
  fallback: V;
}): (kind: string) => V | Promise<V> {
  const cache = new Map<string, Promise<V>>();
  const own = (table: object, kind: string) => Object.hasOwn(table, kind);
  return (kind) => {
    if (own(options.sync, kind)) return options.sync[kind] as V;
    if (!own(options.loaders, kind)) return options.fallback;
    let pending = cache.get(kind);
    if (!pending) {
      const load = options.loaders[kind] as () => Promise<V>;
      pending = load().catch(() => options.fallback);
      cache.set(kind, pending);
    }
    return pending;
  };
}
