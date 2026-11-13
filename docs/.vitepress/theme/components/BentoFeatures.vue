<script setup lang="ts">
import { useData, withBase } from "vitepress";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import creatorShotEn from "../../../assets/web-ui/plugin_creator_empty_web_ui.webp";
import creatorShotEs from "../../../assets/web-ui/plugin_creator_empty_web_ui_es.webp";
import { loadMotion, prefersReducedMotion } from "../motion";

interface FeatureLink {
  text: string;
  link: string;
  external?: boolean;
}

/** `link` makes the whole card one link; `links` (+ `chips`) gives a card its own separate links. */
interface Feature {
  icon?: string;
  title: string;
  details: string;
  link?: string;
  links?: FeatureLink[];
  chips?: string[];
}

/** Stroke icons on a 24x24 grid; `currentColor`, decorative only. */
const ICONS: Record<string, string> = {
  terminal: "M4 5h16v14H4zM7.5 10l3 2.5-3 2.5M13 15h4",
  browser: "M4 5h16v14H4zM4 9h16M7 7h.01M10 7h.01",
  chart: "M4 20V4M4 20h16M8 16v-4M12 16V8M16 16v-6",
  api: "M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14",
  shield: "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6zM9 12l2.2 2.2L15.5 10",
  layers: "M12 4l9 4.5-9 4.5-9-4.5zM3 13l9 4.5 9-4.5M3 17.5l9 4.5 9-4.5",
  memory:
    "M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3zM5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3",
  plugin:
    "M9 4h3v3a1.5 1.5 0 003 0V4h3a1 1 0 011 1v4h-3a1.5 1.5 0 000 3h3v7a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z",
  agent: "M12 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM5 20c.6-3.6 3.3-5.5 7-5.5s6.4 1.9 7 5.5",
  plan: "M9 6h11M9 12h11M9 18h11M3.5 6l1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2",
  subagent: "M6 4v8a4 4 0 004 4h4M6 4a2 2 0 100 .01M18 16a2 2 0 100 .01M6 12h8",
  mcp: "M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1",
};

/** Profession icons for the plugin visual, in the order of the `chips` front matter. */
const CHIP_ICONS = [
  "M2 9l10-5 10 5-10 5zM6 11.5V16c0 1.5 3 3 6 3s6-1.5 6-3v-4.5M22 9v6",
  "M6 3h9l4 4v14H6zM14 3v5h5M9 13l1.5 1.5L13 12M9 17.5h6",
  "M6 3h12v18H6zM9 7h6M9 11h.01M12 11h.01M15 11h.01M9 15h.01M12 15h.01M15 15h.01M9 18h.01M12 18h.01M15 18h.01",
  "M12 14a6 6 0 100-12 6 6 0 000 12zM8.5 13.5L7 22l5-3 5 3-1.5-8.5",
  "M12 6c-2-1.5-5-2-9-2v14c4 0 7 .5 9 2 2-1.5 5-2 9-2V4c-4 0-7 .5-9 2zM12 6v14",
  "M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z",
];
const WIND =
  "M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2M9.6 4.6A2 2 0 1 1 11 8H2M12.6 19.4A2 2 0 1 0 14 16H2";
/** Tile slots on a 300x230 grid: three rows on each side of the core. */
const TILE_X = [10, 10, 10, 212, 212, 212];
const TILE_Y = [10, 83, 156, 10, 83, 156];

const { frontmatter, lang } = useData();
const newTab = computed(() =>
  lang.value.startsWith("es") ? "se abre en una pestaña nueva" : "opens in a new tab",
);
/** Real plugin creator screenshot, in the page language (same capture as the plugin creator guide). */
const creatorShot = computed(() => (lang.value.startsWith("es") ? creatorShotEs : creatorShotEn));
const featured = computed<Feature[]>(() => (frontmatter.value.featured ?? []).slice(0, 3));
const more = computed<Feature[]>(() => frontmatter.value.more ?? []);
const heading = computed<string>(() => frontmatter.value.featuresHeading ?? "");
const moreHeading = computed<string>(() => frontmatter.value.moreHeading ?? "");

const root = ref<HTMLElement | null>(null);
const ready = ref(false);
const shown = ref(false);
let observer: IntersectionObserver | undefined;

