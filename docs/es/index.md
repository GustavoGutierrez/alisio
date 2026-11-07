---
layout: home

hero:
  name: Alisio
  text: Tu asistente para el trabajo de todos los días
  tagline: "Instálalo con un clic. Trabaja con tus archivos, pide permiso antes de actuar y te entrega PDF, hojas de cálculo y gráficos listos."
  image:
    src: /assets/logo.png
    alt: Mascota de Alisio
  actions:
    - theme: brand
      text: Descargar Alisio Desktop
      link: /es/#download
    - theme: alt
      text: Inicio rápido
      link: /es/quick-start
    - theme: alt
      text: Plugins
      link: /es/plugins

# Home features (rendered by BentoFeatures.vue). Keep EN and ES identical in order and keys.
# featured: exactly 3 large cards; the 1st is the tall one. more: any number of compact tiles.
# A featured item takes either `link` (whole card) or `links` (+ optional `chips`, the plugin visual labels).
# icon: terminal browser chart api shield layers memory plugin agent plan subagent mcp (see the component).
featuresHeading: "Qué incluye"
moreHeading: "También incluye"
featured:
  - icon: browser
    title: "Aplicación de escritorio, sin terminal"
    details: "Descárgala, instálala y ábrela como cualquier otro programa. Funciona en Linux, Windows y macOS, guarda tus datos en tu equipo y pregunta antes de leer o modificar tus archivos."
    link: "/es/desktop"
  - icon: plugin
    title: "Plugins para cada profesión"
    details: "Añade habilidades para tu trabajo: redacción de tesis, investigación bibliográfica, exámenes de matemáticas imprimibles, certificados y tarjetas. Puedes instalar más plugins con un solo comando."
    chips: ["Tesis", "Exámenes", "Contabilidad", "Certificados", "Investigación", "Búsqueda web"]
    links:
      - text: "Crea un plugin"
        link: "/es/plugins"
      - text: "Explora el catálogo de plugins"
        link: "https://gustavogutierrez.github.io/alisio-plugins/"
        external: true
  - icon: chart
    title: "Resultados listos para usar"
    details: "Forja analiza datos de Excel y CSV y entrega PDF, hojas de cálculo, gráficos, informes y dashboards que puedes abrir, imprimir o compartir."
    link: "/es/forja"
more:
  - icon: api
    title: "Cualquier modelo que elijas"
    details: "Compatible con OpenAI, DeepSeek, OpenRouter y más"
    link: "/es/configuration"
  - icon: shield
    title: "Permisos explícitos"
    details: "Escribir requiere tu aprobación"
    link: "/es/tools#permission-flags"
  - icon: memory
    title: "Memoria persistente"
    details: "SQLite y FTS5 entre proyectos"
    link: "/es/memory"
  - icon: browser
    title: "Interfaz web con alisio serve"
    details: "La misma interfaz en tu navegador"
    link: "/es/web"
  - icon: terminal
    title: "Interfaz de terminal y modo headless"
    details: "Una TUI completa y eventos JSONL para scripts y CI"
    link: "/es/tui"
  - icon: agent
    title: "Edición de código y agentes"
    details: "Programar como uso avanzado; agentes en Markdown"
    link: "/es/agents"
  - icon: plugin
    title: "SDK de plugins tipado"
    details: "Herramientas, comandos y eventos"
    link: "/es/plugins"
  - icon: layers
    title: "Compactación de contexto"
    details: "Historia antigua en checkpoints seguros"
    link: "/es/compaction"
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
<img data-component="brand-banner" src="/assets/banner.webp" alt="Alisio — tu asistente para el trabajo de todos los días, con el modelo que elijas" width="1000" height="470" decoding="async" />
</div>
<div class="whatis-def">

Alisio es un arnés de IA de escritorio para el trabajo de todos los días de personas no técnicas:
docentes, estudiantes, secretarias y personal de oficina, contadores y el hogar. Se instala con un
clic, trabaja sobre tus propios archivos y siempre pide permiso. Los [plugins](/es/plugins) lo
especializan por profesión y [Forja](/es/forja) entrega resultados listos para usar: PDF, hojas de
cálculo, gráficos, informes y dashboards. Se conecta a cualquier modelo compatible con OpenAI.
Programar sigue siendo posible, como uso avanzado, desde la terminal, el navegador o CI.

