<script setup lang="ts">
import { useData, withBase } from "vitepress";
import { computed, onMounted, ref } from "vue";
import {
  DESKTOP_ASSETS,
  DESKTOP_RELEASE_URL,
  DESKTOP_VERSION,
  type DesktopOs,
  detectDesktopOs,
} from "../desktop-release";

const { lang } = useData();
const es = computed(() => lang.value.startsWith("es"));
const base = computed(() => (es.value ? "/es" : ""));
const detected = ref<DesktopOs | undefined>();

// Client-only guess; the server render lists every OS without a highlight.
onMounted(() => {
  detected.value = detectDesktopOs(navigator.userAgent);
});

const copy = computed(() =>
  es.value
    ? {
        heading: "Descarga Alisio Desktop",
        lead: `Versión ${DESKTOP_VERSION}. Instálalo como cualquier otro programa, sin terminal.`,
        suggested: "Recomendado para tu sistema",
        release: "Ver todos los archivos de la versión",
        firstLaunch: "Las apps no están firmadas: el primer arranque pide un paso extra.",
        firstLaunchLink: "Cómo abrirlas en Windows y macOS",
        devHeading: "Para desarrolladores: úsalo desde la terminal",
        devLead: "Necesitas Node.js 22.16 o superior.",
        install: "Instala la CLI",
        tui: "Interfaz de terminal (TUI)",
        serve: "Interfaz web en el navegador",
        run: "Ejecución sin interfaz, para scripts y CI",
        runPrompt: "Explica este repositorio",
        docs: ["Instalación", "Inicio rápido"],
        os: {
          "windows-x64": ["Windows 10/11 (x64)", "Instalador (.exe)"],
          "macos-arm64": ["macOS Apple Silicon (arm64)", "Imagen de disco (.dmg)"],
          "macos-x64": ["macOS Intel (x64)", "Imagen de disco (.dmg)"],
          "linux-appimage": ["Linux, cualquier distribución", "AppImage (x86_64)"],
          "linux-deb": ["Debian y Ubuntu", "Paquete .deb (amd64)"],
        } as Record<string, [string, string]>,
      }
    : {
        heading: "Download Alisio Desktop",
        lead: `Version ${DESKTOP_VERSION}. Install it like any other program, no terminal needed.`,
        suggested: "Suggested for your system",
        release: "See all files for this release",
        firstLaunch: "The apps are not signed, so the first launch needs one extra step.",
        firstLaunchLink: "How to open them on Windows and macOS",
        devHeading: "For developers: use it from the terminal",
        devLead: "You need Node.js 22.16 or newer.",
        install: "Install the CLI",
        tui: "Terminal UI (TUI)",
        serve: "Web UI in your browser",
        run: "Headless run, for scripts and CI",
        runPrompt: "Explain this repository",
        docs: ["Installation", "Quick start"],
        os: {
          "windows-x64": ["Windows 10/11 (x64)", "Installer (.exe)"],
          "macos-arm64": ["macOS Apple Silicon (arm64)", "Disk image (.dmg)"],
          "macos-x64": ["macOS Intel (x64)", "Disk image (.dmg)"],
          "linux-appimage": ["Linux, any distribution", "AppImage (x86_64)"],
          "linux-deb": ["Debian and Ubuntu", "Package .deb (amd64)"],
        } as Record<string, [string, string]>,
      },
);

const items = computed(() =>
  DESKTOP_ASSETS.map((a) => {
    const labels = copy.value.os[a.id] ?? [a.file, ""];
    return {
      ...a,
      title: labels[0],
      kind: labels[1],
      suggested: detected.value === a.os,
    };
  }),
);

const cliCommands = computed(() => [
  { label: copy.value.install, command: "npm install -g @alisio/alisio-code" },
  { label: copy.value.tui, command: "alisio" },
  { label: copy.value.serve, command: "alisio serve" },
  { label: copy.value.run, command: `alisio run "${copy.value.runPrompt}" --read-only` },
]);
</script>

