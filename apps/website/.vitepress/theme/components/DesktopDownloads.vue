<script setup lang="ts">
import { useData, withBase } from "vitepress";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import {
  DESKTOP_ASSETS,
  DESKTOP_RELEASE_URL,
  DESKTOP_VERSION,
  type DesktopOs,
  detectDesktopOs,
} from "../desktop-release";

const REPOSITORY_URL = "https://github.com/GustavoGutierrez/alisio";
/** Recommended installer per OS (asset ids from desktop-release.ts). */
const DEFAULT_ASSET: Record<DesktopOs, string> = {
  windows: "windows-x64",
  macos: "macos-arm64",
  linux: "linux-appimage",
};
const OS_ORDER: DesktopOs[] = ["windows", "macos", "linux"];
const OS_NAME: Record<DesktopOs, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };

const { lang } = useData();
const es = computed(() => lang.value.startsWith("es"));
const base = computed(() => (es.value ? "/es" : ""));
// Client-only guess (set in onMounted) so the server render is deterministic.
const detected = ref<DesktopOs | undefined>();
const open = ref(false);
const root = ref<HTMLElement | null>(null);
const toggle = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);

const copy = computed(() =>
  es.value
    ? {
        heading: "Descarga Alisio Desktop",
        main: "Descargar Alisio",
        github: "Ver en GitHub",
        more: "Más formatos de descarga",
        select: (os: string) => `Elige el formato para ${os}`,
        badge: "Recomendado",
        all: "Todas las descargas y checksums (otras arquitecturas)",
        other: "Otras plataformas y descargas",
        web: "Web",
        free: "Libre y de código abierto",
        version: `Versión ${DESKTOP_VERSION} · Windows, macOS y Linux`,
        firstLaunch: "Las apps no están firmadas: el primer arranque pide un paso extra.",
        firstLaunchLink: "Cómo abrirlas en Windows y macOS",
        assets: {
          "windows-x64": ["Instalador (x64)", "Windows 10 y 11. Ejecuta el instalador."],
          "macos-arm64": ["Imagen de disco (arm64)", "Macs con Apple Silicon (M1 o posterior)."],
          "macos-x64": ["Imagen de disco (x64)", "Macs con procesador Intel."],
          "linux-appimage": [
            "AppImage (x86_64)",
            "Cualquier distribución. Hazlo ejecutable y ábrelo.",
          ],
          "linux-deb": ["Paquete .deb (amd64)", "Debian, Ubuntu y derivadas."],
        } as Record<string, [string, string]>,
      }
    : {
        heading: "Download Alisio Desktop",
        main: "Download Alisio",
        github: "View on GitHub",
        more: "More download formats",
        select: (os: string) => `Select ${os} format`,
        badge: "Default",
        all: "All downloads and checksums (other architectures)",
        other: "Other platforms and downloads",
        web: "Web",
        free: "Free and open source",
        version: `Version ${DESKTOP_VERSION} · Windows, macOS and Linux`,
        firstLaunch: "The apps are not signed, so the first launch needs one extra step.",
        firstLaunchLink: "How to open them on Windows and macOS",
        assets: {
          "windows-x64": ["Installer (x64)", "Windows 10 and 11. Run the installer."],
          "macos-arm64": ["Disk image (arm64)", "Macs with Apple Silicon (M1 or later)."],
          "macos-x64": ["Disk image (x64)", "Macs with an Intel processor."],
          "linux-appimage": ["AppImage (x86_64)", "Any distro. Mark it executable and run."],
          "linux-deb": ["Debian package (amd64)", "Debian, Ubuntu and derivatives."],
        } as Record<string, [string, string]>,
      },
);

const mainHref = computed(() => {
  const os = detected.value;
  const asset = os ? DESKTOP_ASSETS.find((a) => a.id === DEFAULT_ASSET[os]) : undefined;
  // Unknown OS or before hydration: the release page, never a broken link.
  return asset ? asset.url : DESKTOP_RELEASE_URL;
});

const groups = computed(() => {
  const order = detected.value
    ? [detected.value, ...OS_ORDER.filter((o) => o !== detected.value)]
    : OS_ORDER;
  return order.map((os) => ({
    os,
    title:
      os === detected.value
        ? copy.value.select(OS_NAME[os]).toUpperCase()
        : OS_NAME[os].toUpperCase(),
    items: DESKTOP_ASSETS.filter((a) => a.os === os).map((a) => ({
      ...a,
      title: copy.value.assets[a.id]?.[0] ?? a.file,
      description: copy.value.assets[a.id]?.[1] ?? "",
      isDefault: detected.value === os && DEFAULT_ASSET[os] === a.id,
    })),
  }));
});

