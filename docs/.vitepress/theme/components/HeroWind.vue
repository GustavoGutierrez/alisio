<script setup lang="ts">
/**
 * The trade wind under the hero headline: thin, tapered streamlines of varied length, weight and
 * opacity, with one small eddy, drawn in the same cyan as the mascot's streaks. A faint full
 * stroke stays put (the static version, also used under reduced motion); a short gust travels
 * along each line, east to west like the alisios, at slightly different speeds. Both ends of every
 * line fade out through a mask, so the strokes taper instead of stopping. Decorative only.
 * The CSS (home.css) runs the gusts only while the hero is on screen (`data-wind-on`).
 */
const LINES = [
  { d: "M8 30C70 18 128 40 196 28S318 14 392 26", w: 1.6, o: 0.85, dur: 7.5 },
  { d: "M40 44C104 36 160 52 228 42S332 32 372 38", w: 1.1, o: 0.6, dur: 9.5 },
  { d: "M70 16C120 8 168 22 222 14S300 6 338 12", w: 0.9, o: 0.45, dur: 11 },
  { d: "M120 54C168 50 214 60 262 54", w: 0.8, o: 0.35, dur: 8.5 },
];
/** A small curl where the strongest line lifts: the eddy the breeze leaves behind. */
const EDDY = "M196 28c14-4 26-2 28 6s-8 12-15 8-4-12 5-12";
</script>

<template>
  <div class="hero-wind" aria-hidden="true">
    <svg viewBox="0 0 400 64" width="400" height="64" fill="none" focusable="false">
      <defs>
        <linearGradient id="alisio-hw-taper" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="400" y2="0">
          <stop offset="0" stop-color="#fff" stop-opacity="0" />
          <stop offset="0.22" stop-color="#fff" />
          <stop offset="0.78" stop-color="#fff" />
          <stop offset="1" stop-color="#fff" stop-opacity="0" />
        </linearGradient>
        <mask id="alisio-hw-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="400" height="64">
          <rect width="400" height="64" fill="url(#alisio-hw-taper)" />
        </mask>
      </defs>
      <g mask="url(#alisio-hw-mask)" stroke="currentColor" stroke-linecap="round">
        <g class="hero-wind-base">
          <path v-for="(line, i) in LINES" :key="`b${i}`" :d="line.d" :stroke-width="line.w" :stroke-opacity="line.o * 0.45" />
          <path :d="EDDY" stroke-width="1" stroke-opacity="0.4" />
        </g>
        <g class="hero-wind-gusts">
          <path
            v-for="(line, i) in LINES"
            :key="`g${i}`"
            :d="line.d"
            pathLength="100"
            :stroke-width="line.w + 0.4"
            :stroke-opacity="line.o"
            :style="{ '--gust-dur': `${line.dur}s`, '--gust-delay': `${-i * 1.7}s` }"
          />
        </g>
      </g>
    </svg>
  </div>
</template>
