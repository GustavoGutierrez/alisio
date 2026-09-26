import { type DefaultTheme, defineConfig } from "vitepress";

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
        "prompt-templates",
        "configuration",
        "tools",
      ].map(item),
    },
    {
      text: labels.groupFeatures ?? "Features",
      items: ["context", "subagents", "compaction", "memory"].map(item),
    },
    { text: labels.groupExtend ?? "Extend", items: ["plugins", "architecture"].map(item) },
    {
      text: labels.groupProject ?? "Project",
      items: ["publishing", "limitations", "contributing"].map(item),
    },
  ];
}

const en = {
  groupGuide: "Guide",
  groupFeatures: "Features",
  groupExtend: "Extend",
  groupProject: "Project",
  installation: "Installation",
  "quick-start": "Quick start",
  tui: "Terminal UI",
  "prompt-templates": "Prompt templates",
  configuration: "Configuration",
  tools: "Tools & permissions",
  context: "Context & AGENTS.md",
  subagents: "Subagents",
  compaction: "Context compaction",
  memory: "Persistent memory",
  plugins: "Writing plugins",
  architecture: "Architecture",
  publishing: "Publishing",
  limitations: "Known limitations",
  contributing: "Contributing",
};

const es = {
  groupGuide: "Guía",
  groupFeatures: "Funcionalidades",
  groupExtend: "Extender",
  groupProject: "Proyecto",
  installation: "Instalación",
  "quick-start": "Inicio rápido",
  tui: "Interfaz de terminal",
  "prompt-templates": "Plantillas de prompts",
  configuration: "Configuración",
  tools: "Herramientas y permisos",
  context: "Contexto y AGENTS.md",
  subagents: "Subagentes",
  compaction: "Compactación de contexto",
  memory: "Memoria persistente",
  plugins: "Escribir plugins",
  architecture: "Arquitectura",
  publishing: "Publicación",
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
  srcExclude: [
    "specification.md",
    "herdr.md",
    "implementation-status.md",
    "validation.txt",
    "benchmark.json",
    "README.md",
  ],
  themeConfig: {
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
