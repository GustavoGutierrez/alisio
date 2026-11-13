<script setup lang="ts">
import { useData } from "vitepress";
import { computed } from "vue";

/** Lead paragraph right after the hero; the copy lives in the home front matter (`intro`). */
const { frontmatter } = useData();
const intro = computed<string>(() => frontmatter.value.intro ?? "");
</script>

<template>
  <div v-if="intro" class="alisio-intro" data-component="home-intro">
    <p class="intro-lead">{{ intro }}</p>
  </div>
</template>
