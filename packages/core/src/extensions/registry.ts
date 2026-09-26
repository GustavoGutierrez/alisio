/**
 * Generic, typed extension registry. Resolution is deterministic and independent of plugin
 * load order: highest priority, then plugin id (lexicographic), then registration order
 * within the plugin. Fallbacks (built-in defaults) only win when nothing else is registered.
 */
import type { ExtensionPoints } from "@alisio/sdk";

export interface ExtensionConflict {
  point: string;
  /** `plugin/provider` of the chosen provider. */
  winner: string;
  losers: string[];
}
interface Entry {
  point: keyof ExtensionPoints;
  provider: ExtensionPoints[keyof ExtensionPoints];
  plugin: string;
  priority: number;
  fallback: boolean;
  seq: number;
}
const key = (e: Entry) => `${e.plugin}/${e.provider.id}`;
function compare(a: Entry, b: Entry): number {
  if (a.fallback !== b.fallback) return a.fallback ? 1 : -1;
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.plugin !== b.plugin) return a.plugin < b.plugin ? -1 : 1;
  return a.seq - b.seq;
}
export class ExtensionRegistry {
  private entries: Entry[] = [];
  private seq = 0;
  register<K extends keyof ExtensionPoints>(
    point: K,
    provider: ExtensionPoints[K],
    options: { plugin: string; priority?: number; fallback?: boolean },
  ): () => void {
    if (!provider || typeof provider.id !== "string" || typeof provider.render !== "function")
      throw new Error(`Invalid ${point} provider: it needs an id and a render function`);
    const priority = options.priority ?? 0;
    if (!Number.isFinite(priority)) throw new Error("Extension priority must be a finite number");
    const entry: Entry = {
      point,
      provider,
      plugin: options.plugin,
      priority,
      fallback: !!options.fallback,
      seq: this.seq++,
    };
    this.entries.push(entry);
    return () => {
      this.entries = this.entries.filter((e) => e !== entry);
    };
  }
  private ranked(point: keyof ExtensionPoints): Entry[] {
    return this.entries.filter((e) => e.point === point).sort(compare);
  }
  resolve<K extends keyof ExtensionPoints>(
    point: K,
  ): { provider: ExtensionPoints[K]; plugin: string } | undefined {
    const top = this.ranked(point)[0];
    return top ? { provider: top.provider as ExtensionPoints[K], plugin: top.plugin } : undefined;
  }
  /** Equal-priority, non-fallback competitors for each point's winning slot. */
  conflicts(point?: keyof ExtensionPoints): ExtensionConflict[] {
    const points = point ? [point] : [...new Set(this.entries.map((e) => e.point))];
    const out: ExtensionConflict[] = [];
    for (const p of points) {
      const ranked = this.ranked(p).filter((e) => !e.fallback);
      const winner = ranked[0];
      if (!winner) continue;
      const losers = ranked.filter((e) => e !== winner && e.priority === winner.priority);
      if (losers.length) out.push({ point: p, winner: key(winner), losers: losers.map(key) });
    }
    return out;
  }
}
