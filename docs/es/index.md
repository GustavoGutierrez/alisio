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

<div class="alisio-whatis" data-component="whatis">

## ¿Qué es Alisio?

<div class="whatis-intro whatis-item" style="--i: 0">
<div class="whatis-logo">
<img data-component="brand-banner" src="/assets/banner.webp" alt="Alisio — arnés de agentes de programación" width="1000" height="470" decoding="async" />
</div>
<div class="whatis-def">

Alisio es un arnés de agentes de programación con núcleo propio en TypeScript. Se conecta a cualquier
endpoint compatible con OpenAI, controla su propio ciclo de herramientas y se ejecuta en su terminal,
como TUI interactiva o en modo headless para scripts y CI.

</div>
</div>

<div class="whatis-media">
<section data-component="web-ui-preview" aria-labelledby="alisio-web-ui-heading" class="whatis-item whatis-card" style="--i: 1">
  <div data-component="preview-copy">
    <h3 id="alisio-web-ui-heading">Trabaje entre sesiones desde la interfaz web</h3>
    <p>Ejecute <code>alisio serve</code> para usar un espacio de trabajo local en el navegador con conversaciones en streaming, aprobaciones y contexto de archivos.</p>
  </div>
  <figure>
    <div class="shot-frame">
    <img src="/assets/alisio-harness-web-ui.webp" alt="Interfaz web de Alisio Harness con navegación de espacios de trabajo, una conversación de programación activa y el explorador de archivos" width="1833" height="990" loading="lazy" decoding="async" />
    <button type="button" class="media-btn media-expand" data-expand="image" hidden data-label-close="Cerrar" aria-label="Ver la captura de la interfaz web en grande"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg></button>
    </div>
    <figcaption>El mismo núcleo de agente, disponible en una interfaz de navegador enfocada en múltiples espacios de trabajo.</figcaption>
  </figure>
</section>
<section data-component="video" aria-labelledby="alisio-cli-demo-heading" class="whatis-item whatis-card" style="--i: 2">
  <div data-component="video-copy">
    <h3 id="alisio-cli-demo-heading">Vea la CLI en acción</h3>
    <p>Un vistazo breve a Alisio trabajando en la terminal, desde un prompt hasta el uso de herramientas.</p>
  </div>
  <div class="video-frame">
    <video autoplay playsinline loop muted preload="metadata" width="960" height="500" poster="/assets/alisio-cli-demo-poster.jpg">
      <source src="/assets/alisio-cli-demo.mp4" type="video/mp4" />
      Su navegador no admite el video de demostración de la CLI de Alisio.
    </video>
    <button type="button" class="media-btn media-expand" data-expand="video" hidden data-label-close="Cerrar" aria-label="Ver la demostración de la CLI en grande"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg></button>
    <button type="button" class="media-btn video-toggle" data-video-toggle hidden data-label-pause="Pausar el video de demostración de la CLI" data-label-play="Reproducir el video de demostración de la CLI" aria-label="Pausar el video de demostración de la CLI">
      <svg class="icon-pause" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5v14M16 5v14" /></svg>
      <svg class="icon-play" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5l11 7-11 7z" /></svg>
    </button>
  </div>
</section>
</div>

<h3 class="whatis-sub whatis-item" style="--i: 3">Bajo el capó</h3>

<div class="whatis-facts">

- **[Ejecuciones headless](/es/tui)** `alisio run` con eventos JSONL y reanudación de sesiones, para scripts y CI.
- **[Herramientas locales](/es/tools)** Leer, buscar, editar, ejecutar procesos y Git, siempre con permisos explícitos.
- **[Contexto del proyecto](/es/context)** Instrucciones jerárquicas `AGENTS.md` y Agent Skills.

</div>

<div class="whatis-closing whatis-item" style="--i: 7">
<div class="whatis-note">

Alisio `__ALISIO_VERSION__` es una versión **estable**, todavía anterior a 1.0: las versiones menores pueden incluir cambios incompatibles (consulte [Estabilidad y versionado](/es/publishing#estabilidad-y-versionado)). Lea [Limitaciones conocidas](/es/limitations)
antes de depender de él, y recuerde que **no es un sandbox**: las herramientas y los plugins se
ejecutan con sus privilegios de usuario.

</div>
<div class="whatis-next">
<h3>Siguientes pasos</h3>

[Instalación](/es/installation) [Inicio rápido](/es/quick-start) [Configuración](/es/configuration)

</div>
</div>

</div>
