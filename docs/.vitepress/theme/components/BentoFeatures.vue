<script setup lang="ts">
import { useData, withBase } from "vitepress";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

interface Feature {
  icon?: string;
  title: string;
  details: string;
  link: string;
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

const { frontmatter } = useData();
const featured = computed<Feature[]>(() => (frontmatter.value.featured ?? []).slice(0, 3));
const more = computed<Feature[]>(() => frontmatter.value.more ?? []);
const heading = computed<string>(() => frontmatter.value.featuresHeading ?? "");
const moreHeading = computed<string>(() => frontmatter.value.moreHeading ?? "");

const root = ref<HTMLElement | null>(null);
const ready = ref(false);
const shown = ref(false);
let observer: IntersectionObserver | undefined;

const href = (link: string) => withBase(link);
const iconPath = (name?: string) => ICONS[name ?? ""] ?? ICONS.api;

onMounted(() => {
  // Content is visible by default; the hidden start state is applied only once
  // JS can also reveal it, and never under reduced motion.
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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

onBeforeUnmount(() => observer?.disconnect());
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
        :key="item.link"
        class="bento-item"
        :style="{ '--i': i }"
        :data-slot="i + 1"
      >
        <article class="feature-card">
          <div class="feature-copy"><div class="feature-head">
            <span class="icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="iconPath(item.icon)" /></svg>
            </span>
            <h3><a :href="href(item.link)" class="stretched">{{ item.title }}</a></h3></div>
            <p>{{ item.details }}</p>
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
