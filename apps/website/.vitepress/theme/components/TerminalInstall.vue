<script setup lang="ts">
import { useData, withBase } from "vitepress";
import { computed, onBeforeUnmount, ref } from "vue";

/** Developer install from the terminal, shown in the home "For developers" section. */
const PACKAGE = "@alisio/alisio-code";
const MANAGERS = [
  { id: "npm", command: `npm i -g ${PACKAGE}` },
  { id: "pnpm", command: `pnpm add -g ${PACKAGE}` },
  { id: "yarn", command: `yarn global add ${PACKAGE}` },
  { id: "bun", command: `bun add -g ${PACKAGE}` },
] as const;

const { lang } = useData();
const es = computed(() => lang.value.startsWith("es"));
const base = computed(() => (es.value ? "/es" : ""));

const copy = computed(() =>
  es.value
    ? {
        heading: "Úsalo desde la terminal",
        lead: "Requiere Node.js 22.16 o superior",
        managerLabel: "Gestor de paquetes",
        copy: "Copiar",
        copied: "Copiado",
        copyLabel: "Copiar comando",
        followUp: "Después de instalar",
        tui: "Interfaz de terminal",
        serve: "Interfaz web",
        run: "Sin interfaz, para scripts y CI",
        runPrompt: "Explica este repositorio",
        docs: ["Instalación", "Inicio rápido"],
      }
    : {
        heading: "Use it from the terminal",
        lead: "Requires Node.js 22.16 or later",
        managerLabel: "Package manager",
        copy: "Copy",
        copied: "Copied",
        copyLabel: "Copy command",
        followUp: "After installing",
        tui: "Terminal UI",
        serve: "Web UI",
        run: "Headless, for scripts and CI",
        runPrompt: "Explain this repository",
        docs: ["Installation", "Quick start"],
      },
);

const active = ref<(typeof MANAGERS)[number]["id"]>("npm");
const copied = ref(false);
const tabs = ref<HTMLButtonElement[]>([]);
const command = computed(() => MANAGERS.find((m) => m.id === active.value)?.command ?? "");
let resetTimer: ReturnType<typeof setTimeout> | undefined;

async function copyCommand(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      copied.value = false;
    }, 1600);
  } catch {
    copied.value = false;
  }
}

function onTabKey(e: KeyboardEvent, index: number) {
  const last = MANAGERS.length - 1;
  let next = index;
  if (e.key === "ArrowRight") next = index === last ? 0 : index + 1;
  else if (e.key === "ArrowLeft") next = index === 0 ? last : index - 1;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = last;
  else return;
  e.preventDefault();
  active.value = MANAGERS[next].id;
  tabs.value[next]?.focus();
}

const followUps = computed(() => [
  { label: copy.value.tui, command: "alisio" },
  { label: copy.value.serve, command: "alisio serve" },
  { label: copy.value.run, command: `alisio run "${copy.value.runPrompt}"` },
]);

onBeforeUnmount(() => clearTimeout(resetTimer));
</script>

<template>
  <div class="ti" aria-labelledby="alisio-terminal-heading" role="group" data-component="terminal-install">
    <h3 id="alisio-terminal-heading" class="ti-heading">{{ copy.heading }}</h3>
    <p class="ti-lead">{{ copy.lead }}</p>

    <div class="ti-box">
      <div class="ti-tabs" role="tablist" :aria-label="copy.managerLabel">
        <button
          v-for="(m, i) in MANAGERS"
          :id="`alisio-tab-${m.id}`"
          :key="m.id"
          :ref="(el) => { if (el) tabs[i] = el as HTMLButtonElement }"
          type="button"
          role="tab"
          class="ti-tab"
          :class="{ active: active === m.id }"
          :aria-selected="active === m.id ? 'true' : 'false'"
          aria-controls="alisio-install-panel"
          :tabindex="active === m.id ? 0 : -1"
          @click="active = m.id"
          @keydown="onTabKey($event, i)"
        >{{ m.id }}</button>
      </div>
      <div id="alisio-install-panel" class="ti-cmd" role="tabpanel" :aria-labelledby="`alisio-tab-${active}`">
        <code><span class="ti-prompt" aria-hidden="true">$</span>{{ command }}</code>
        <button type="button" class="ti-copy" :aria-label="copy.copyLabel" @click="copyCommand(command)">
          {{ copied ? copy.copied : copy.copy }}
        </button>
      </div>
      <p class="ti-box-title">{{ copy.followUp }}</p>
      <ul class="ti-follow">
        <li v-for="c in followUps" :key="c.command">
          <code><span class="ti-prompt" aria-hidden="true">$</span>{{ c.command }}</code>
          <span class="ti-follow-label">{{ c.label }}</span>
        </li>
      </ul>
    </div>

    <p class="ti-meta">
      <a :href="withBase(`${base}/installation`)">{{ copy.docs[0] }}</a>
      <span aria-hidden="true"> · </span>
      <a :href="withBase(`${base}/quick-start`)">{{ copy.docs[1] }}</a>
    </p>
  </div>
</template>

<style scoped>
.ti-heading {
  margin: 0 0 4px;
  padding: 0;
  border: 0;
}

.ti-lead {
  margin: 0 0 16px;
  color: var(--vp-c-text-2);
}

.ti-box {
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-code-block-bg);
  overflow: hidden;
}

.ti-tabs {
  display: flex;
  gap: 2px;
  padding: 4px 8px 0;
  border-bottom: 1px solid var(--vp-c-divider);
}

.ti-tab {
  min-height: 40px;
  padding: 0 12px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--vp-c-text-2);
  font-family: var(--vp-font-family-mono);
  font-size: 0.8125rem;
  cursor: pointer;
}

.ti-tab:hover {
  color: var(--vp-c-text-1);
}

.ti-tab.active {
  color: var(--vp-c-text-1);
  border-bottom-color: var(--alisio-action);
}

.ti-cmd {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px 10px 16px;
}

.ti-box code {
  min-width: 0;
  overflow-x: auto;
  background: none;
  padding: 0;
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  font-size: 0.875rem;
  white-space: nowrap;
  scrollbar-width: none;
}

.ti-cmd code {
  flex: 1;
}

.ti-prompt {
  margin-right: 10px;
  color: var(--vp-c-text-3);
  user-select: none;
}

.ti-copy {
  flex: none;
  min-height: 40px;
  min-width: 64px;
  padding: 0 12px;
  border: 1px solid var(--vp-c-border);
  border-radius: 8px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 0.875rem;
  font-weight: 700;
  cursor: pointer;
}

.ti-copy:hover {
  border-color: var(--vp-c-brand-1);
}

.ti-tab:focus-visible,
.ti-copy:focus-visible,
.ti-meta a:focus-visible {
  outline: 2px solid var(--alisio-focus-ring);
  outline-offset: 2px;
}

.ti-box-title {
  margin: 0;
  padding: 10px 16px 4px;
  border-top: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
  font-size: 0.8125rem;
  font-weight: 700;
}

.ti-follow {
  margin: 0;
  padding: 0 0 8px;
  list-style: none;
}

.ti-follow li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin: 0;
  padding: 6px 16px;
}

.ti-follow-label {
  flex: none;
  color: var(--vp-c-text-2);
  font-size: 0.8125rem;
  text-align: right;
}

.ti-meta {
  margin: 12px 0 0;
  font-size: 0.9375rem;
}

@media (max-width: 640px) {
  .ti-follow li {
    flex-direction: column;
    gap: 2px;
  }

  .ti-follow-label {
    text-align: left;
  }
}
</style>