<template>
  <div class="alisio-downloads">
    <section id="download" class="dl-section" aria-labelledby="alisio-download-heading" data-component="desktop-downloads">
      <h2 id="alisio-download-heading" class="dl-heading">{{ copy.heading }}</h2>
      <p class="dl-lead">{{ copy.lead }}</p>
      <ul class="dl-grid">
        <li v-for="item in items" :key="item.id" class="dl-card" :class="{ 'is-suggested': item.suggested }">
          <span v-if="item.suggested" class="dl-badge">{{ copy.suggested }}</span>
          <span class="dl-os">{{ item.title }}</span>
          <span class="dl-kind">{{ item.kind }}</span>
          <a class="dl-button" :href="item.url" :aria-label="`${copy.heading}: ${item.title}, ${item.kind}`" rel="noopener">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 4v11M7 11l5 5 5-5M5 20h14" /></svg>
            <span class="dl-file">{{ item.file }}</span>
          </a>
        </li>
      </ul>
      <p class="dl-note">
        <a :href="DESKTOP_RELEASE_URL" rel="noopener">{{ copy.release }}</a>
        <span aria-hidden="true"> · </span>
        {{ copy.firstLaunch }}
        <a :href="withBase(`${base}/desktop#unsigned`)">{{ copy.firstLaunchLink }}</a>
      </p>
    </section>

    <section class="dl-section dl-dev" aria-labelledby="alisio-terminal-heading" data-component="terminal-install">
      <h2 id="alisio-terminal-heading" class="dl-heading dl-heading-sm">{{ copy.devHeading }}</h2>
      <p class="dl-lead">{{ copy.devLead }}</p>
      <ul class="dl-cmds">
        <li v-for="c in cliCommands" :key="c.command">
          <span class="dl-cmd-label">{{ c.label }}</span>
          <code>{{ c.command }}</code>
        </li>
      </ul>
      <p class="dl-note">
        <a :href="withBase(`${base}/installation`)">{{ copy.docs[0] }}</a>
        <span aria-hidden="true"> · </span>
        <a :href="withBase(`${base}/quick-start`)">{{ copy.docs[1] }}</a>
      </p>
    </section>
  </div>
</template>

<style scoped>
.alisio-downloads {
  max-width: 1152px;
  margin: 0 auto;
  padding: 40px 24px 0;
  color: var(--vp-c-text-1);
}

.dl-section {
  scroll-margin-top: calc(var(--vp-nav-height, 64px) + 16px);
}

.dl-dev {
  margin-top: 40px;
}

.dl-heading {
  margin: 0 0 8px;
  padding: 0;
  border: 0;
  font-size: 1.625rem;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.01em;
}

.dl-heading-sm {
  font-size: 1.25rem;
}

.dl-lead {
  margin: 0 0 20px;
  color: var(--vp-c-text-2);
}

.dl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 16px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.dl-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  background: var(--vp-c-bg-soft);
}

.dl-card.is-suggested {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 0 0 1px var(--vp-c-brand-1);
}

.dl-badge {
  align-self: flex-start;
  margin-bottom: 4px;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-size: 0.75rem;
  font-weight: 600;
}

.dl-os {
  font-size: 1.0625rem;
  font-weight: 700;
}

.dl-kind {
  margin-bottom: 12px;
  color: var(--vp-c-text-2);
  font-size: 0.875rem;
}

.dl-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: auto;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--vp-button-brand-bg);
  color: var(--vp-button-brand-text);
  font-size: 0.8125rem;
  font-weight: 600;
  text-decoration: none;
  overflow-wrap: anywhere;
}

.dl-button svg {
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.dl-button:hover {
  background: var(--vp-button-brand-hover-bg);
}

.dl-button:focus-visible,
.dl-note a:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.dl-note {
  margin: 16px 0 0;
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
}

.dl-note a {
  color: var(--vp-c-brand-1);
  font-weight: 500;
}

.dl-cmds {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.dl-cmds li {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.dl-cmd-label {
  color: var(--vp-c-text-2);
  font-size: 0.8125rem;
}

.dl-cmds code {
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--vp-code-block-bg);
  color: var(--vp-c-text-1);
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}

@media (max-width: 640px) {
  .alisio-downloads {
    padding: 28px 16px 0;
  }
}
</style>
