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

# Showcase carousel (rendered by ShowcaseSlider.vue). `image` names apps/website/assets/web-ui/showcase_<image>_web_ui.webp.
# Keep EN and ES identical in order and images.
showcase:
  label: "Alisio en acción"
  slides:
    - image: spreadsheet_viewer
      title: "Trae tu hoja de cálculo"
      description: "Adjunta un archivo de Excel y pide lo que necesitas; la tabla se abre junto a la conversación para que la filtres mientras Alisio avanza paso a paso."
      alt: "Alisio con un archivo de Excel adjunto de 1.276 filas, los pasos del asistente en la conversación y la hoja abierta en una tabla lateral con un filtro"
    - image: data_questions
      title: "Pregunta sobre tus datos"
      description: "Pregunta con tus palabras y obtén tablas y listas claras, con los archivos de tu proyecto a la derecha."
      alt: "Una respuesta con tablas de pedidos y ventas por año y las 8 ciudades principales, junto a la lista de archivos del proyecto"
    - image: census_dashboard
      title: "De los datos a un panel"
      description: "Alisio resume lo que encontró en un censo nacional de archivos y abre el panel con gráficos junto a la conversación."
      alt: "Un resumen de un censo nacional de archivos en la conversación y un panel con gráficos de barras y de dona al lado"
    - image: sales_report_pdf
      title: "Un informe listo para compartir"
      description: "Se genera un informe ejecutivo de ventas en PDF y lo ves junto a la conversación."
      alt: "La conversación que generó un informe ejecutivo de ventas y el PDF abierto en un panel de vista previa"
    - image: scribe_article
      title: "Escribe con Scribe"
      description: "La aplicación Scribe redacta un artículo científico por secciones, con un diagrama y una vista previa en PDF que puedes exportar."
      alt: "La aplicación Scribe con las secciones de un artículo sobre redes neuronales y una vista previa en PDF con un diagrama de la red"
    - image: thesis_studio
      title: "Planea tu tesis"
      description: "Thesis Studio te guía desde una breve entrevista hasta el PDF final, paso a paso."
      alt: "El inicio de la aplicación Thesis Studio: pasos desde la entrevista hasta la entrega y un formulario para empezar una tesis"
    - image: lumbre_website
      title: "Crea un sitio web conversando"
      description: "La aplicación Lumbre crea el sitio web de una panadería a partir de una conversación y te muestra una vista previa al lado."
      alt: "La aplicación Lumbre con la conversación a la izquierda y la vista previa del sitio web de una panadería a la derecha"
    - image: trajectory
      title: "Mira lo que hizo Alisio"
      description: "La pestaña Trayectoria muestra la línea de tiempo de cada paso, cuánto texto leyó y escribió el modelo en cada turno y el tiempo de cada herramienta."
      alt: "La pestaña Trayectoria con la línea de tiempo de ejecución, gráficos por turno y tiempo por herramienta, junto a un panel analítico"
---

<div class="alisio-home" data-component="whatis">

## ¿Qué es Alisio?

<div class="home-lead">

