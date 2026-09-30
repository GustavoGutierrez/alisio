import type { UiBlock } from "@alisio/sdk";
import { Component, type ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import FallbackView from "./fallback/view.tsx";
import { type RendererComponent, viewFor } from "./registry.ts";

/** Shows the fallback (source + error) when a renderer throws (RNF-10). */
class Guard extends Component<{ block: UiBlock; children: ComponentChildren }, { error?: string }> {
  override state: { error?: string } = {};
  override componentDidCatch(error: unknown) {
    this.setState({ error: error instanceof Error ? error.message : String(error) });
  }
  override render() {
    return this.state.error ? (
      <FallbackView block={this.props.block} error={this.state.error} />
    ) : (
      this.props.children
    );
  }
}

/** Renders a `UiBlock` with its registered view, loading it on demand. */
export function RendererHost(props: { block: UiBlock; live?: boolean }) {
  // A lazy initializer: passing the component itself would make useState call it.
  const [View, setView] = useState<RendererComponent | undefined>(() => {
    const initial = viewFor(props.block.kind);
    return typeof (initial as Promise<unknown>).then === "function"
      ? undefined
      : (initial as RendererComponent);
  });
  useEffect(() => {
    const view = viewFor(props.block.kind);
    if (typeof (view as Promise<unknown>).then !== "function") {
      setView(() => view as RendererComponent);
      return;
    }
    let active = true;
    void (view as Promise<RendererComponent>).then((loaded) => {
      if (active) setView(() => loaded);
    });
    return () => {
      active = false;
    };
  }, [props.block.kind]);
  if (!View)
    return props.block.kind === "math" && props.block.display === false ? (
      <code>{props.block.latex}</code>
    ) : (
      <FallbackView block={props.block} loading />
    );
  return (
    <Guard block={props.block}>
      <View block={props.block} live={props.live} />
    </Guard>
  );
}