</div>
</div>

<div class="whatis-media">
<section data-component="web-ui-preview" aria-labelledby="alisio-web-ui-heading" class="whatis-item whatis-card" style="--i: 1">
  <div data-component="preview-copy">
    <h3 id="alisio-web-ui-heading">Trabaja entre sesiones desde la interfaz web</h3>
    <p>Ejecuta <code>alisio serve</code> para usar un espacio de trabajo local en el navegador con conversaciones en streaming, aprobaciones y contexto de archivos.</p>
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
    <h3 id="alisio-cli-demo-heading">Mira la CLI en acción</h3>
    <p>Un vistazo breve a Alisio trabajando en la terminal, desde un prompt hasta el uso de herramientas.</p>
  </div>
  <div class="video-frame">
    <video autoplay playsinline loop muted preload="metadata" width="960" height="500" poster="/assets/alisio-cli-demo-poster.jpg">
      <source src="/assets/alisio-cli-demo.mp4" type="video/mp4" />
      Tu navegador no admite el video de demostración de la CLI de Alisio.
    </video>
    <button type="button" class="media-btn media-expand" data-expand="video" hidden data-label-close="Cerrar" aria-label="Ver la demostración de la CLI en grande"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg></button>
    <button type="button" class="media-btn video-toggle" data-video-toggle hidden data-label-pause="Pausar el video de demostración de la CLI" data-label-play="Reproducir el video de demostración de la CLI" aria-label="Pausar el video de demostración de la CLI">
      <svg class="icon-pause" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5v14M16 5v14" /></svg>
      <svg class="icon-play" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5l11 7-11 7z" /></svg>
    </button>
  </div>
</section>
</div>

<h3 class="whatis-sub whatis-item" style="--i: 3">Modo código con Forja: el lenguaje sigue al objetivo</h3>

<div class="whatis-facts whatis-forge">

- **[JavaScript para todo lo demás](/es/forja#language)** `js_run` combina varias llamadas a herramientas, filtra y pagina resultados, transforma JSON y texto. Se ejecuta en una VM QuickJS de WebAssembly nueva, sin acceso a archivos, red ni procesos: solo puede llamar herramientas de Alisio, con los mismos permisos que el agente.
- **[Python para análisis de datos e IA](/es/forja#isolation)** `python_run` cubre pandas y NumPy, estadística, scikit-learn, gráficos y dashboards a medida. Se ejecuta en un contenedor (`oci`) o en un proceso Pyodide de WebAssembly restringido (`wasm`) cuando están disponibles; con `analysis.isolation: required` nunca se ejecuta sin aislamiento.
- **[Contexto bajo demanda](/es/forja#forge-guide)** Con `forge_guide`, la guía de cada lenguaje se carga solo cuando la tarea la necesita, adaptada a los motores y paquetes que de verdad están instalados, así el prompt se mantiene pequeño.

</div>

<h3 class="whatis-sub whatis-item" style="--i: 4">Para desarrolladores y uso avanzado</h3>

<div class="whatis-facts">

- **[Ejecuciones headless](/es/tui)** `alisio run` con eventos JSONL y reanudación de sesiones, para scripts y CI.
- **[Herramientas locales](/es/tools)** Leer, buscar, editar, ejecutar procesos y Git, siempre con permisos explícitos.
- **[Contexto del proyecto](/es/context)** Instrucciones jerárquicas `AGENTS.md` y Agent Skills.

</div>

<div class="whatis-closing whatis-item" style="--i: 7">
<div class="whatis-note">

Alisio `__ALISIO_VERSION__` es una versión **estable**, todavía anterior a 1.0: las versiones menores pueden incluir cambios incompatibles (consulta [Estabilidad y versionado](/es/publishing#estabilidad-y-versionado)). Lee [Limitaciones conocidas](/es/limitations)
antes de depender de él. Alisio en su conjunto **no es un sandbox**: el shell, las herramientas locales
y los plugins se ejecutan con tus privilegios de usuario. Solo Forja aísla código (`js_run`, y Python
con los backends `oci` o `wasm`), con los límites que documenta [Forja](/es/forja).

</div>
<div class="whatis-next">
<h3>Siguientes pasos</h3>

[Instalación](/es/installation) [Inicio rápido](/es/quick-start) [Configuración](/es/configuration)

</div>
</div>

</div>
