<script setup lang="ts">
import { useData } from "vitepress";
import { computed, onBeforeUnmount, ref } from "vue";

const PACKAGE = "@alisio/alisio-code";
const managers = [
  { id: "npm", command: `npm i -g ${PACKAGE}` },
  { id: "pnpm", command: `pnpm add -g ${PACKAGE}` },
  { id: "yarn", command: `yarn global add ${PACKAGE}` },
  { id: "bun", command: `bun add -g ${PACKAGE}` },
] as const;

const { lang } = useData();
const isSpanish = computed(() => lang.value.startsWith("es"));
const active = ref<(typeof managers)[number]["id"]>("npm");
const copied = ref(false);
const command = computed(() => managers.find((m) => m.id === active.value)!.command);
let resetTimer: ReturnType<typeof setTimeout> | undefined;

async function copy() {
  try {
    await navigator.clipboard.writeText(command.value);
    copied.value = true;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => (copied.value = false), 1600);
  } catch {
    copied.value = false;
  }
}

onBeforeUnmount(() => clearTimeout(resetTimer));
</script>

<template>
  <div data-component="hero-install">
    <div
      class="tabs"
      role="tablist"
      :aria-label="isSpanish ? 'Gestor de paquetes' : 'Package manager'"
    >
      <button
        v-for="m in managers"
        :key="m.id"
        type="button"
        role="tab"
        class="tab"
        :class="{ active: active === m.id }"
        :aria-selected="active === m.id"
        @click="active = m.id"
      >
        {{ m.id }}
      </button>
    </div>
    <div class="command" role="tabpanel">
      <code><span class="prompt" aria-hidden="true">$</span>{{ command }}</code>
      <button
        type="button"
        class="copy"
        :aria-label="isSpanish ? 'Copiar comando' : 'Copy command'"
        @click="copy"
      >
        {{ copied ? (isSpanish ? "Copiado" : "Copied") : isSpanish ? "Copiar" : "Copy" }}
      </button>
    </div>
  </div>
</template>

<style scoped>
[data-component="hero-install"] {
  margin-top: 24px;
  max-width: 520px;
  border: 1px solid rgba(133, 231, 251, 0.22);
  border-radius: 12px;
  background: rgba(2, 14, 28, 0.72);
  backdrop-filter: blur(6px);
  overflow: hidden;
}

.tabs {
  display: flex;
  gap: 2px;
  padding: 6px 8px 0;
  border-bottom: 1px solid rgba(133, 231, 251, 0.14);
}

.tab {
  padding: 6px 12px 8px;
  border-bottom: 2px solid transparent;
  color: var(--alisio-panel-text-muted, #9fb8cc);
  font-size: 13px;
  font-weight: 500;
  transition: color 0.2s, border-color 0.2s;
}

.tab:hover {
  color: var(--alisio-panel-text, #effcff);
}

.tab.active {
  color: var(--alisio-cyan-light);
  border-bottom-color: var(--alisio-sky);
}

.tab:focus-visible,
.copy:focus-visible {
  outline: 2px solid var(--alisio-focus);
  outline-offset: 2px;
}

.command {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 12px 12px 16px;
}

.command code {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  font-family: var(--vp-font-family-mono);
  font-size: 14px;
  color: var(--alisio-panel-text, #effcff);
  background: none;
  padding: 0;
  scrollbar-width: none;
}

.command code::-webkit-scrollbar {
  display: none;
}

.prompt {
  margin-right: 10px;
  color: var(--alisio-sky);
  user-select: none;
}

.copy {
  flex-shrink: 0;
  padding: 4px 10px;
  border: 1px solid rgba(133, 231, 251, 0.3);
  border-radius: 6px;
  color: var(--alisio-cyan-light);
  font-size: 12px;
  font-weight: 500;
  transition: background-color 0.2s;
}

.copy:hover {
  background: rgba(7, 196, 249, 0.12);
}

@media (max-width: 959px) {
  [data-component="hero-install"] {
    margin-inline: auto;
  }
}

@media (max-width: 479px) {
  .command code {
    font-size: 12.5px;
  }
}
</style>
