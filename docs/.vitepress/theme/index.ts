import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import BentoFeatures from "./components/BentoFeatures.vue";
import HeroInstall from "./components/HeroInstall.vue";
import "./styles/vars.css";
import "./styles/home.css";
import "./styles/bento.css";
import "./styles/docs.css";

/**
 * Extends VitePress' default theme with Alisio's shared visual tokens and
 * home-page treatments. Content and navigation remain VitePress defaults.
 */
export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "home-hero-info-after": () => h(HeroInstall),
      "home-features-before": () => h(BentoFeatures),
    }),
  enhanceApp({ router }) {
    if (typeof window === "undefined") return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncDemoVideos = () => {
      document
        .querySelectorAll<HTMLVideoElement>('[data-component="video"] video')
        .forEach((video) => {
          if (reducedMotion.matches) {
            video.pause();
          } else {
            void video.play().catch(() => undefined);
          }
        });
    };

    reducedMotion.addEventListener("change", syncDemoVideos);
    const afterRouteChange = router.onAfterRouteChange;
    router.onAfterRouteChange = async (to) => {
      await afterRouteChange?.(to);
      requestAnimationFrame(syncDemoVideos);
    };
    requestAnimationFrame(syncDemoVideos);
  },
} satisfies Theme;
