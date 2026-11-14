<script setup lang="ts">
import { useData } from "vitepress";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { prefersReducedMotion } from "../motion";
import { playWindGust } from "../wind-sound";

/**
 * Home showcase carousel (WAI-ARIA carousel pattern). Slide texts live in each page's front matter
 * (`showcase.slides`), so EN and ES keep their own copy; each slide names a screenshot pair under
 * apps/website/assets/web-ui/ (`showcase_<image>_web_ui.webp` plus a `_small` variant for narrow screens).
 *
 * Autoplay advances every DWELL ms and pauses while the pointer is over the carousel, while focus is
 * inside it, while it is off screen, while the tab is hidden and while the lightbox is open; it
 * resumes RESUME ms after the last reason clears. The visible pause/play button stops it for good
 * (WCAG 2.2.2). Under reduced motion it never autoplays and slides switch without a transition.
 */
interface Slide {
  image: string;
  title: string;
  description: string;
  alt: string;
}

const DWELL = 6500;
const RESUME = 1200;
const SWIPE = 40;

const large = import.meta.glob<string>("../../../assets/web-ui/showcase_*_web_ui.webp", {
  eager: true,
  import: "default",
});
const small = import.meta.glob<string>("../../../assets/web-ui/showcase_*_web_ui_small.webp", {
  eager: true,
  import: "default",
});
const src = (image: string, variant: "large" | "small") =>
  (variant === "large" ? large : small)[
    `../../../assets/web-ui/showcase_${image}_web_ui${variant === "small" ? "_small" : ""}.webp`
  ] ?? "";

const { frontmatter, lang } = useData();
const slides = computed<Slide[]>(() => frontmatter.value.showcase?.slides ?? []);
const label = computed<string>(() => frontmatter.value.showcase?.label ?? "");
const es = computed(() => lang.value.startsWith("es"));
const t = computed(() =>
  es.value
    ? {
        prev: "Captura anterior",
        next: "Captura siguiente",
        pause: "Pausar el pase de capturas",
        play: "Reanudar el pase de capturas",
        expand: "Ver esta captura en grande",
        close: "Cerrar",
        goTo: (n: number, title: string) => `Captura ${n}: ${title}`,
        of: (n: number, total: number) => `${n} de ${total}`,
      }
    : {
        prev: "Previous screenshot",
        next: "Next screenshot",
        pause: "Pause the screenshot slideshow",
        play: "Resume the screenshot slideshow",
        expand: "View this screenshot larger",
        close: "Close",
        goTo: (n: number, title: string) => `Screenshot ${n}: ${title}`,
        of: (n: number, total: number) => `${n} of ${total}`,
      },
);

const index = ref(0);
/** The slide on its way out (-1 when none) and a counter that replays the wind gust overlay. */
const leaving = ref(-1);
const gust = ref(0);
let leaveTimer: ReturnType<typeof setTimeout> | undefined;
/** The user's choice: false after pressing pause (or under reduced motion). */
const playing = ref(true);
/** True once the user moved the carousel themselves: announce slides politely from then on. */
const userDriven = ref(false);
/** Images get a src once they are current, next in line or already seen (first one eagerly). */
const loaded = ref<Set<number>>(new Set([0, 1]));

const hovering = ref(false);
const focused = ref(false);
const visible = ref(false);
const tabHidden = ref(false);

const root = ref<HTMLElement | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let observer: IntersectionObserver | undefined;

const held = computed(() => hovering.value || focused.value || !visible.value || tabHidden.value);
const autoplaying = computed(() => playing.value && !held.value);

function show(next: number, byUser = false) {
  const total = slides.value.length;
  if (!total) return;
  const target = (next + total) % total;
  if (target === index.value) return;
  leaving.value = index.value;
  index.value = target;
  gust.value += 1;
  clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => {
    leaving.value = -1;
  }, 1000);
  const ahead = (index.value + 1) % total;
  loaded.value = new Set([...loaded.value, index.value, ahead]);
  if (byUser) userDriven.value = true;
}

