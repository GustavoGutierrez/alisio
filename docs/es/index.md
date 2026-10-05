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

features:
  - title: Cualquier API compatible con OpenAI
    details: Chat Completions o Responses, con URL base, modelo, variable de la clave y parámetro de tokens configurables. Sin modelo ni credenciales incluidos.
  - title: Interfaz de terminal y modo headless
    details: Una TUI completa con Markdown en streaming, bloques de herramientas, barra de contexto y aprobaciones, además de un modo run headless con eventos JSONL versionados.
  - title: Interfaz web con alisio serve
    details: Una interfaz de navegador local, protegida con token, para varios workspaces y sesiones a la vez, con streaming, aprobaciones, la paleta de comandos / y el mismo núcleo de agente que la terminal.
  - title: Permisos explícitos
    details: La lectura está disponible por defecto. Escritura, procesos, MCP y mensajería entre agentes requieren flags o una aprobación interactiva.
  - title: Compactación de contexto
    details: Checkpoints estructurados reemplazan la historia antigua sin separar nunca una llamada a herramienta de su resultado.
  - title: Memoria persistente
    details: Un plugin integrado de memoria persistente sobre SQLite y FTS5, que sobrevive entre sesiones y proyectos.
  - title: SDK de plugins tipado
    details: Herramientas, comandos, eventos, contexto, hooks de compactación y sesión, completados del modelo y un puerto de almacenamiento SQLite.
  - title: Agentes
    details: Crea agentes con ayuda del modelo activo, desde plantillas o a mano, guárdalos como Markdown portable en .agents/agents y cámbialos con /agents o /agent:&lt;id&gt; en la web y la TUI.
  - title: Modo plan y visor del plan
    details: Un agente de plan de solo lectura propone un plan que aprueba antes de que cambie nada, con diagramas Mermaid opcionales en un visor del plan en la web.
  - title: Dashboards y gráficos
    details: El análisis en Python publica dashboards, informes y hojas de cálculo como artefactos; los gráficos interactivos usan un Chart.js incrustado, sin conexión.
  - title: Subagentes
    details: Delegación en agentes especializados en sesiones hijas, con árbol de agentes en vivo, worktrees git en paralelo y cancelación en cascada.
  - title: MCP y Herdr
    details: Un cliente MCP (stdio y Streamable HTTP) con conexiones perezosas sujetas a consentimiento, más una integración de reportes de Herdr.
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
