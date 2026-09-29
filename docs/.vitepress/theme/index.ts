import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import "./styles/vars.css";
import "./styles/home.css";

/**
 * Extends VitePress' default theme with Alisio's shared visual tokens and
 * home-page treatments. Content and navigation remain VitePress defaults.
 */
export default {
  extends: DefaultTheme,
} satisfies Theme;
