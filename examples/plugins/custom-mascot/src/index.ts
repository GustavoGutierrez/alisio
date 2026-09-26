import { definePlugin, type MascotProvider, type StartupScreenProvider } from "@alisio/sdk";

/** A kite riding the trade winds. Honors unicode/color/columns from the context only. */
export const kiteMascot: MascotProvider = {
  id: "kite",
  render({ terminal }) {
    if (terminal.columns < 40) return terminal.unicode ? "◇~ kite" : "<>~ kite";
    const art = terminal.unicode
      ? ["   ◢◣", "  ◢██◣", "  ◥██◤", "   ◥◤", "    ╲", "     ∿∿"]
      : ["   /\\", "  /  \\", "  \\  /", "   \\/", "    \\", "     ~~"];
    return terminal.color ? art.map((line) => `\u001b[35m${line}\u001b[0m`) : art;
  },
};

/** Optional compact screen that reuses whichever mascot won resolution. */
export const compactScreen: StartupScreenProvider = {
  id: "kite.compact",
  render(ctx) {
    const mascot = [ctx.mascot.render({ terminal: ctx.terminal, version: ctx.version })].flat();
    return [
      ...mascot,
      `Alisio ${ctx.version} · ${ctx.model ?? "no model"} · ${ctx.plugins.length} plugin(s)`,
      ...ctx.tips.slice(0, 1),
    ];
  },
};

export default definePlugin({
  id: "kite-mascot",
  version: "0.1.0",
  apiVersion: 1,
  setup(api) {
    // Priority 10 beats plugins registering at the default priority 0.
    api.extensions.register("mascot", kiteMascot, { priority: 10 });
    // Uncomment to also replace the whole startup screen:
    // api.extensions.register("startup-screen", compactScreen);
  },
});
