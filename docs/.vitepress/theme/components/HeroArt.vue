<script setup lang="ts">
import { useData, withBase } from "vitepress";
import { computed } from "vue";

/**
 * Fills VitePress' `home-hero-image` slot: the logo plus thin wind streaks drifting behind it.
 * It renders the same static markup on the server and in the browser; `hero-motion.ts` animates
 * `[data-sway]` and `[data-streak]` after hydration. Purely decorative (the heading and the
 * alt text carry the meaning), so the streaks are `aria-hidden`.
 */
const { frontmatter } = useData();
const image = computed(() => {
  const raw = frontmatter.value.hero?.image;
  if (!raw) return undefined;
  return typeof raw === "string"
    ? { src: raw, alt: "" }
    : { src: raw.src as string, alt: (raw.alt as string) ?? "" };
});

/** Streaks run right to left; dashes make each one read as a gust rather than a ruled line. */
const STREAKS = [
  { d: "M520 52C440 28 360 84 270 56S96 36 0 66", w: 1.4, dash: "150 46 70 100" },
  { d: "M520 100C430 80 350 128 262 104S100 90 0 118", w: 1, dash: "90 40 180 60" },
  { d: "M520 150C446 128 372 176 280 152S110 138 0 168", w: 1.6, dash: "210 70 60 90" },
  { d: "M520 200C436 182 352 226 262 204S90 190 0 220", w: 1.1, dash: "120 50 120 70" },
  { d: "M520 246C450 226 370 268 280 248S110 236 0 262", w: 1.3, dash: "70 60 160 90" },
];
</script>

<template>
  <div class="alisio-hero-art" data-hero-art>
    <svg class="alisio-streaks" viewBox="0 0 520 300" width="520" height="300" fill="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="alisio-streak-fade" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="520" y2="0">
          <stop offset="0" stop-color="currentColor" stop-opacity="0" />
          <stop offset="0.3" stop-color="currentColor" stop-opacity="1" />
          <stop offset="0.7" stop-color="currentColor" stop-opacity="1" />
          <stop offset="1" stop-color="currentColor" stop-opacity="0" />
        </linearGradient>
      </defs>
      <path
        v-for="(streak, i) in STREAKS"
        :key="i"
        class="alisio-streak"
        data-streak
        :d="streak.d"
        :stroke-width="streak.w"
        :stroke-dasharray="streak.dash"
        stroke="url(#alisio-streak-fade)"
        stroke-linecap="round"
      />
    </svg>
    <div class="alisio-sway" data-sway>
      <img
        v-if="image"
        class="image-src"
        :src="withBase(image.src)"
        :alt="image.alt"
        width="360"
        height="360"
        decoding="async"
        fetchpriority="high"
      />
    </div>
  </div>
</template>
