/**
 * Renderer registry (spec §10.4): `kind → view`. `code` and the fallback ship in the initial
 * bundle (Markdown fences use them constantly); the rest are dynamic imports. Phase 3 ships
 * simple views for every kind; phase 4/5 replace them with the richer renderers of §10.4
 * without changing this API: add or swap a loader here.
 */
import type { UiBlock } from "@alisio/sdk";
import type { ComponentType } from "preact";
import CodeView from "./code/view.tsx";
import FallbackView from "./fallback/view.tsx";
import { type RendererKind, rendererFor } from "./kinds.ts";

export type RendererProps = { block: UiBlock; live?: boolean };
export type RendererComponent = ComponentType<RendererProps>;
type Loader = () => Promise<RendererComponent>;

const basic =
  (name: string): Loader =>
  () =>
    import("./basic/view.tsx").then((m) => m.views[name] as RendererComponent);
const dev =
  (name: string): Loader =>
  () =>
    import("./dev/view.tsx").then((m) => m.views[name] as RendererComponent);

/** Views available synchronously. */
export const SYNC: Partial<Record<RendererKind, RendererComponent>> = {
  code: CodeView as RendererComponent,
  fallback: FallbackView as RendererComponent,
};

const LOADERS: Partial<Record<RendererKind, Loader>> = {
  table: basic("table"),
  "key-value": basic("key-value"),
  tree: basic("tree"),
  markdown: basic("markdown"),
  diff: dev("diff"),
  terminal: dev("terminal"),
  json: dev("json"),
  "test-results": dev("test-results"),
  progress: dev("progress"),
  // Phase 5 brings Mermaid and KaTeX; until then their source shows as code.
  mermaid: dev("mermaid"),
  math: dev("math"),
};

const cache = new Map<RendererKind, Promise<RendererComponent>>();

/** The view of a block kind: sync when bundled, else a cached dynamic import. */
export function viewFor(kind: string): RendererComponent | Promise<RendererComponent> {
  const key = rendererFor(kind);
  const sync = SYNC[key];
  if (sync) return sync;
  const loader = LOADERS[key];
  if (!loader) return FallbackView as RendererComponent;
  let pending = cache.get(key);
  if (!pending) {
    pending = loader().catch(() => FallbackView as RendererComponent);
    cache.set(key, pending);
  }
  return pending;
}