const webHref = computed(() => withBase(`${base.value}/web`));
const unsignedHref = computed(() => withBase(`${base.value}/desktop#unsigned`));

function links(): HTMLElement[] {
  return panel.value ? Array.from(panel.value.querySelectorAll<HTMLElement>("a.dl-item")) : [];
}

async function openPanel(focus?: "first" | "last" | DesktopOs) {
  open.value = true;
  if (!focus) return;
  await nextTick();
  const list = links();
  const target =
    focus === "first"
      ? list[0]
      : focus === "last"
        ? list[list.length - 1]
        : panel.value?.querySelector<HTMLElement>(`a.dl-item[data-os="${focus}"]`);
  target?.focus();
}

function closePanel(returnFocus = false) {
  open.value = false;
  if (returnFocus) toggle.value?.focus();
}

function onToggleClick() {
  if (open.value) closePanel();
  else void openPanel();
}

function onToggleKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    void openPanel("first");
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    void openPanel("last");
  }
}

function onPanelKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    closePanel(true);
    return;
  }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
  const list = links();
  if (!list.length) return;
  e.preventDefault();
  const i = list.indexOf(document.activeElement as HTMLElement);
  let next = i;
  if (e.key === "ArrowDown") next = i < 0 ? 0 : (i + 1) % list.length;
  else if (e.key === "ArrowUp") next = i <= 0 ? list.length - 1 : i - 1;
  else if (e.key === "Home") next = 0;
  else next = list.length - 1;
  list[next]?.focus();
}

function onDocPointer(e: Event) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) closePanel();
}

function onFocusOut(e: FocusEvent) {
  const to = e.relatedTarget as Node | null;
  if (open.value && to && root.value && !root.value.contains(to)) closePanel();
}

function onDocKey(e: KeyboardEvent) {
  if (e.key === "Escape" && open.value) closePanel(true);
}

onMounted(() => {
  detected.value = detectDesktopOs(navigator.userAgent);
  document.addEventListener("pointerdown", onDocPointer);
  document.addEventListener("keydown", onDocKey);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointer);
  document.removeEventListener("keydown", onDocKey);
});

const DOWNLOAD_ICON = "M12 4v11M7 11l5 5 5-5M5 20h14";
</script>

<template>
  <section id="download" class="dl-section" aria-labelledby="alisio-download-heading" data-component="desktop-downloads">
    <h2 id="alisio-download-heading" class="dl-heading">{{ copy.heading }}</h2>

    <div ref="root" class="dl-menu" @focusout="onFocusOut">
      <div class="dl-actions">
        <div class="dl-split">
          <a class="dl-main" :href="mainHref" rel="noopener">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path :d="DOWNLOAD_ICON" /></svg>
            <span>{{ copy.main }}</span>
          </a>
          <button
            ref="toggle"
            type="button"
            class="dl-toggle"
            aria-haspopup="true"
            aria-controls="alisio-download-panel"
            :aria-expanded="open ? 'true' : 'false'"
            :aria-label="copy.more"
            @click="onToggleClick"
            @keydown="onToggleKey"
          >
            <svg class="dl-chevron" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          </button>
        </div>
        <a class="dl-secondary" :href="DESKTOP_RELEASE_URL" rel="noopener">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 19c-4 1.2-4-2-6-2.5M15 21v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 00-1.3-3.2 4.2 4.2 0 00-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 00-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 00-.1 3.2A4.6 4.6 0 004 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" /></svg>
          <span>{{ copy.github }}</span>
        </a>
      </div>

      <div
        v-show="open"
        id="alisio-download-panel"
        ref="panel"
        class="dl-panel"
        :aria-label="copy.more"
        @keydown="onPanelKey"
      >
        <template v-for="g in groups" :key="g.os">
          <p class="dl-group-title">{{ g.title }}</p>
          <a
            v-for="item in g.items"
            :key="item.id"
            class="dl-item"
            :href="item.url"
            :data-os="g.os"
            rel="noopener"
          >
            <span class="dl-item-body">
              <span class="dl-item-head">
                <span class="dl-item-title">{{ item.title }}</span>
                <span class="dl-badge" :hidden="!item.isDefault">{{ copy.badge }}</span>
              </span>
              <span class="dl-item-desc">{{ item.description }}</span>
              <span class="dl-item-file">{{ item.file }}</span>
            </span>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path :d="DOWNLOAD_ICON" /></svg>
          </a>
        </template>
      </div>
    </div>

    <p class="dl-meta dl-platforms">
      <span>{{ copy.other }}:</span>
      <template v-for="os in OS_ORDER" :key="os">
        <button type="button" class="dl-link" @click="openPanel(os)">{{ OS_NAME[os] }}</button>
        <span aria-hidden="true">·</span>
      </template>
      <a :href="webHref">{{ copy.web }}</a>
      <span aria-hidden="true">·</span>
      <a :href="REPOSITORY_URL" rel="noopener">{{ copy.free }}</a>
    </p>
    <p class="dl-meta">
      {{ copy.version }} ·
      <a :href="DESKTOP_RELEASE_URL" rel="noopener">{{ copy.all }}</a>
    </p>
    <p class="dl-meta">
      {{ copy.firstLaunch }}
      <a :href="unsignedHref">{{ copy.firstLaunchLink }}</a>
    </p>
  </section>