function schedule(delay: number) {
  clearTimeout(timer);
  if (!autoplaying.value) return;
  timer = setTimeout(() => {
    // The lightbox (whatis.ts) locks the page while open: wait instead of advancing under it.
    if (document.documentElement.classList.contains("whatis-locked")) {
      schedule(RESUME);
      return;
    }
    show(index.value + 1);
    schedule(DWELL);
  }, delay);
}

// Any pause reason clearing (or the user pressing play) resumes after a short beat.
// The first start waits a full dwell, so the opening slide is read before anything moves.
let started = false;
watch(autoplaying, (on, was) => {
  if (on && !was) {
    schedule(started ? RESUME : DWELL);
    started = true;
  } else if (!on) clearTimeout(timer);
});

function go(next: number) {
  show(next, true);
  schedule(DWELL);
}

/** The previous/next buttons, and only they, also play a short wind gust (never on autoplay). */
function step(delta: 1 | -1) {
  playWindGust(delta === 1 ? "forward" : "back");
  go(index.value + delta);
}

function togglePlay() {
  playing.value = !playing.value;
  userDriven.value = true;
}

function onKey(event: KeyboardEvent) {
  if (event.key === "ArrowRight") go(index.value + 1);
  else if (event.key === "ArrowLeft") go(index.value - 1);
  else return;
  event.preventDefault();
}

let startX: number | undefined;
function onPointerDown(event: PointerEvent) {
  startX = event.pointerType === "mouse" ? undefined : event.clientX;
}
function onPointerUp(event: PointerEvent) {
  if (startX === undefined) return;
  const dx = event.clientX - startX;
  startX = undefined;
  if (Math.abs(dx) < SWIPE) return;
  go(index.value + (dx < 0 ? 1 : -1));
}

function onFocusOut(event: FocusEvent) {
  const to = event.relatedTarget as Node | null;
  if (!to || !root.value?.contains(to)) focused.value = false;
}

const onVisibility = () => {
  tabHidden.value = document.visibilityState === "hidden";
};

onMounted(() => {
  if (prefersReducedMotion()) playing.value = false;
  onVisibility();
  document.addEventListener("visibilitychange", onVisibility);
  if ("IntersectionObserver" in window && root.value) {
    observer = new IntersectionObserver(
      (entries) => {
        visible.value = entries.some((entry) => entry.isIntersecting);
      },
      { threshold: 0.35 },
    );
    observer.observe(root.value);
  } else {
    visible.value = true;
  }
});

onBeforeUnmount(() => {
  clearTimeout(timer);
  clearTimeout(leaveTimer);
  observer?.disconnect();
  document.removeEventListener("visibilitychange", onVisibility);
});

const current = computed(() => slides.value[index.value]);
</script>

