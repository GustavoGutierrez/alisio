import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { defineComponent, h, onMounted } from "vue";
import BentoFeatures from "./components/BentoFeatures.vue";
import DesktopDownloads from "./components/DesktopDownloads.vue";
import { initHeroVideo } from "./hero-video";
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
const enhanceHome = () => {
  initWhatIs();
  initHeroVideo();
};

const Layout = defineComponent({
  name: "AlisioLayout",
  setup() {
    // First load: the enhancers inject DOM into the hero and the home block, so they must wait
    // until Vue has finished hydrating (the layout mounts last); otherwise they race hydration
    // and produce "Hydration completed but contains mismatches".
    onMounted(() => requestAnimationFrame(enhanceHome));
    return () =>
      h(DefaultTheme.Layout, null, {
        "home-hero-after": () => h(DesktopDownloads),
        "home-features-before": () => h(BentoFeatures),
      });
  },
});

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ router }) {
    if (typeof window === "undefined") return;

    const afterRouteChange = router.onAfterRouteChange;
    router.onAfterRouteChange = async (to) => {
      await afterRouteChange?.(to);
      requestAnimationFrame(enhanceHome);
    };
  },
} satisfies Theme;
