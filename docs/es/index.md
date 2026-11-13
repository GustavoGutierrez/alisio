---
layout: home

hero:
  name: Alisio
  text: "Tu trabajo. Con más posibilidades."
  tagline: "Inteligencia artificial que trabaja contigo."
  image:
    src: /assets/logo.png
    alt: Mascota de Alisio
  actions:
    - theme: brand
      text: Descargar Alisio
      link: /es/#download
    - theme: alt
      text: Ver cómo funciona
      link: /es/#how-it-works

# Lead paragraph right after the hero (rendered by HomeIntro.vue).
intro: "Trabaja con documentos y datos, encuentra aplicaciones para tus tareas y crea tus propios complementos describiendo lo que necesitas. Alisio acerca la inteligencia artificial a tu trabajo diario, desde una aplicación de escritorio."

# Home features (rendered by BentoFeatures.vue). Keep EN and ES identical in order and keys.
# featured: exactly 3 large cards; the 1st is the tall one. more: any number of compact tiles.
# A featured item takes either `link` (whole card) or `links` (+ optional `chips`, the plugin visual labels).
# icon: terminal browser chart api shield layers memory plugin agent plan subagent mcp (see the component).
featuresHeading: "Lo que Alisio te ofrece"
moreHeading: "También incluye"
featured:
  - icon: plugin
    title: "Encuentra herramientas para tu trabajo"
    details: "Explora el catálogo de complementos e instala lo que necesitas con un clic: redacción de tesis, investigación bibliográfica, exámenes de matemáticas imprimibles, certificados y tarjetas. Desde la misma pantalla puedes actualizar o quitar los complementos instalados."
    chips: ["Tesis", "Exámenes", "Certificados", "Investigación", "Búsqueda web"]
    links:
      - text: "Catálogo de complementos en la aplicación"
        link: "/es/web#plugin-catalog"
      - text: "Explora el catálogo de complementos"
        link: "https://gustavogutierrez.github.io/alisio-plugins/"
        external: true
  - icon: agent
    title: "Crea una ayuda a tu medida"
    details: "Describe con tus palabras una tarea que repites. El creador de complementos construye el complemento, lo comprueba y te deja decidir cuándo instalarlo, incluso con su propia pantalla en el menú Apps."
    link: "/es/plugin-creator"
  - icon: chart
    title: "Obtén resultados que puedes usar"
    details: "Trabaja con tus documentos y datos y obtén PDF, hojas de cálculo, gráficos, informes y paneles que puedes revisar, ajustar, abrir, imprimir o compartir."
    link: "/es/smart-dashboard"
more:
  - icon: mcp
    title: "Conecta una herramienta o servicio"
    details: "Un catálogo con inicio de sesión guiado y prueba de conexión"
    link: "/es/mcp-catalog"
  - icon: shield
    title: "Tú apruebas los cambios"
    details: "Alisio pregunta antes de cambiar archivos o ejecutar programas"
    link: "/es/tools#permission-flags"
  - icon: api
    title: "El modelo que elijas"
    details: "Un servicio en línea o un modelo en tu propio equipo"
    link: "/es/configuration"
  - icon: plan
    title: "Un plan antes de actuar"
    details: "Revisa y aprueba los pasos primero"
    link: "/es/plan"
  - icon: memory
    title: "Recuerda lo importante"
    details: "Notas que se mantienen entre tus proyectos"
    link: "/es/memory"
  - icon: browser
    title: "También en tu navegador"
    details: "La misma interfaz, abierta en tu navegador"
    link: "/es/web"
  - icon: terminal
    title: "Avanzado: terminal y scripts"
    details: "Una interfaz de terminal y un modo para scripts"
    link: "/es/tui"
  - icon: plugin
    title: "Avanzado: complementos con código"
    details: "Un kit tipado de complementos para desarrolladores"
    link: "/es/plugins"
---

<div class="alisio-whatis" data-component="whatis">

## ¿Qué es Alisio?

<div class="whatis-intro whatis-item" style="--i: 0">
<div class="whatis-logo">
<img data-component="brand-banner" src="/assets/banner.webp" alt="Alisio — inteligencia artificial que trabaja contigo" width="1000" height="470" decoding="async" />
</div>
<div class="whatis-def">

