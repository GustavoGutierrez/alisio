/**
 * Client-only access to Motion (motion.dev). It is imported lazily so it lands in its own chunk,
 * never blocks hydration and is never evaluated during SSR. Only `animate` from `motion/mini`
 * (the WAAPI build, ~2 KB gzip) is used: staggers are plain per-element delays and in-view
 * detection is an IntersectionObserver, so the heavier hybrid engine is never shipped.
 */
export const REDUCE = "(prefers-reduced-motion: reduce)";

export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia(REDUCE).matches;

export const loadMotion = () => import("motion/mini");