const href = (link: string) => withBase(link);
const isExternal = (link: FeatureLink) => Boolean(link.external) || /^https?:\/\//.test(link.link);
const linkHref = (link: FeatureLink) => (isExternal(link) ? link.link : href(link.link));
const tileCx = (i: number) => TILE_X[i] + 39;
/** Connector from a tile's inner edge to the core centre (hidden behind the core). */
const connector = (i: number) => {
  const left = i < 3;
  const x = left ? 88 : 212;
  const y = TILE_Y[i] + 32;
  if (y === 115) return `M${x} 115H150`;
  return `M${x} ${y}C${left ? 124 : 176} ${y} 140 ${y < 115 ? 72 : 158} 150 115`;
};

let stopInView: (() => void) | undefined;
/** Plugin chips snap into the core when the visual scrolls into view (Motion, client-only). */
async function initPluginVisual() {
  const el = root.value?.querySelector<HTMLElement>(".visual-plugins");
  if (!el || prefersReducedMotion()) return;
  const { animate } = await loadMotion();
  if (!el.isConnected || prefersReducedMotion()) return;
  const tiles = [...el.querySelectorAll<SVGGElement>("[data-tile]")];
  const lines = [...el.querySelectorAll<SVGPathElement>("[data-line]")];
  const core = el.querySelector<SVGGElement>("[data-core]");
  // Hidden start state exists only now that the module is loaded and can reveal it.
  tiles.forEach((tile, i) => {
    tile.style.opacity = "0";
    tile.style.transform = `translateX(${i < 3 ? -22 : 22}px) scale(0.9)`;
  });
  for (const line of lines) line.style.opacity = "0";
  if (core) core.style.opacity = "0";
  const play = () => {
    const ease = [0.22, 0.8, 0.3, 1] as const;
    if (core) {
      animate(
        core,
        { opacity: [0, 1], transform: ["scale(0.8)", "scale(1)"] },
        { duration: 0.5, ease },
      );
    }
    tiles.forEach((tile, i) => {
      animate(
        tile,
        {
          opacity: [0, 1],
          transform: [`translateX(${i < 3 ? -22 : 22}px) scale(0.9)`, "translateX(0px) scale(1)"],
        },
        { duration: 0.55, delay: 0.15 + i * 0.09, ease },
      );
    });
    for (const line of lines) animate(line, { opacity: [0, 1] }, { duration: 0.6, delay: 0.5 });
  };
  const watcher = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      watcher.disconnect();
      play();
    },
    { threshold: 0.4 },
  );
  watcher.observe(el);
  stopInView = () => watcher.disconnect();
}
const iconPath = (name?: string) => ICONS[name ?? ""] ?? ICONS.api;

onMounted(() => {
  // Content is visible by default; the hidden start state is applied only once
  // JS can also reveal it, and never under reduced motion.
  const reduce = prefersReducedMotion();
  void initPluginVisual().catch(() => undefined);
  if (reduce || !("IntersectionObserver" in window) || !root.value) return;
  ready.value = true;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        shown.value = true;
        observer?.disconnect();
      }
    },
    { threshold: 0.08 },
  );
  observer.observe(root.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  stopInView?.();
});
</script>

<template>
  <section
    v-if="featured.length"
    ref="root"
    class="alisio-bento"
    :class="{ 'is-ready': ready, 'is-in': shown }"
    data-component="bento-features"
    aria-labelledby="alisio-bento-heading"
  >
    <h2 id="alisio-bento-heading" class="bento-heading">{{ heading }}</h2>

    <ul class="bento-featured">
      <li
        v-for="(item, i) in featured"
        :key="item.title"
        class="bento-item"
        :style="{ '--i': i }"
        :data-slot="i + 1"
      >
        <article class="feature-card">
          <div class="feature-copy"><div class="feature-head">
            <span class="icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="iconPath(item.icon)" /></svg>
            </span>
            <h3><a v-if="item.link" :href="href(item.link)" class="stretched">{{ item.title }}</a><template v-else>{{ item.title }}</template></h3></div>
            <p>{{ item.details }}</p>
            <ul v-if="item.links?.length" class="feature-links">
              <li v-for="(entry, n) in item.links" :key="entry.link">
                <a
                  class="feature-link"
                  :class="{ 'is-primary': n === 0 }"
                  :href="linkHref(entry)"
                  :target="isExternal(entry) ? '_blank' : undefined"
                  :rel="isExternal(entry) ? 'noopener' : undefined"
                >
                  {{ entry.text }}
                  <span v-if="isExternal(entry)" class="sr-only"> ({{ newTab }})</span>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="isExternal(entry) ? 'M7 17L17 7M8 7h9v9' : 'M5 12h14M13 6l6 6-6 6'" /></svg>
                </a>
              </li>
            </ul>
          </div>

          <div v-if="item.icon === 'terminal'" class="visual visual-terminal" aria-hidden="true">
            <pre><span class="dim">$</span> alisio