Alisio es una aplicación de escritorio con inteligencia artificial que te ayuda a realizar tareas de
tu trabajo, tus estudios y tu vida diaria. Describe lo que necesitas: Alisio organiza los pasos,
utiliza las herramientas disponibles y te ayuda a obtener un resultado que puedas revisar y usar.
Trabaja con los archivos de la carpeta que eliges, pregunta antes de cambiar algo y te permite añadir
[aplicaciones para tu oficio](#apps), desde el catálogo o creadas por ti. Docentes, estudiantes,
personal de oficina, contadores y cualquier persona en su hogar pueden empezar sin aprender términos
técnicos nuevos; programar sigue siendo posible, como uso avanzado.

</div>
</div>

<div class="whatis-media">
<section data-component="web-ui-preview" aria-labelledby="alisio-web-ui-heading" class="whatis-item whatis-card" style="--i: 1">
  <div data-component="preview-copy">
    <h3 id="alisio-web-ui-heading">Conversación, archivos y aprobaciones en una sola ventana</h3>
    <p>Pide lo que necesitas con tus palabras, mira qué está haciendo Alisio y aprueba cada cambio. La aplicación de escritorio muestra esta interfaz en su propia ventana; también se abre en tu navegador.</p>
  </div>
  <figure>
    <div class="shot-frame">
    <img src="/assets/alisio-harness-web-ui.webp" alt="La interfaz de Alisio con la lista de proyectos, una conversación activa sobre código y el explorador de archivos" width="1833" height="990" loading="lazy" decoding="async" />
    <button type="button" class="media-btn media-expand" data-expand="image" hidden data-label-close="Cerrar" aria-label="Ver la captura de la interfaz web en grande"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg></button>
    </div>
    <figcaption>La interfaz de Alisio: tus proyectos a la izquierda, la conversación en el centro y tus archivos a la derecha.</figcaption>
  </figure>
</section>
<section data-component="video" aria-labelledby="alisio-cli-demo-heading" class="whatis-item whatis-card" style="--i: 2">
  <div data-component="video-copy">
    <h3 id="alisio-cli-demo-heading">Para uso avanzado: la terminal</h3>
    <p>Programar es un uso avanzado y opcional. Este video corto muestra Alisio en la terminal, la vía para desarrolladores y scripts.</p>
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

<h3 class="whatis-sub whatis-item" style="--i: 3">¿En qué te puede ayudar?</h3>

<div class="whatis-facts">

- **[Convierte una hoja de cálculo en un informe](/es/smart-dashboard)** Adjunta una tabla CSV o de Excel y pide un resumen con gráficos. Obtienes un panel o un informe que puedes abrir, revisar y compartir.
- **[Prepara un examen imprimible](/es/about#para-quien-es)** Con el complemento Evalúa, un docente prepara un examen escolar de **matemáticas** como documento imprimible, lo revisa y reutiliza su formato. Hoy cubre solo matemáticas escolares.
- **[Elabora certificados y tarjetas](/es/about#para-quien-es)** Con el complemento Cardsmith, el personal de oficina prepara certificados, tarjetas y gráficos a partir de sus propios datos.

</div>

## Así trabajas con Alisio {#how-it-works}

<div class="whatis-facts home-steps">

- **1. Eliges** Abre la carpeta en la que quieres trabajar y describe la tarea con tus palabras, o abre una aplicación desde el menú **Aplicaciones**.
- **2. Aportas** Añade los archivos y datos que faltan. Alisio lee la carpeta que abriste y, en el modo de permisos **Preguntar**, pregunta antes de cambiar un archivo, ejecutar un programa o usar internet.
- **3. Revisas** El resultado aparece como documento, tabla, gráfico o aplicación. Revísalo, pide correcciones y luego guárdalo, imprímelo o compártelo. La última palabra es tuya.

</div>

## Aplicaciones para tu oficio {#apps}

<div class="home-lead">

Los complementos (plugins) añaden herramientas y aplicaciones para cada profesión. Los encuentras en
**Ajustes → Complementos → Catálogo de complementos**, puedes instalar uno privado desde un archivo o crear el
tuyo con el [creador de complementos](/es/plugin-creator). Las conexiones con otras herramientas y
servicios vienen del [catálogo MCP](/es/mcp-catalog), con inicio de sesión guiado, prueba de conexión
y eliminación con un clic.

</div>

<div class="home-table">

| Lo que quieres hacer | Qué utiliza | Estado |
| --- | --- | --- |
| Analizar tablas CSV y Excel, gráficos, informes y paneles | Incluido ([Smart Dashboard](/es/smart-dashboard), [Forja](/es/forja)) | Incluido |
| Documentos PDF diseñados | Incluido ([PDF diseñados](/es/documents)) | Incluido |
| Exámenes imprimibles | `@alisio/plugin-evalua` | Complemento para instalar; solo matemáticas escolares |
| Redacción de tesis e investigación bibliográfica | `@alisio/plugin-thesis`, `@alisio/plugin-literature-research` | Complementos para instalar |
| Certificados, tarjetas y gráficos | `@alisio/plugin-cardsmith` | Complemento para instalar |
| Una ayuda para tu propia tarea | [Creador de complementos](/es/plugin-creator) | Incluido |
| Conectar una herramienta o servicio | [Catálogo MCP](/es/mcp-catalog) | Incluido |

</div>

<div class="home-note">

La calidad de un resultado depende del complemento, del modelo y de los servicios que utilices. En
salud, contabilidad, educación o cualquier decisión delicada, Alisio apoya tu trabajo; no sustituye
tu criterio profesional.

</div>

## Tus datos y permisos {#data-and-permissions}

<div class="whatis-facts home-trust">

- **Tú eliges la carpeta.** Alisio trabaja con la carpeta que abres. En el modo de permisos
  **Preguntar**, pregunta antes de cambiar un archivo, ejecutar un programa o usar internet; otros
  modos dejan que más acciones se ejecuten sin preguntar, y puedes cambiarlo en cualquier momento.
  Consulta [Modos de permisos](/es/tools#permission-modes).
- **Trabajar con archivos locales no es lo mismo que mantenerlo todo en tu equipo.** Tus
  conversaciones y ajustes se guardan en tu equipo, pero lo que Alisio lee para responderte se envía
  al modelo que configuraste. Con un servicio en línea, ese servicio lo recibe; las herramientas y
  servicios conectados reciben lo que necesitan para su tarea.
- **Las claves quedan protegidas.** Las claves se guardan como credenciales, nunca en archivos de
  configuración en texto plano.
- **No es un sandbox.** Los complementos y programas se ejecutan con los permisos de tu usuario;
  instala solo lo que sea de tu confianza.

</div>

## Requisitos y preguntas frecuentes {#faq}

<h3 class="whatis-sub">Requisitos</h3>

<div class="whatis-facts home-reqs">

- **Sistema operativo** <span class="home-chips"><span>Windows 10 u 11 (x64)</span> <span>macOS (Apple Silicon o Intel)</span> <span>Linux (x86_64)</span></span>
- **Un modelo con el que trabajar** Una clave de un servicio de modelos en línea, o un servidor de modelos compatible en tu propio equipo.
- **Programas adicionales** Algunas tareas necesitan programas adicionales, por ejemplo Python 3.10 o posterior para leer archivos de Excel; Alisio te indica lo que falta.
- **Primer arranque** Los instaladores no están firmados, así que el primer arranque pide un paso extra (consulta [Aplicación de escritorio](/es/desktop#unsigned)).

</div>

<h3 class="whatis-sub">Preguntas frecuentes</h3>

<div class="home-faq">

<details class="home-faq-item">
<summary>¿Necesito saber programar?</summary>

No. Instalas la aplicación, conectas un modelo en **Ajustes → Modelos**, abres una carpeta y describes
la tarea. Los complementos se instalan desde el catálogo y el creador de complementos construye
otros nuevos a partir de una descripción. Límites actuales: algunos servicios del catálogo MCP aún requieren
configuración manual.

</details>

<details class="home-faq-item">
<summary>¿Es gratis?</summary>

Alisio es libre y de código abierto, con licencia MIT. El modelo que conectes puede tener su propio
costo: los servicios de modelos en línea cobran según sus propios precios y algunos servicios
conectados requieren una cuenta. Un modelo que se ejecuta en tu propio equipo no tiene tarifa de
servicio.

</details>

<details class="home-faq-item">
<summary>¿Mis archivos salen de mi equipo?</summary>

Depende de lo que conectes. Alisio y tus sesiones están en tu equipo, pero el contenido que lee para
ayudarte se envía al modelo que configuraste y, cuando los usas, a las herramientas y servicios
conectados. Con un modelo en tu propio equipo, ese contenido se queda en él, salvo en las
herramientas que usan internet.

</details>

<details class="home-faq-item">
<summary>¿Funciona sin internet?</summary>

Depende del modelo y de la herramienta. Con un modelo en línea necesitas internet. Con un modelo que
se ejecuta en tu propio equipo, Alisio puede trabajar sin conexión, pero instalar complementos,
actualizar los catálogos, buscar en la web y usar servicios en línea requieren conexión.

</details>

<details class="home-faq-item">
<summary>¿Puedo usarlo en mi oficio?</summary>

Sí, para las tareas de [Aplicaciones para tu oficio](#apps): análisis de datos e informes, PDF
diseñados, exámenes de matemáticas escolares, redacción de tesis, certificados y tarjetas. Para otras
tareas, comprueba si existe un complemento o crea uno con el creador de complementos. Revisa cada
resultado antes de usarlo.

</details>

</div>

<h3 class="whatis-sub whatis-item" style="--i: 4">Uso avanzado: modo código con Forja</h3>

<div class="whatis-facts whatis-forge">

- **[JavaScript para todo lo demás](/es/forja#language)** `js_run` combina varias llamadas a herramientas, filtra y pagina resultados, transforma JSON y texto. Se ejecuta en una VM QuickJS de WebAssembly nueva, sin acceso a archivos, red ni procesos: solo puede llamar herramientas de Alisio, con los mismos permisos que el agente.
- **[Python para análisis de datos e IA](/es/forja#isolation)** `python_run` cubre pandas y NumPy, estadística, scikit-learn, gráficos y dashboards a medida. Se ejecuta en un contenedor (`oci`) o en un proceso Pyodide de WebAssembly restringido (`wasm`) cuando están disponibles; con `analysis.isolation: required` nunca se ejecuta sin aislamiento.
- **[Contexto bajo demanda](/es/forja#forge-guide)** Con `forge_guide`, la guía de cada lenguaje se carga solo cuando la tarea la necesita, adaptada a los motores y paquetes que de verdad están instalados, así el prompt se mantiene pequeño.

</div>

<h3 class="whatis-sub whatis-item" style="--i: 5">Para desarrolladores y uso avanzado</h3>

<div class="whatis-facts">

- **[Ejecuciones headless](/es/tui)** `alisio run` con eventos JSONL y reanudación de sesiones, para scripts y CI.
- **[Herramientas locales](/es/tools)** Leer, buscar, editar, ejecutar procesos y Git, siempre con permisos explícitos.
- **[Contexto del proyecto](/es/context)** Instrucciones jerárquicas `AGENTS.md` y Agent Skills.

</div>

<div class="whatis-closing whatis-item" style="--i: 7">
<div class="whatis-note">

Alisio `__ALISIO_VERSION__` es una versión **estable**, todavía anterior a 1.0: las versiones menores pueden incluir cambios incompatibles (consulta [Estabilidad y versionado](/es/publishing#estabilidad-y-versionado)). Lee [Limitaciones conocidas](/es/limitations)
antes de depender de él. Alisio en su conjunto **no es un sandbox**: el shell, las herramientas locales
y los complementos se ejecutan con tus privilegios de usuario. Solo Forja aísla código (`js_run`, y Python
con los backends `oci` o `wasm`), con los límites que documenta [Forja](/es/forja).

</div>
<div class="whatis-next">
<h3>Siguiente paso</h3>

[Descargar Alisio](/es/desktop#descargar-e-instalar) [Inicio rápido](/es/quick-start) [Instalación](/es/installation)

</div>
</div>

</div>
