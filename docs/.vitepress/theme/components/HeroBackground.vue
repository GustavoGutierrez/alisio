<script setup lang="ts">
import { withBase } from "vitepress";
import { onMounted, ref } from "vue";

/**
 * Decorative background for the docs home hero: a looping, muted winds video with no controls,
 * teleported into `.VPHero` so it fills the section behind the content. A static image and the
 * overlay keep the artwork without JS and under `prefers-reduced-motion`.
 */
const video = ref<HTMLVideoElement>();

onMounted(() => {
  const el = video.value;
  if (!el) return;
  // Reduced motion: the CSS hides the video, so never start it.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  el.muted = true;
  // Autoplay can still be rejected (battery saver, strict policies): keep the poster frame.
  void el.play().catch(() => undefined);
});
</script>

<template>
  <Teleport to=".VPHome .VPHero" defer>
    <video
      ref="video"
      class="alisio-hero-video"
      :src="withBase('/assets/alisio-winds-720p.webm')"
      :poster="withBase('/assets/background-box.jpg')"
      autoplay
      loop
      muted
      playsinline
      preload="auto"
      aria-hidden="true"
      tabindex="-1"
    />
  </Teleport>
</template>
