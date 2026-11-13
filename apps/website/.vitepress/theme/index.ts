import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme-without-fonts";
import { defineComponent, h, onMounted } from "vue";
import DesktopDownloads from "./components/DesktopDownloads.vue";
import HeroArt from "./components/HeroArt.vue";
import HeroWind from "./components/HeroWind.vue";
import HomeIntro from "./components/HomeIntro.vue";
import ShowcaseSlider from "./components/ShowcaseSlider.vue";
import TerminalInstall from "./components/TerminalInstall.vue";
import { initHeroMotion } from "./hero-motion";
import { initHeroVideo } from "./hero-video";
import { initWhatIs } from "./whatis";
import "./styles/vars.css";
import "./styles/home.css";
import "./styles/landing.css";
import "./styles/docs.css";

/**
 * Extends VitePress' default theme with Alisio's shared visual tokens and
 * home-page treatments. Content and navigation remain VitePress defaults; the brand
 * typefaces load from Google Fonts (see `head` in config.ts), so the bundled Inter is skipped.
 */
const enhanceHome = () => {
  initWhatIs();
  initHeroVideo();
  initHeroMotion();
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
        "home-hero-image": () => h(HeroArt),
        "home-hero-info-after": () => h(HeroWind),
        "home-hero-after": () => h(HomeIntro),
      });
  },
});

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app, router }) {
    // Used inside the home markdown (apps/website/index.md, apps/website/es/index.md).
    app.component("DesktopDownloads", DesktopDownloads);
    app.component("TerminalInstall", TerminalInstall);
    app.component("ShowcaseSlider", ShowcaseSlider);
    if (typeof window === "undefined") return;

    const afterRouteChange = router.onAfterRouteChange;
    router.onAfterRouteChange = async (to) => {
      await afterRouteChange?.(to);
      requestAnimationFrame(enhanceHome);
    };
  },
} satisfies Theme;
