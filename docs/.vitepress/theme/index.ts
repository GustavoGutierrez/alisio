import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import "./styles/vars.css";
import "./styles/home.css";
import "./styles/docs.css";

/**
 * Extends VitePress' default theme with Alisio's shared visual tokens and
 * home-page treatments. Content and navigation remain VitePress defaults.
 */
export default {
  extends: DefaultTheme,
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
