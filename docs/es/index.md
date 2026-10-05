---
layout: home

hero:
  name: Alisio
  text: Construye con agentes que tú controlas
  tagline: "Un arnés de agentes agnóstico del proveedor, con su propio ciclo de herramientas: terminal, interfaz web y modo headless, herramientas con permisos, planes, subagentes, plugins y paneles de datos."
  image:
    src: /assets/logo.png
    alt: Mascota de Alisio
  actions:
    - theme: brand
      text: Inicio rápido
      link: /es/quick-start
    - theme: alt
      text: Instalación
      link: /es/installation
    - theme: alt
      text: Escribir un plugin
      link: /es/plugins

# Home features (rendered by BentoFeatures.vue). Keep EN and ES identical in order and keys.
# featured: exactly 3 large cards; the 1st is the tall one. more: any number of compact tiles.
# icon: terminal browser chart api shield layers memory plugin agent plan subagent mcp (see the component).
featuresHeading: "Qué incluye"
moreHeading: "También incluye"
featured:
  - icon: terminal
    title: "Interfaz de terminal y modo headless"
    details: "Una TUI completa con Markdown en streaming, bloques de herramientas y aprobaciones, más modo headless con eventos JSONL."
    link: "/es/tui"
  - icon: browser
    title: "Interfaz web con alisio serve"
    details: "Una interfaz de navegador local, con token, para varios workspaces y sesiones, sobre el mismo núcleo de agente."
    link: "/es/web"
  - icon: chart
    title: "Dashboards y gráficos"
    details: "El análisis en Python publica dashboards e informes como artefactos, con gráficos interactivos sin conexión."
    link: "/es/smart-dashboard"
more:
  - icon: api
    title: "Cualquier API compatible con OpenAI"
    details: "Chat Completions o Responses"
    link: "/es/configuration"
  - icon: shield
    title: "Permisos explícitos"
    details: "Escribir requiere tu aprobación"
    link: "/es/tools#permission-flags"
  - icon: layers
    title: "Compactación de contexto"
    details: "Historia antigua en checkpoints seguros"
    link: "/es/compaction"
  - icon: memory
    title: "Memoria persistente"
    details: "SQLite y FTS5 entre proyectos"
    link: "/es/memory"
  - icon: plugin
    title: "SDK de plugins tipado"
    details: "Herramientas, comandos y eventos"
    link: "/es/plugins"
  - icon: agent
    title: "Agentes"
    details: "Agentes en Markdown; usa /agents"
    link: "/es/agents"
  - icon: plan
    title: "Modo plan y visor del plan"
    details: "Plan de solo lectura que apruebas"
    link: "/es/plan"
  - icon: subagent
    title: "Subagentes"
    details: "Sesiones hijas con árbol de agentes"
    link: "/es/subagents"
  - icon: mcp
    title: "MCP y Herdr"
    details: "MCP por stdio y HTTP, más Herdr"
    link: "/es/tools#mcp"
---

## ¿Qué es Alisio?

<img data-component="brand-banner" src="/assets/banner.png" alt="Alisio — arnés de agentes de programación" width="1447" height="680" />

Alisio es un arnés de agentes de programación con núcleo propio en TypeScript. Se conecta a cualquier
endpoint compatible con OpenAI, controla su propio ciclo de herramientas y se ejecuta en su terminal,
como TUI interactiva o en modo headless para scripts y CI.

<section data-component="web-ui-preview" aria-labelledby="alisio-web-ui-heading">
  <div data-component="preview-copy">
    <h2 id="alisio-web-ui-heading">Trabaje entre sesiones desde la interfaz web</h2>
    <p>Ejecute <code>alisio serve</code> para usar un espacio de trabajo local en el navegador con conversaciones en streaming, aprobaciones y contexto de archivos.</p>
  </div>
  <figure>
    <img src="/assets/alisio-harness-web-ui.webp" alt="Interfaz web de Alisio Harness con navegación de espacios de trabajo, una conversación de programación activa y el explorador de archivos" width="1833" height="990" loading="lazy" decoding="async" />
    <figcaption>El mismo núcleo de agente, disponible en una interfaz de navegador enfocada en múltiples espacios de trabajo.</figcaption>
  </figure>
</section>

<section data-component="video" aria-labelledby="alisio-cli-demo-heading">
  <div data-component="video-copy">
    <h2 id="alisio-cli-demo-heading">Vea la CLI en acción</h2>
    <p>Un vistazo breve a Alisio trabajando en la terminal, desde un prompt hasta el uso de herramientas.</p>
  </div>
  <video autoplay playsinline loop muted preload="auto" poster="/assets/alisio-cli-demo-poster.jpg">
    <source src="/assets/alisio-cli-demo.mp4" type="video/mp4" />
    Su navegador no admite el video de demostración de la CLI de Alisio.
  </video>
</section>

Incluye:

- Una TUI interactiva y una CLI headless (`alisio run`, eventos JSONL, reanudación de sesiones).
- Herramientas locales para leer, buscar, editar, ejecutar procesos y Git, controladas por permisos explícitos.
- Compactación de contexto y un plugin integrado de memoria persistente.
- [Agentes](/es/agents): creación asistida por el modelo, plantillas, archivos `.agents/agents` de proyecto o globales y cambio de agente desde la web y la TUI.
- [Modo plan y revisión del plan](/es/plan): un agente de plan de solo lectura, diagramas opcionales y un visor del plan en la web.
- Análisis en Python con dashboards y [gráficos](/es/analysis#charts) publicados como artefactos.
- Subagentes: delegación en agentes especializados en sesiones hijas, con un árbol de agentes en vivo.
- [Instrucciones jerárquicas `AGENTS.md` y Agent Skills](/es/context).
- Un cliente MCP (stdio y Streamable HTTP) y una integración con Herdr.
- Un SDK de plugins tipado (`@alisio/sdk`) para herramientas, comandos, hooks y almacenamiento.

Alisio `__ALISIO_VERSION__` es una versión **estable**, todavía anterior a 1.0: las versiones menores pueden incluir cambios incompatibles (consulte [Estabilidad y versionado](/es/publishing#estabilidad-y-versionado)). Lea [Limitaciones conocidas](/es/limitations)
antes de depender de él, y recuerde que **no es un sandbox**: las herramientas y los plugins se
ejecutan con sus privilegios de usuario.

Siguientes pasos: [Instalación](/es/installation) · [Inicio rápido](/es/quick-start) · [Configuración](/es/configuration).
