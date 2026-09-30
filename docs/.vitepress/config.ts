import { type DefaultTheme, defineConfig } from "vitepress";
import { substituteTokens } from "./version";

const repo = "https://github.com/GustavoGutierrez/alisio";

function sidebar(prefix: string, labels: Record<string, string>): DefaultTheme.SidebarItem[] {
  const item = (page: string) => ({ text: labels[page] ?? page, link: `${prefix}/${page}` });
  return [
    {
      text: labels.groupGuide ?? "Guide",
      items: [
        "installation",
        "quick-start",
        "tui",
        "web",
        "prompt-templates",
        "configuration",
        "tools",
        "tool-validation",
      ].map(item),
    },
    {
      text: labels.groupFeatures ?? "Features",
      items: ["context", "subagents", "compaction", "memory"].map(item),
    },
    {
      text: labels.groupIntegrations ?? "Integrations",
      items: [
        { text: labels.mcp ?? "MCP", link: `${prefix}/tools#mcp` },
        { text: labels.herdr ?? "Herdr", link: `${prefix}/tools#herdr` },
      ],
    },
    { text: labels.groupExtend ?? "Extend", items: ["plugins", "architecture"].map(item) },
    {
      text: labels.groupProject ?? "Project",
      items: ["about", "style-guide", "publishing", "limitations", "contributing"].map(item),
    },
  ];
}

const en = {
  groupGuide: "Guide",
  groupFeatures: "Features",
  groupExtend: "Extend",
  groupProject: "Project",
  groupIntegrations: "Integrations",
  installation: "Installation",
  "quick-start": "Quick start",
  tui: "Terminal UI",
  web: "Web UI (alisio serve)",
  "prompt-templates": "Prompt templates",
  configuration: "Configuration",
  tools: "Tools & permissions",
  "tool-validation": "Tool validation",
  context: "Context & AGENTS.md",
  subagents: "Subagents",
  compaction: "Context compaction",
  memory: "Persistent memory",
  plugins: "Writing plugins",
  architecture: "Architecture",
  mcp: "MCP",
  herdr: "Herdr",
  publishing: "Publishing",
  about: "About",
  "style-guide": "Style guide",
  limitations: "Known limitations",
  contributing: "Contributing",
};

const es = {
  groupGuide: "Guía",
  groupFeatures: "Funcionalidades",
  groupExtend: "Extender",
  groupProject: "Proyecto",
  groupIntegrations: "Integraciones",
  installation: "Instalación",
  "quick-start": "Inicio rápido",
  tui: "Interfaz de terminal",
  web: "Interfaz web (alisio serve)",
  "prompt-templates": "Plantillas de prompts",
  configuration: "Configuración",
  tools: "Herramientas y permisos",
  "tool-validation": "Validación de herramientas",
  context: "Contexto y AGENTS.md",
  subagents: "Subagentes",
  compaction: "Compactación de contexto",
  memory: "Memoria persistente",
  plugins: "Escribir plugins",
  architecture: "Arquitectura",
  mcp: "MCP",
  herdr: "Herdr",
  publishing: "Publicación",
  about: "Acerca de",
  "style-guide": "Guía de estilo",
  limitations: "Limitaciones conocidas",
  contributing: "Contribuir",
};

export default defineConfig({
  base: "/alisio/",
  title: "Alisio",
  description: "An extensible, provider-agnostic coding-agent harness for your terminal.",
  cleanUrls: true,
  lastUpdated: true,
  head: [["link", { rel: "icon", href: "/alisio/assets/favicon.png" }]],
  sitemap: { hostname: "https://gustavogutierrez.github.io/alisio/" },
  markdown: {
    config(md) {
      // Replace the `__ALISIO_VERSION__` token with the current CLI version at build time so
      // docs never hardcode a version that goes stale (see docs/.vitepress/version.ts). The
      // rule runs before inline parsing, so heading slugs, header anchors and the TOC all pick
      // up the substituted version. It also applies to content pulled in via `@include`
      // (VitePress inlines it before markdown-it runs).
      md.core.ruler.before("inline", "alisio-version-substitution", (state) => {
        substituteTokens(state.tokens);
      });
    },
  },
  srcExclude: [
    "specification.md",
    "herdr.md",
    "implementation-status.md",
    "validation.txt",
    "benchmark.json",
    "README.md",
  ],
  themeConfig: {
    logo: "/assets/logo.png",
    socialLinks: [{ icon: "github", link: repo }],
    footer: { message: "Released under the MIT License. Maintainer: Gustavo Gutiérrez." },
    search: {
      provider: "local",
      options: {
        locales: {
          es: {
            translations: {
              button: { buttonText: "Buscar", buttonAriaLabel: "Buscar" },
              modal: {
                displayDetails: "Mostrar lista detallada",
                resetButtonTitle: "Restablecer búsqueda",
                backButtonTitle: "Cerrar búsqueda",
                noResultsText: "No hay resultados para",
                footer: {
                  selectText: "seleccionar",
                  selectKeyAriaLabel: "Intro",
                  navigateText: "navegar",
                  navigateUpKeyAriaLabel: "Flecha arriba",
                  navigateDownKeyAriaLabel: "Flecha abajo",
                  closeText: "cerrar",
                  closeKeyAriaLabel: "Escape",
                },
              },
            },
          },
        },
      },
    },
  },
  locales: {
    root: {
      label: "English",
      lang: "en",
      themeConfig: {
        nav: [
          { text: "Guide", link: "/quick-start" },
          { text: "Plugins", link: "/plugins" },
          {
            text: "Complete plugin catalog",
            link: "https://gustavogutierrez.github.io/alisio-plugins/",
          },
          { text: "Configuration", link: "/configuration" },
        ],
        sidebar: sidebar("", en),
        editLink: { pattern: `${repo}/edit/main/docs/:path`, text: "Edit this page on GitHub" },
        docFooter: { prev: "Previous page", next: "Next page" },
        outline: { label: "On this page" },
        lastUpdated: { text: "Last updated" },
        returnToTopLabel: "Return to top",
        sidebarMenuLabel: "Menu",
        darkModeSwitchLabel: "Appearance",
        langMenuLabel: "Change language",
      },
    },
    es: {
      label: "Español",
      lang: "es",
      link: "/es/",
      description: "Un arnés de agentes de programación extensible y agnóstico del proveedor.",
      themeConfig: {
        nav: [
          { text: "Guía", link: "/es/quick-start" },
          { text: "Plugins", link: "/es/plugins" },
          {
            text: "Catálogo completo de plugins",
            link: "https://gustavogutierrez.github.io/alisio-plugins/",
          },
          { text: "Configuración", link: "/es/configuration" },
        ],
        sidebar: sidebar("/es", es),
        editLink: { pattern: `${repo}/edit/main/docs/:path`, text: "Editar esta página en GitHub" },
        footer: { message: "Publicado bajo la licencia MIT. Mantenedor: Gustavo Gutiérrez." },
        docFooter: { prev: "Página anterior", next: "Página siguiente" },
        outline: { label: "En esta página" },
        lastUpdated: { text: "Última actualización" },
        returnToTopLabel: "Volver arriba",
        sidebarMenuLabel: "Menú",
        darkModeSwitchLabel: "Apariencia",
        lightModeSwitchTitle: "Cambiar a modo claro",
        darkModeSwitchTitle: "Cambiar a modo oscuro",
        langMenuLabel: "Cambiar idioma",
        notFound: {
          title: "PÁGINA NO ENCONTRADA",
          quote: "La página que busca no existe.",
          linkText: "Volver al inicio",
        },
      },
    },
  },
});
