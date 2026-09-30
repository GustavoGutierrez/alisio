/**
 * Renderer registry (spec §10.4): `kind → view`. `code` and the fallback ship in the initial
 * bundle (Markdown fences use them constantly); every other kind is a dynamic import with its
 * own chunk. Phase 5 swaps the `mermaid`/`math` loaders for the real renderers.
 */
import type { UiBlock } from "@alisio/sdk";
import type { ComponentType } from "preact";
import CodeView from "./code/view.tsx";
import FallbackView from "./fallback/view.tsx";
import type { LazyKind } from "./kinds.ts";
import { createResolver } from "./resolve.ts";

export type RendererProps = { block: UiBlock; live?: boolean };
export type RendererComponent = ComponentType<RendererProps>;
type Loader = () => Promise<RendererComponent>;

const view =
  <M extends { default: unknown }>(load: () => Promise<M>): Loader =>
  () =>
    load().then((m) => m.default as RendererComponent);
const basic =
  (name: string): Loader =>
  () =>
    import("./basic/view.tsx").then((m) => m.views[name] as RendererComponent);

/** Every lazy kind needs a loader: the `Record` makes a missing one a type error. */
const LOADERS: Record<LazyKind, Loader> = {
  table: basic("table"),
  "key-value": basic("key-value"),
  tree: basic("tree"),
  markdown: basic("markdown"),
  diff: view(() => import("./diff/view.tsx")),
  terminal: view(() => import("./terminal/view.tsx")),
  json: view(() => import("./json/view.tsx")),
  "test-results": view(() => import("./tests/view.tsx")),
  progress: view(() => import("./progress/view.tsx")),
  // Phase 5 brings Mermaid and KaTeX; until then their source shows as code.
  mermaid: view(() => import("./source/view.tsx")),
  math: view(() => import("./source/view.tsx")),
};

/** The view of a block kind: sync when bundled, else a cached dynamic import. */
export const viewFor = createResolver<RendererComponent>({
  sync: { code: CodeView as RendererComponent },
  loaders: LOADERS,
  fallback: FallbackView as RendererComponent,
});