Alisio es una aplicación de escritorio con inteligencia artificial que te ayuda a realizar tareas de
tu trabajo, tus estudios y tu vida diaria. Describe lo que necesitas: Alisio organiza los pasos,
utiliza las herramientas disponibles y te ayuda a obtener un resultado que puedas revisar y usar.
Trabaja con los archivos de la carpeta que eliges, pregunta antes de cambiar algo y te permite añadir
[aplicaciones para tu oficio](#apps), desde el catálogo o creadas por ti. Docentes, estudiantes,
personal de oficina, contadores y cualquier persona en su hogar pueden empezar sin aprender términos
técnicos nuevos; programar sigue siendo posible, como uso avanzado.

</div>

<section data-component="web-ui-preview" aria-labelledby="alisio-web-ui-heading" class="home-showcase">
  <h3 id="alisio-web-ui-heading">Conversación, archivos y aprobaciones en una sola ventana</h3>
  <p>Pide lo que necesitas con tus palabras, mira qué está haciendo Alisio y aprueba cada cambio. La aplicación de escritorio muestra esta interfaz en su propia ventana; también se abre en tu navegador.</p>

<ShowcaseSlider />

</section>

<div class="home-band home-band-soft">

## Lo que Alisio te ofrece

<div class="home-offers">

<div class="offer-row">
<div class="offer-copy">

### Encuentra herramientas para tu trabajo

Explora el catálogo de complementos e instala lo que necesitas con un clic: redacción de tesis, investigación bibliográfica, exámenes de matemáticas imprimibles, certificados y tarjetas. Desde la misma pantalla puedes actualizar o quitar los complementos instalados.

[Catálogo de complementos en la aplicación](/es/web#plugin-catalog) · [Explora el catálogo de complementos](https://plugins.alisioair.com/)

</div>
<figure class="offer-shot">
<div class="shot-frame home-frame">
<img src="../assets/web-ui/plugin_catalog_web_ui.webp" alt="El catálogo de complementos en Ajustes: un buscador, filtros por categoría y una lista de complementos, cada uno con su botón para instalar" width="1040" height="760" loading="lazy" decoding="async" />
<button type="button" class="media-btn media-expand" data-expand="image" hidden data-label-close="Cerrar" aria-label="Ver esta captura en grande"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg></button>
</div>
</figure>
</div>

<div class="offer-row">
<div class="offer-copy">

### [Crea una ayuda a tu medida](/es/plugin-creator)

Describe con tus palabras una tarea que repites. El creador de complementos construye el complemento, lo comprueba y te deja decidir cuándo instalarlo, incluso con su propia pantalla en el menú Apps.

</div>
<figure class="offer-shot">
<div class="shot-frame home-frame">
<img src="../assets/web-ui/plugin_creator_empty_web_ui_es.webp" alt="El creador de complementos, listo para que describas la tarea para la que quieres un complemento" width="1280" height="900" loading="lazy" decoding="async" />
<button type="button" class="media-btn media-expand" data-expand="image" hidden data-label-close="Cerrar" aria-label="Ver esta captura en grande"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg></button>
</div>
</figure>
</div>

<div class="offer-row">
<div class="offer-copy">

### [Obtén resultados que puedes usar](/es/smart-dashboard)

Trabaja con tus documentos y datos y obtén PDF, hojas de cálculo, gráficos, informes y paneles que puedes revisar, ajustar, abrir, imprimir o compartir.

</div>
<figure class="offer-shot">
<div class="shot-frame home-frame">
<img src="/assets/dashboard_charts_web_ui.webp" alt="Un panel con gráficos generados a partir de una tabla de datos" width="1280" height="1000" loading="lazy" decoding="async" />
<button type="button" class="media-btn media-expand" data-expand="image" hidden data-label-close="Cerrar" aria-label="Ver esta captura en grande"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg></button>
</div>
</figure>
</div>

</div>

### También incluye

<div class="home-list">

- **[Conecta una herramienta o servicio](/es/mcp-catalog)** Un catálogo con inicio de sesión guiado y prueba de conexión.
- **[Recuerda lo importante](/es/memory)** Notas que se mantienen entre tus proyectos.
- **[También en tu navegador](/es/web)** La misma interfaz, abierta en tu navegador.

</div>

</div>

## ¿En qué te puede ayudar?

<div class="home-columns">

- **[Convierte una hoja de cálculo en un informe](/es/smart-dashboard)** Adjunta una tabla CSV o de Excel y pide un resumen con gráficos. Obtienes un panel o un informe que puedes abrir, revisar y compartir.
- **[Prepara un examen imprimible](/es/about#para-quien-es)** Con el complemento Evalúa, un docente prepara un examen escolar de **matemáticas** como documento imprimible, lo revisa y reutiliza su formato. Hoy cubre solo matemáticas escolares.
- **[Elabora certificados y tarjetas](/es/about#para-quien-es)** Con el complemento Cardsmith, el personal de oficina prepara certificados, tarjetas y gráficos a partir de sus propios datos.

</div>

<div class="home-band home-band-navy">

## Así trabajas con Alisio {#how-it-works}

<div class="home-steps">
<svg class="steps-wind" viewBox="0 0 1000 52" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path pathLength="1" d="M24 32C150 10 330 50 500 30S850 10 1000 30" /></svg>

1. **Eliges** Abre la carpeta en la que quieres trabajar y describe la tarea con tus palabras, o abre una aplicación desde el menú **Aplicaciones**.
2. **Aportas** Añade los archivos y datos que faltan. Alisio lee la carpeta que abriste y, en el modo de permisos **Preguntar**, pregunta antes de cambiar un archivo, ejecutar un programa o usar internet.
3. **Revisas** El resultado aparece como documento, tabla, gráfico o aplicación. Revísalo, pide correcciones y luego guárdalo, imprímelo o compártelo. La última palabra es tuya.

</div>

</div>

## Aplicaciones para tu oficio {#apps}

<div class="home-lead">

Los complementos añaden herramientas y aplicaciones para cada profesión. Los encuentras en
**Ajustes → Complementos → Catálogo de complementos**, puedes instalar uno privado desde un archivo o crear el
tuyo con el [creador de complementos](/es/plugin-creator). Las conexiones con otras herramientas y
servicios vienen del [catálogo MCP](/es/mcp-catalog), con inicio de sesión guiado, prueba de conexión
y eliminación con un clic.

</div>

<div class="home-table">

| Lo que quieres hacer | Qué utiliza | Estado |
| --- | --- | --- |
| Analizar tablas CSV y Excel, gráficos, informes y paneles | Incluido ([Smart Dashboard](/es/smart-dashboard), [Forja](/es/forja)) | <span class="pill pill-ok">Incluido</span> |
| Documentos PDF diseñados | Incluido ([PDF diseñados](/es/documents)) | <span class="pill pill-ok">Incluido</span> |
| Exámenes imprimibles | `@alisio/plugin-evalua` | <span class="pill pill-install">Complemento para instalar; solo matemáticas escolares</span> |
| Redacción de tesis e investigación bibliográfica | `@alisio/plugin-thesis`, `@alisio/plugin-literature-research` | <span class="pill pill-install">Complementos para instalar</span> |
| Certificados, tarjetas y gráficos | `@alisio/plugin-cardsmith` | <span class="pill pill-install">Complemento para instalar</span> |
| Una ayuda para tu propia tarea | [Creador de complementos](/es/plugin-creator) | <span class="pill pill-ok">Incluido</span> |
| Conectar una herramienta o servicio | [Catálogo MCP](/es/mcp-catalog) | <span class="pill pill-ok">Incluido</span> |

</div>

<div class="home-note">

La calidad de un resultado depende del complemento, del modelo y de los servicios que utilices. En
salud, contabilidad, educación o cualquier decisión delicada, Alisio apoya tu trabajo; no sustituye
tu criterio profesional.

</div>

<div class="home-band home-band-soft">

## Tus datos y permisos {#data-and-permissions}

<div class="home-list">

- **Tú eliges la carpeta.** Alisio trabaja con la carpeta que abres. En el modo de permisos
  **Preguntar**, pregunta antes de cambiar un archivo, ejecutar un programa o usar internet; otros
  modos dejan que más acciones se ejecuten sin preguntar, y puedes cambiarlo en cualquier momento.
  Consulta [Modos de permisos](/es/tools#permission-modes).
- **[Tú apruebas los cambios.](/es/tools#permission-flags)** Alisio pregunta antes de cambiar archivos o ejecutar programas.
- **[Un plan antes de actuar.](/es/plan)** Revisa y aprueba los pasos primero.
- **Trabajar con archivos locales no es lo mismo que mantenerlo todo en tu equipo.** Tus
  conversaciones y ajustes se guardan en tu equipo, pero lo que Alisio lee para responderte se envía
  al modelo que configuraste. Con un servicio en línea, ese servicio lo recibe; las herramientas y
  servicios conectados reciben lo que necesitan para su tarea.
- **Las claves quedan protegidas.** Las claves se guardan como credenciales, nunca en archivos de
  configuración en texto plano.
- **<span class="home-warn" aria-hidden="true"></span>No es un sandbox.** Los complementos y programas se ejecutan con los permisos de tu usuario;
  instala solo lo que sea de tu confianza.

</div>

</div>

<DesktopDownloads />

### Requisitos

<div class="home-list">

- **Sistema operativo** <span class="home-os"><span>Windows 10 u 11 (x64)</span> <span>macOS (Apple Silicon o Intel)</span> <span>Linux (x86_64)</span></span>
- **[Un modelo con el que trabajar](/es/configuration)** Una clave de un servicio de modelos en línea, o un servidor de modelos compatible en tu propio equipo.
- **Programas adicionales** Algunas tareas necesitan programas adicionales, por ejemplo Python 3.10 o posterior para leer archivos de Excel; Alisio te indica lo que falta.
- **Primer arranque** Los instaladores no están firmados, así que el primer arranque pide un paso extra (consulta [Aplicación de escritorio](/es/desktop#unsigned)).

</div>

## Preguntas frecuentes {#faq}

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

<div class="home-band home-band-soft">

## Para desarrolladores {#for-developers}

<div class="home-lead">

Programar es un uso avanzado y opcional. Este video corto muestra Alisio en la terminal, la vía para desarrolladores y scripts.

</div>

<div class="home-dev">

<TerminalInstall />

<section data-component="video" aria-labelledby="alisio-cli-demo-heading">
  <h3 id="alisio-cli-demo-heading" class="visually-hidden">Para uso avanzado: la terminal</h3>
  <div class="video-frame home-frame">
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

<div class="home-list">

- **[Ejecuciones headless](/es/tui)** `alisio run` con eventos JSONL y reanudación de sesiones, para scripts y CI.
- **[Herramientas locales](/es/tools)** Leer, buscar, editar, ejecutar procesos y Git, siempre con permisos explícitos.
- **[Contexto del proyecto](/es/context)** Instrucciones jerárquicas `AGENTS.md` y Agent Skills.
- **[Avanzado: terminal y scripts](/es/tui)** Una interfaz de terminal y un modo para scripts.
- **[Avanzado: complementos con código](/es/plugins)** Un kit tipado de complementos para desarrolladores.

</div>

### Uso avanzado: modo código con Forja

<div class="home-list">

- **[JavaScript para todo lo demás](/es/forja#language)** `js_run` combina varias llamadas a herramientas, filtra y pagina resultados, transforma JSON y texto. Se ejecuta en una VM QuickJS de WebAssembly nueva, sin acceso a archivos, red ni procesos: solo puede llamar herramientas de Alisio, con los mismos permisos que el agente.
- **[Python para análisis de datos e IA](/es/forja#isolation)** `python_run` cubre pandas y NumPy, estadística, scikit-learn, gráficos y dashboards a medida. Se ejecuta en un contenedor (`oci`) o en un proceso Pyodide de WebAssembly restringido (`wasm`) cuando están disponibles; con `analysis.isolation: required` nunca se ejecuta sin aislamiento.
- **[Contexto bajo demanda](/es/forja#forge-guide)** Con `forge_guide`, la guía de cada lenguaje se carga solo cuando la tarea la necesita, adaptada a los motores y paquetes que de verdad están instalados, así el prompt se mantiene pequeño.

</div>

<div class="home-note">

Alisio `__ALISIO_VERSION__` es una versión **estable**, todavía anterior a 1.0: las versiones menores pueden incluir cambios incompatibles (consulta [Estabilidad y versionado](/es/publishing#estabilidad-y-versionado)). Lee [Limitaciones conocidas](/es/limitations)
antes de depender de él. Alisio en su conjunto **no es un sandbox**: el shell, las herramientas locales
y los complementos se ejecutan con tus privilegios de usuario. Solo Forja aísla código (`js_run`, y Python
con los backends `oci` o `wasm`), con los límites que documenta [Forja](/es/forja).

</div>

</div>

<div class="home-closing">

## Siguiente paso

[Descargar Alisio](/es/desktop#descargar-e-instalar) [Inicio rápido](/es/quick-start) [Instalación](/es/installation)

</div>

</div>