<template>
  <section
    v-if="slides.length"
    ref="root"
    class="showcase"
    :class="{ 'is-user': userDriven }"
    aria-roledescription="carousel"
    :aria-label="label"
    data-component="showcase-slider"
    @mouseenter="hovering = true"
    @mouseleave="hovering = false"
    @focusin="focused = true"
    @focusout="onFocusOut"
    @keydown="onKey"
  >
    <div class="showcase-frame shot-frame home-frame" @pointerdown="onPointerDown" @pointerup="onPointerUp">
      <div class="showcase-slides" :aria-live="autoplaying ? 'off' : 'polite'">
        <div
          v-for="(slide, i) in slides"
          :key="slide.image"
          class="showcase-slide"
          :class="{ 'is-active': i === index, 'is-leaving': i === leaving }"
          role="group"
          aria-roledescription="slide"
          :aria-label="t.of(i + 1, slides.length)"
          :aria-hidden="i === index ? undefined : 'true'"
          :inert="i === index ? undefined : true"
        >
          <img
            :src="loaded.has(i) ? src(slide.image, 'large') : undefined"
            :srcset="loaded.has(i) ? `${src(slide.image, 'small')} 810w, ${src(slide.image, 'large')} 1620w` : undefined"
            sizes="(max-width: 700px) 100vw, 1152px"
            :data-full="src(slide.image, 'large')"
            :data-active="i === index ? '' : undefined"
            :alt="slide.alt"
            width="1620"
            height="900"
            :loading="i === 0 ? 'eager' : 'lazy'"
            decoding="async"
          />
          <p class="visually-hidden">{{ slide.title }}. {{ slide.description }}</p>
        </div>
      </div>
      <div v-if="gust" :key="gust" class="showcase-gust" aria-hidden="true">
        <svg viewBox="0 0 400 240" preserveAspectRatio="none" fill="none" focusable="false">
          <path d="M0 62C90 44 170 80 260 60S360 44 400 54" stroke-width="1.6" />
          <path d="M0 118C110 104 190 134 280 116S370 104 400 112" stroke-width="1.1" />
          <path d="M40 168C120 156 200 184 300 166S380 158 400 162" stroke-width="1.4" />
          <path d="M0 204C90 196 180 214 250 204" stroke-width="0.9" />
        </svg>
      </div>
      <button
        type="button"
        class="media-btn media-expand"
        data-expand="image"
        hidden
        :data-label-close="t.close"
        :data-title="current?.title"
        :aria-label="t.expand"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg>
      </button>
    </div>

    <div class="showcase-bar">
      <div class="showcase-captions" aria-hidden="true">
        <div v-for="(slide, i) in slides" :key="slide.image" class="showcase-caption" :class="{ 'is-active': i === index }">
          <p class="showcase-title">{{ slide.title }}</p>
          <p class="showcase-text">{{ slide.description }}</p>
        </div>
      </div>

      <div class="showcase-controls">
        <button type="button" class="showcase-btn" :aria-label="playing ? t.pause : t.play" @click="togglePlay">
          <svg v-if="playing" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5v14M16 5v14" /></svg>
          <svg v-else viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path class="fill" d="M8 5l11 7-11 7z" /></svg>
        </button>
        <button type="button" class="showcase-btn" :aria-label="t.prev" @click="step(-1)">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        <div class="showcase-dots">
          <button
            v-for="(slide, i) in slides"
            :key="slide.image"
            type="button"
            class="showcase-dot"
            :aria-label="t.goTo(i + 1, slide.title)"
            :aria-current="i === index ? 'true' : undefined"
            @click="go(i)"
          ><span aria-hidden="true" /></button>
        </div>
        <button type="button" class="showcase-btn" :aria-label="t.next" @click="step(1)">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.showcase {
  margin-top: 32px;
}

.showcase-frame {
  touch-action: pan-y;
  isolation: isolate;
}

/* The expand button stays above the slides and the gust overlay. */
.showcase-frame .media-expand {
  z-index: 4;
}

/* Every slide shares one cell, so the frame keeps the screenshots' 9:5 ratio with no layout shift. */
.showcase-slides {
  display: grid;
  aspect-ratio: 1620 / 900;
}

/* Slides at rest are hidden with no transition; only the incoming and the outgoing slide move. */
.showcase-slide {
  grid-area: 1 / 1;
  opacity: 0;
  pointer-events: none;
}

/* The change is a gust from the east: the outgoing screenshot is blown west, softening slightly as
   it goes; the incoming one is carried in from the east and settles (eased deceleration). Only
   transform, opacity and a bounded blur, on promoted layers. */
.showcase-slide.is-leaving {
  z-index: 1;
  will-change: transform, opacity, filter;
  animation: showcase-out 0.75s cubic-bezier(0.55, 0, 0.75, 0.4) both;
}

.showcase-slide.is-active {
  z-index: 2;
  opacity: 1;
  pointer-events: auto;
}

.showcase-slides:has(.is-leaving) .showcase-slide.is-active {
  will-change: transform, opacity, filter;
  animation: showcase-in 0.95s cubic-bezier(0.16, 1, 0.3, 1) both;
}

