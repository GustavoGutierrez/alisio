<script setup lang="ts">
import { useData } from "vitepress";
import { computed } from "vue";

/** Lead paragraph right after the hero; the copy lives in the home front matter (`intro`). */
const { frontmatter } = useData();
const intro = computed<string>(() => frontmatter.value.intro ?? "");
</script>

<template>
  <div v-if="intro" class="alisio-intro" data-component="home-intro">
    <svg class="intro-mark" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
      <path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2M9.6 4.6A2 2 0 1 1 11 8H2M12.6 19.4A2 2 0 1 0 14 16H2" />
    </svg>
    <p class="intro-lead">{{ intro }}</p>
  </div>
</template>
