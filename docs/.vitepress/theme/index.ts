import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import BentoFeatures from "./components/BentoFeatures.vue";
import HeroBackground from "./components/HeroBackground.vue";
import HeroInstall from "./components/HeroInstall.vue";
import { initWhatIs } from "./whatis";
import "./styles/vars.css";
import "./styles/home.css";
import "./styles/bento.css";
import "./styles/whatis.css";
import "./styles/docs.css";

/**
 * Extends VitePress' default theme with Alisio's shared visual tokens and
 * home-page treatments. Content and navigation remain VitePress defaults.
 */
export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "home-hero-before": () => h(HeroBackground),
      "home-hero-info-after": () => h(HeroInstall),
      "home-features-before": () => h(BentoFeatures),
    }),
  enhanceApp({ router }) {
    if (typeof window === "undefined") return;

    const afterRouteChange = router.onAfterRouteChange;
    router.onAfterRouteChange = async (to) => {
      await afterRouteChange?.(to);
      requestAnimationFrame(initWhatIs);
    };
    // First load: wait for the hydrated page before wiring the home block.
    requestAnimationFrame(() => requestAnimationFrame(initWhatIs));
  },
} satisfies Theme;