<span class="dim">  read </span> src/server.ts   <span class="ok">allowed</span>
<span class="dim">  edit </span> src/server.ts   <span class="ask">approve? [y/n]</span>
<span class="dim">  bash </span> pnpm test       <span class="ask">approve? [y/n]</span>

<span class="dim">$</span> alisio run --json "fix the tests"
<span class="dim">{"type":"tool_call","name":"edit"}</span>
<span class="dim">{"type":"tool_result","ok":true}</span></pre>
          </div>
          <div v-else-if="item.icon === 'browser'" class="visual visual-shot" aria-hidden="true">
            <img :src="withBase('/assets/alisio-harness-web-ui.webp')" alt="" width="1833" height="990" loading="lazy" decoding="async" />
          </div>
          <div v-else-if="item.icon === 'plugin' && item.chips?.length" class="visual visual-plugins" aria-hidden="true">
            <svg viewBox="0 0 300 230" focusable="false">
              <defs>
                <linearGradient id="alisio-core-fill" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="#60e0f9" />
                  <stop offset="1" stop-color="#01a5f7" />
                </linearGradient>
              </defs>
              <g class="plugin-lines">
                <path v-for="(_, i) in item.chips.slice(0, 6)" :key="i" data-line :d="connector(i)" />
              </g>
              <g data-core class="plugin-core">
                <circle class="plugin-core-ring" cx="150" cy="115" r="40" />
                <circle cx="150" cy="115" r="30" fill="url(#alisio-core-fill)" />
                <g transform="translate(130.5 95.5) scale(1.62)" fill="none" stroke="#031c36" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path :d="WIND" /></g>
              </g>
              <g v-for="(label, i) in item.chips.slice(0, 6)" :key="label" data-tile class="plugin-tile">
                <rect :x="TILE_X[i]" :y="TILE_Y[i]" width="78" height="64" rx="14" />
                <circle class="plugin-knob" :cx="i < 3 ? 88 : 212" :cy="TILE_Y[i] + 32" r="4" />
                <g :transform="`translate(${tileCx(i) - 12} ${TILE_Y[i] + 9})`" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="plugin-glyph"><path :d="CHIP_ICONS[i]" /></g>
                <text :x="tileCx(i)" :y="TILE_Y[i] + 51" text-anchor="middle">{{ label }}</text>
              </g>
            </svg>
          </div>
          <div v-else-if="item.icon === 'agent'" class="visual visual-shot visual-creator" aria-hidden="true">
            <img :src="creatorShot" alt="" width="1280" height="900" loading="lazy" decoding="async" />
          </div>
          <div v-else-if="item.icon === 'chart'" class="visual visual-shot" aria-hidden="true">
            <img :src="withBase('/assets/dashboard_charts_web_ui.webp')" alt="" width="1280" height="1000" loading="lazy" decoding="async" />
          </div>
        </article>
      </li>
    </ul>

    <template v-if="more.length">
      <h3 class="bento-more-heading">{{ moreHeading }}</h3>
      <ul class="bento-more">
        <li
          v-for="(item, i) in more"
          :key="item.link + item.title"
          class="bento-item"
          :style="{ '--i': Math.min(i, 9) + 3 }"
        >
          <article class="tile">
            <span class="icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="iconPath(item.icon)" /></svg>
            </span>
            <div class="tile-copy">
              <h4><a :href="href(item.link)" class="stretched">{{ item.title }}</a></h4>
              <p>{{ item.details }}</p>
            </div>
          </article>
        </li>
      </ul>
    </template>
  </section>
</template>