</template>

<style scoped>
.dl-section {
  scroll-margin-top: calc(var(--vp-nav-height, 64px) + 16px);
  color: var(--vp-c-text-1);
}

.dl-heading {
  margin: 0 0 24px;
  padding: 0;
  border: 0;
}

.dl-menu {
  position: relative;
  max-width: 620px;
}

.dl-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.dl-split {
  display: inline-flex;
}

.dl-main,
.dl-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 52px;
  background: var(--alisio-action);
  color: var(--alisio-deep-navy);
  font-weight: 700;
  text-decoration: none;
  cursor: pointer;
  transition: background-color 0.2s;
}

.dl-main {
  gap: 10px;
  padding: 0 24px;
  border-radius: 10px 0 0 10px;
  font-size: 1.0625rem;
}

.dl-toggle {
  width: 52px;
  padding: 0;
  border: 0;
  border-left: 1px solid rgba(2, 15, 53, 0.3);
  border-radius: 0 10px 10px 0;
}

.dl-main:hover,
.dl-toggle:hover {
  background: var(--alisio-action-hover);
}

.dl-main svg,
.dl-toggle svg,
.dl-secondary svg,
.dl-item > svg {
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.dl-chevron {
  transition: transform 0.2s;
}

.dl-toggle[aria-expanded="true"] .dl-chevron {
  transform: rotate(180deg);
}

.dl-secondary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 52px;
  padding: 0 20px;
  border: 1px solid var(--vp-c-border);
  border-radius: 10px;
  color: var(--vp-c-text-1);
  font-weight: 700;
  text-decoration: none;
  transition: border-color 0.2s;
}

.dl-secondary:hover {
  border-color: var(--vp-c-brand-1);
}

.dl-main:focus-visible,
.dl-toggle:focus-visible,
.dl-secondary:focus-visible,
.dl-item:focus-visible,
.dl-link:focus-visible,
.dl-meta a:focus-visible {
  outline: 2px solid var(--alisio-focus-ring);
  outline-offset: 2px;
}

.dl-panel {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 30;
  width: min(460px, 100%);
  max-height: min(70vh, 560px);
  overflow-y: auto;
  padding: 8px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-elv, var(--vp-c-bg));
  box-shadow: 0 18px 48px -12px rgba(2, 15, 53, 0.35);
}

.dl-group-title {
  margin: 8px 12px 4px;
  color: var(--vp-c-text-2);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.06em;
}

.dl-group-title:first-child {
  margin-top: 4px;
}

.dl-item {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 10px 12px;
  border-radius: 8px;
  color: var(--vp-c-text-1);
  text-decoration: none;
}

.dl-item:hover,
.dl-item:focus-visible {
  background: var(--vp-c-brand-soft);
}

.dl-item-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.dl-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dl-item-title {
  font-weight: 700;
  font-size: 0.9375rem;
}

.dl-badge {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-size: 0.6875rem;
  font-weight: 700;
}

.dl-badge[hidden] {
  display: none;
}

.dl-item-desc {
  color: var(--vp-c-text-2);
  font-size: 0.875rem;
}

.dl-item-file {
  overflow: hidden;
  color: var(--vp-c-text-2);
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dl-item > svg {
  color: var(--vp-c-brand-1);
}

.dl-meta {
  margin: 16px 0 0;
  color: var(--vp-c-text-2);
  font-size: 0.9375rem;
  line-height: 1.6;
}

.dl-meta + .dl-meta {
  margin-top: 4px;
}

.dl-meta a,
.dl-link {
  color: var(--vp-c-brand-1);
  font-weight: 700;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}

.dl-meta a:hover,
.dl-link:hover {
  color: var(--vp-c-brand-2);
}

.dl-platforms {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  margin-top: 24px;
}

.dl-link {
  min-height: 28px;
  padding: 0 2px;
  border: 0;
  background: none;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}

@media (max-width: 640px) {
  .dl-menu {
    max-width: none;
  }

  .dl-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .dl-split {
    display: flex;
  }

  .dl-main {
    flex: 1;
  }

  .dl-secondary {
    justify-content: center;
  }

  .dl-panel {
    width: 100%;
  }
}
</style>