@keyframes showcase-out {
  from {
    opacity: 1;
    transform: translateX(0);
    filter: blur(0);
  }
  to {
    opacity: 0;
    transform: translateX(-7%);
    filter: blur(2px);
  }
}

@keyframes showcase-in {
  0% {
    opacity: 0;
    transform: translateX(8%);
    filter: blur(2px);
  }
  60% {
    filter: blur(0);
  }
  100% {
    opacity: 1;
    transform: none;
    filter: blur(0);
  }
}

/* Thin cyan streaks cross the frame east to west during the change (the HeroWind style). */
.showcase-gust {
  position: absolute;
  inset: 0;
  z-index: 3;
  overflow: hidden;
  pointer-events: none;
}

.showcase-gust svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  stroke: var(--alisio-cyan);
  stroke-linecap: round;
  opacity: 0;
  animation: showcase-gust 1s cubic-bezier(0.33, 0, 0.25, 1) both;
}

.showcase-gust path {
  vector-effect: non-scaling-stroke;
  stroke-dasharray: 160 400;
}

@keyframes showcase-gust {
  0% {
    opacity: 0;
    transform: translateX(60%);
  }
  30% {
    opacity: 0.75;
  }
  100% {
    opacity: 0;
    transform: translateX(-60%);
  }
}

.showcase-slide img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  cursor: zoom-in;
}

.showcase-bar {
  display: grid;
  gap: 16px;
  align-items: start;
  margin-top: 18px;
}

/* Captions share one cell too: the bar is as tall as the longest caption, so nothing jumps. */
.showcase-captions {
  display: grid;
}

.showcase-caption {
  grid-area: 1 / 1;
  visibility: hidden;
  opacity: 0;
}

/* The caption follows the image in: a short fade with a small drift from the east. */
.showcase-caption.is-active {
  visibility: visible;
  opacity: 1;
  animation: showcase-caption 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.15s both;
}

@keyframes showcase-caption {
  from {
    opacity: 0;
    transform: translateX(12px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.vp-doc .showcase-title {
  margin: 0 0 4px;
  color: var(--vp-c-text-1);
  font-family: var(--alisio-font-display);
  font-size: 1.1875rem;
  font-weight: 700;
  line-height: 1.3;
}

.vp-doc .showcase-text {
  margin: 0;
  max-width: 62ch;
  color: var(--vp-c-text-2);
  font-size: 1rem;
  line-height: 1.55;
}

.showcase-controls {
  display: flex;
  align-items: center;
  gap: 4px;
}

.showcase-btn {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: 1px solid var(--vp-c-border);
  border-radius: 999px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  cursor: pointer;
  transition: border-color 0.2s ease;
}

.showcase-btn:hover {
  border-color: var(--vp-c-brand-1);
}

.showcase-btn svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.showcase-btn svg .fill {
  fill: currentColor;
  stroke-width: 1.5;
}

.showcase-dots {
  display: flex;
  align-items: center;
}

/* 24px hit targets around small dots; the current one stretches into a short bar. */
.showcase-dot {
  display: grid;
  place-items: center;
  width: 24px;
  height: 40px;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
}

.showcase-dot span {
  display: block;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--vp-c-border);
  transition:
    transform 0.3s ease,
    background-color 0.3s ease;
}

.showcase-dot:hover span {
  background: var(--vp-c-text-3);
}

.showcase-dot[aria-current="true"] span {
  transform: scaleX(2.5);
  background: var(--alisio-action);
}

.showcase-btn:focus-visible,
.showcase-dot:focus-visible {
  outline: 2px solid var(--alisio-focus-ring);
  outline-offset: 2px;
}

@media (min-width: 768px) {
  .showcase-bar {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 32px;
  }
}

@media (max-width: 420px) {
  .showcase-dot {
    width: 20px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .showcase-slide.is-leaving,
  .showcase-slides:has(.is-leaving) .showcase-slide.is-active,
  .showcase-caption.is-active {
    animation: none;
  }

  .showcase-slide.is-leaving {
    opacity: 0;
  }

  .showcase-gust {
    display: none;
  }
}
</style>
