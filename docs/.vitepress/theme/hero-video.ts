/**
 * Progressive enhancement for the docs home hero: swaps the static background artwork for the
 * looping winds video (muted, no controls, decorative). Injected into `.VPHero` at runtime, the
 * same way `whatis.ts` enhances its block, so no VitePress slot is overridden. Without JS the CSS
 * fallback image and the reduced-motion path keep the artwork; the poster covers the load gap.
 */
import { withBase } from "vitepress";

const SRC = "/assets/alisio-winds-720p.webm";
const POSTER = "/assets/background-box.jpg";
const REDUCE = "(prefers-reduced-motion: reduce)";

export function initHeroVideo(): void {
  if (typeof document === "undefined") return;
  const hero = document.querySelector<HTMLElement>(".VPHome .VPHero");
  if (!hero || hero.querySelector(".alisio-hero-video")) return;
  const video = document.createElement("video");
  video.className = "alisio-hero-video";
  video.src = withBase(SRC);
  video.poster = withBase(POSTER);
  video.muted = true;
  video.loop = true;
  video.autoplay = true;
  video.playsInline = true;
  video.preload = "auto";
  video.tabIndex = -1;
  video.setAttribute("aria-hidden", "true");
  // Appended after `.container`; the CSS lifts the content above it (z-index) either way.
  hero.append(video);
  // Reduced motion: the CSS hides the video, so never start it.
  if (window.matchMedia(REDUCE).matches) return;
  // Autoplay can still be rejected (battery saver, strict policies): keep the poster frame.
  void video.play().catch(() => undefined);
}
