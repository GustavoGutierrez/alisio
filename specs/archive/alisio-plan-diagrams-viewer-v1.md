# Especificación Técnica: Diagramas y visor del plan (Plan Review visual)

| Campo | Valor |
|---|---|
| Versión | 1.0 (implementada, pendiente de publicar) |
| Proyecto | Alisio |
| Estado | **Decisiones P1 a P4 confirmadas el 2026-10-03 (sección 8); diseño en las secciones 4 a 7; implementado y verificado (sección 11). La versión del paquete la decide el propietario** |
| Fecha | 2026-10-03 |
| Paquetes probablemente afectados | `@alisio/core` (herramienta `exit_plan`, publicador de artefactos, instrucciones del agente `plan`), `@alisio/sdk` (contratos aditivos), `@alisio/server` (servir el artefacto del plan), `@alisio/alisio-code` (TUI), `@alisio/web` (privado: visor, panel de artefactos) |
| Paquetes nuevos | Ninguno previsto |
| Relación con otras especificaciones | Extiende la fase 2 (Plan Review) de `alisio-modes-goal-background-v1.md` y el sistema de artefactos de `alisio-data-analysis-runtime-v1.2.md`. Todo debe ser aditivo. |
| Superficies | Web y TUI (la TUI se adapta, ver sección 6) |

## 0. Cómo usar este documento

1. Lee primero `AGENTS.md` y `CONTRIBUTING.md`; sus reglas prevalecen (API portables de Node, dependencias nuevas solo con justificación, paridad EN/ES de la documentación, pruebas de comportamiento en los límites de módulo).
2. La sección 2 recoge los requisitos del propietario casi tal como los dio, la 3 los hechos verificados del código previo, la 8 las decisiones confirmadas y las secciones 4 a 7 el diseño implementado.
3. Todo texto de interfaz va en inglés y español. El código, los comentarios y las pruebas van en inglés.
4. Las capturas de la web para la documentación salen de `docs/assets/web-ui/` (regla vigente del propietario); si se toma una captura nueva del visor del plan, se guarda ahí como `plan_viewer_web_ui.webp`.

## 1. Objetivo

Hoy el agente `plan` termina llamando a `exit_plan` con el plan en Markdown, que se guarda como el artefacto `plan.md` (una revisión por llamada) y se revisa con la pantalla «Plan complete. What would you like to do?».

El objetivo es que el resultado de planificar no sea solo **un documento para leer**, sino una pequeña experiencia de exploración del plan que permita entender visualmente **qué se va a construir, cómo funciona, cuáles son sus partes y cómo se va a implementar**, también para personas no técnicas. Para ello, el plan se complementa automáticamente con diagramas y con un visor.

## 2. Requisitos del propietario (registrados)

### 2.1 Diagramas complementarios al plan

- Al construir el plan no debe generarse únicamente `plan.md`. El plan se complementa automáticamente con artefactos visuales que ayudan a comprender la solución rápidamente, incluso a personas no técnicas.
- Se analiza el contenido del plan y se decide qué diagramas son apropiados. **No es obligatorio generarlos todos**: solo los que aporten valor para explicar el funcionamiento, la estructura o el flujo.
- Tipos posibles:
  - Diagrama de flujo simple (procesos o secuencias).
  - Diagrama de componentes (partes principales del sistema y su relación).
  - Diagrama de arquitectura de alto nivel (varios sistemas, servicios o capas).
  - Diagrama de secuencia simplificado (comunicación entre componentes).
  - Diagrama del flujo de datos (transformaciones, procesamiento o intercambio de información).
  - Otros que resulten apropiados según el contenido.
- Los diagramas priorizan la **claridad sobre el detalle técnico**: nombres comprensibles, pocas abstracciones y textos explicativos breves.
- Cada diagrama está directamente relacionado con una sección o concepto de `plan.md` y evita duplicar información sin aportar valor.

### 2.2 Estructura de artefactos

Además de `plan.md`, una estructura similar a:

```text
plan/
├── plan.md
├── diagrams/
│   ├── overview.*
│   ├── flow.*
│   ├── components.*
│   └── ...
└── viewer/
    └── ...
```

Los nombres y la cantidad de diagramas varían según el plan.

### 2.3 Visor del plan

Los artefactos se pueden ver con un visor, para que el usuario no tenga que leer solo el Markdown. El visor presenta de forma organizada:

1. Un resumen general del plan.
2. Los objetivos principales.
3. Las etapas o pasos de implementación.
4. Los diagramas generados.
5. Las relaciones entre componentes o sistemas.
6. Los puntos importantes, decisiones y consideraciones.

Debe permitir **navegar fácilmente entre el contenido textual y los diagramas asociados**. Siempre que sea posible, los diagramas se generan con formatos **estructurados y reproducibles** (Mermaid, SVG u otro) que se puedan renderizar dentro del visor.

### 2.4 Reglas de generación

- No generar diagramas innecesarios; no convertir cada sección del plan en un diagrama.
- Generar solo los que mejoren realmente la comprensión; mantenerlos simples y legibles.
- Evitar diagramas excesivamente técnicos cuando exista una representación más sencilla.
- Cada diagrama incluye **un título y una breve explicación** de qué representa.
- `plan.md` debe seguir siendo completamente comprensible por sí mismo. Los diagramas y el visor son artefactos **adicionales** de entendimiento.
- El visor se genera **automáticamente** a partir del plan y de sus artefactos.
- Si el plan cambia (nueva revisión), los diagramas afectados se **actualizan** para mantenerse sincronizados.

### 2.5 Calidad visual y formato (añadido por el propietario, 2026-10-03)

- El formato de los diagramas **no tiene que ser SVG**. Si resultan más entendibles y útiles como `.mmd` (Mermaid) u otro formato, se prefiere ese.
- Lo que importa es que queden **con colores y bien diseñados**: una paleta coherente (con tema claro y oscuro), formas con significado, agrupaciones y textos cortos, para que se lean de un vistazo. Un diagrama sin diseño no cumple el requisito.

## 3. Estado actual (verificado contra el código, 2026-10-03)

**`exit_plan` y el plan**
- `packages/core/src/plan/exit-plan.ts` (`registerExitPlan`): efecto `read`, opt-in. Su esquema solo tiene `title` (máx. 120) y `plan` (Markdown, `PLAN_MAX_CHARS = 60_000`). Publica `plan.md` con `context.artifacts.publishText`; desde la revisión 2 el título lleva «(revision N)». Siempre devuelve un resultado JSON (`approved`, `feedback`, `skipped` o `unavailable`) más un bloque UI `artifact`. Sin revisión posible (sin interfaz o `--read-only`) devuelve `unavailable` y pide el plan completo como respuesta final.
- Estado en `sessions.options.plan` (`plan/state.ts`, `PlanState`): un solo plan por sesión, con `planId`, `revision`, `hash`, `artifactId`. **Cada revisión crea un artefacto nuevo**; no existe el concepto de «revisión de un artefacto» ni un vínculo entre el artefacto N y el N+1.
- Revisión interactiva: `PlanReview` viaja en `AskQuestionsRequest.plan` (contrato del SDK: todo campo nuevo debe ser aditivo). TUI: `tui/plan-review.ts` (reducer puro) y `PlanReviewPanel` en `tui/components.ts`. Web: `components/approval/PlanReviewPanel.tsx` (carga diferida) y `store/plan-review.ts`. El transcript web muestra el argumento `plan` del tool call con el renderizador de Markdown (`ToolRow.tsx`, `planFromArguments`).
- `PLAN_INSTRUCTIONS` (`core/src/agents/active.ts`): secciones fijas Goal, Context, Steps, Risks y Verification; no menciona diagramas.

**Artefactos de varios archivos**
- `ArtifactStore.publish` acepta un archivo o un directorio con `entry` (por defecto `index.html`). Un directorio con entry se copia tal cual; sin entry se empaqueta en `.zip`. Se permiten subcarpetas (profundidad máxima 8) y se rechazan `..`, ocultos y enlaces simbólicos o duros. `ArtifactPublisher` del SDK ya expone `publish({source, title, entry})`, pero `exit_plan` solo usa `publishText`.
- Tipos (`artifacts/kinds.ts`): `html` es `dashboard` (vista previa hasta 20 MB), `md` es `document` (2 MB), `svg` es `image`, `json` es `data`.
- Visor aislado (`server/src/routes/artifact-view.ts`): `/artifact-view/<token>/<ruta>`, token firmado de caducidad corta, solo sirve archivos del manifiesto. `HtmlFrame` usa `sandbox="allow-scripts allow-downloads"`. CSP exacta: `default-src 'none'`; `script-src` y `style-src` con el prefijo del artefacto más `'unsafe-inline'`; `img-src` y `font-src` con el prefijo más `data:` (y `blob:` en imágenes); `connect-src 'none'`; sin `eval`. Con `connect-src 'none'` el visor **no puede hacer `fetch`**: los datos van incrustados en un `<script>` o se cargan con `<script src>` e `<img src>` del mismo artefacto. La navegación entre archivos del mismo artefacto sí funciona.
- Límites: 200 archivos por defecto (rango 1 a 1000), 100 MB por archivo, 500 MB por publicación (`analysis.limits.*`).
- Un directorio con `index.html` se presenta como **un único** `dashboard`: el `plan.md` quedaría oculto dentro de la carpeta y la TUI no podría previsualizarlo. Esto valía para un visor HTML: al elegir un visor nativo (P2) basta una carpeta con `entry: "plan.md"` (tipo `document`), un solo artefacto por revisión; ver 5.3.

**Mermaid y diagramas**
- La web ya dibuja los bloques ```` ```mermaid ````: `markdown/fences.ts` los convierte en `UiBlock{kind:"mermaid"}`; `renderers/mermaid/view.tsx` los dibuja en un fragmento de carga diferida (Mermaid 11.17.2 con `securityLevel: "strict"`, `htmlLabels: false`, saneado con DOMPurify, tema claro/oscuro, alternar fuente, copiar, exportar SVG, zoom). Lo usan el transcript y la vista previa de artefactos Markdown. No se dibuja durante el streaming.
- Mermaid solo existe dentro de la app web: **no** está disponible dentro del iframe aislado ni en el servidor. Mermaid necesita DOM y medir texto; el SVG de la documentación se genera a mano con `pnpm dlx @mermaid-js/mermaid-cli` (Puppeteer y Chrome), sin script ni dependencia del repositorio. No es viable en tiempo de ejecución (Chromium) ni con jsdom (frágil).
- Inlinear Mermaid en un visor autónomo no es práctico (unos 138 KB comprimidos de núcleo más fragmentos por tipo). Un SVG ya dibujado pesa pocos KB.
- TUI: un bloque `mermaid` se muestra como código (`components.ts`, `renderCappedCode`). No hay dibujo de cajas y flechas, pero sí `renderTreeLines` con glifos Unicode o ASCII según `terminalCapabilities().unicode`.
- Python `alisio_runtime` (`html.py`, `svg.py`): solo gráficos de datos (`bar`, `line`, `scatter`). **No existe** ningún generador de diagramas de cajas y flechas con colocación automática ni en Python ni en TypeScript, ni librerías como dagre o d3 en los `package.json`.

**Dónde se guardan y se muestran los planes**
- Disco: `<root>/artifacts/<sesión>/<slug>--<id>/files/` más `manifest.json`. Listados: `/artifacts` (TUI, solo previsualiza `.md` hasta 256 KiB) y el menú del título del panel web, donde cada revisión aparece como un artefacto más.
- Falta agrupar las revisiones por plan.

**Restricciones**
- Presupuesto web (`scripts/web-size.ts` desde `pack:check`): JS inicial ≤ 90 KB y CSS ≤ 20 KB comprimidos; hoy 79,9 KB y 9,4 KB. Todo código nuevo de la web va en carga diferida.
- Prueba de traducciones de ajustes (`tests/web-i18n.test.ts`) para cada clave configurable nueva; paridad EN/ES de la documentación; `docs/implementation-status.md` para las limitaciones.

## 4. Alcance

1. Contrato aditivo de `exit_plan`: argumento opcional `diagrams`. Sin él, todo funciona como antes.
2. El plan con diagramas se publica como **un artefacto de carpeta por revisión** (`plan.md`, `plan.json`, `diagrams/<id>.mmd`); sin diagramas, el `plan.md` único de siempre.
3. Visor nativo de la web (componente Preact de carga diferida en el panel de artefactos) que lee la carpeta por la ruta autenticada de archivos.
4. TUI y modo sin interfaz adaptados (sección 6). Pruebas, documentación EN/ES con captura y verificación en Chromium.

Fuera de alcance de la v1: edición interactiva de diagramas, exportación a PDF/PowerPoint, animaciones, visor HTML autónomo, dibujar Mermaid en la terminal, diagramas para planes que no pasen por `exit_plan`, y agrupar las revisiones de un plan en un solo artefacto.

## 5. Diseño

### 5.1 Contrato de `exit_plan`

`{ title?, plan, diagrams?: [{ id, title, explanation, section?, type?, mermaid }] }` (SDK: `PlanReview.diagrams?: PlanDiagramInfo[]`, `PlanManifest`, tipos; todo opcional). `id` kebab-case ≤ 40 caracteres, estable entre revisiones; `title` ≤ 80; `explanation` ≤ 400 (una frase); `section` = encabezado del plan que ilustra (se resuelve contra los encabezados reales por id, título o prefijo; si no coincide se omite); `type` ∈ `overview|flow|components|architecture|sequence|data|state|other` (si falta o es desconocido se deduce de la palabra clave de Mermaid). El esquema **no** declara campos requeridos dentro de cada diagrama ni `maxItems`: un diagrama mal formado se descarta con motivo en lugar de fallar toda la llamada. `PLAN_MAX_CHARS` (60 000 caracteres) acota solo el Markdown; los diagramas añaden como mucho 8 × 8 KB y la presupuestación de salida del modelo (`limits.maxOutputTokens`) es la misma de siempre: el límite por diagrama (8 KB ≈ 2 000 tokens) y `plan.maxDiagrams` son lo que acota el coste. La descripción de la herramienta añade una sola frase cuando los diagramas están activos (coste por petición ≈ 25 tokens); la guía larga vive en las instrucciones del agente.

**Esquema vivo.** El registro compila la validación una sola vez al registrar; el proveedor lee `inputSchema` y `description` en cada petición. La herramienta usa *getters*: valida siempre con `diagrams` permitido (una llamada hecha con diagramas ya apagados no falla) y solo **ofrece** el campo mientras `plan.diagrams` está activo y `plan.maxDiagrams` > 0.

**Resultado.** Se mantiene el JSON de siempre (`decision`, `message`, `planId`, `revision`, `artifactId`, `feedback`). Si la llamada o la revisión anterior implican diagramas se añade `diagrams: { accepted: [ids], dropped: [{id, reason}], removed: [ids] }`; en `feedback` el mensaje recuerda reenviar todos los diagramas vigentes y corregir los descartados. El modelo solo lo ve tras la decisión del usuario: por eso el descarte no es un error (decisión del propietario).

### 5.2 Validación sin dibujar (`core/src/plan/diagrams.ts`)

Funciones puras. Reglas, en orden: vacío; tamaño ≤ 8 KB (bytes UTF-8); sin caracteres de control; primera sentencia (tras front matter, directivas y comentarios) con palabra clave permitida; front matter o directivas `%%{...}%%` sin `securityLevel|htmlLabels|secure|dompurify|themeCSS|maxTextSize|maxEdges|startOnLoad|callback|logLevel|deterministicIds`; sin `javascript:`/`vbscript:`/`data:<tipo>/`, `href`, `url(`/`@import`; sin etiquetas HTML (`<b>`, `<br/>`, `<script>`, ...; las anotaciones `<<choice>>` se ignoran); sin sentencias `click`/`link`/`callback` a inicio de línea (no en `mindmap`, `timeline` y `journey`, cuyo texto es libre); estimación de nodos ≤ 40.

**Tipos permitidos (decisión):** `flowchart`, `graph`, `sequenceDiagram`, `stateDiagram`, `stateDiagram-v2`, `erDiagram`, `classDiagram`, `gantt`, `mindmap`, `timeline`, `journey`. Se excluyen los tipos beta o con plugin (`architecture-beta`, `zenuml`, `block`, `sankey`, `xychart`, `packet`, `kanban`), `gitGraph`, `C4*` y `pie`/`quadrantChart`: se ven peor o no se pueden verificar sin DOM; los componentes se dibujan con `flowchart` y `subgraph`.

**Estimación de nodos:** por tipo (ids de flowchart tras quitar etiquetas, participantes, estados, entidades, clases, tareas de gantt, líneas de mindmap/timeline). Es una cota por exceso, no un analizador. Un diagrama que pasa y no se dibuja se muestra como código más el error (comportamiento existente del renderizador).

Límites: `DIAGRAM_MAX_BYTES = 8192`, `DIAGRAM_MAX_NODES = 40` (constantes, no ajustes), `plan.maxDiagrams` 0–8 (por defecto 5). Los diagramas por encima del máximo se descartan en orden; un inválido no consume plaza.

### 5.3 Carpeta del plan y publicación

Verificado: `ArtifactStore.publish({source, title, entry})` copia un directorio con `entry` tal cual y el tipo sale de la entrada (`plan.md` → `document`, vista previa hasta 2 MB). `exit_plan` escribe `plan/plan.md`, `plan.json` y `diagrams/<id>.mmd` en un directorio temporal del sistema (`os.tmpdir()`, `mkdtemp`, borrado en `finally`; `ToolContext.artifacts` solo ofrece `publish` de rutas absolutas del propio llamante) y llama a `publishDetailed`. Se publica la carpeta cuando hay diagramas aceptados **o** quitados respecto a la revisión anterior (para conservar el estado `removed`); en otro caso, `publishText("plan.md")` como siempre. Si la carpeta falla (p. ej. límite de archivos), se publica `plan.md` solo y el resultado lo avisa: la revisión nunca se rompe.

**Adaptación:** el almacén nombraba una carpeta de varios archivos `<carpeta>.zip` y entonces la TUI (`previewKind` por nombre), la web y la tarjeta no la tratan como `plan.md`. Se añadió un `fileName` opcional **solo interno de core** a `ArtifactStore.publish`/`CoreArtifactPublisher.publishDetailed` (el SDK `ArtifactPublishInput` no cambia, no se altera `python_run`/`outputs.json`). Resultado: `fileName: "plan.md"`, `entry: "plan.md"`, `kind: "document"`, `fileCount` > 1; la ruta de descarga ya produce `plan.zip` con todos los archivos. La lista del menú, `/artifacts`, la fila del plan del transcript y el panel de revisión siguen funcionando (comprobado en Chromium y por pruebas).

### 5.4 Manifiesto `plan.json` (`core/src/plan/manifest.ts`)

Determinista, lo genera Alisio, nunca el modelo. `version: 1`, `planId`, `revision`, `title`, `hash`, `summary`, `goals[]`, `stages[{title, detail?}]`, `considerations[{kind: decision|risk|verification, text}]`, `sections[{id, title, level}]`, `diagrams[{id, title, explanation, section?, type, syntax, file, hash, status}]`, `removed[{id, title}]`. Extracción desde los encabezados que `PLAN_INSTRUCTIONS` ya pide (Goal, Context, Steps, Risks, Verification; se añadió **Decisions**, opcional, porque «decisiones» es una de las seis partes del visor) con alias en inglés y español; un `#` de título no es sección salvo que el plan solo use `#`. Resumen = primer párrafo de Goal (o del texto previo); objetivos = elementos de lista de Goal; etapas = elementos de lista de primer nivel de Steps (o sus `###`), con sangrado como detalle; consideraciones = Decisions, Risks y Verification. Texto plano (sin Markdown); topes por campo y 30 elementos por lista. Los ids de sección son slugs únicos (`steps`, `steps-2`), y la web los calcula con el mismo algoritmo (prueba de paridad). Sin secciones esperadas, los campos salen vacíos y el visor muestra el plan completo y los diagramas.

### 5.5 Sincronización entre revisiones y hash

Cada llamada es un artefacto nuevo (comportamiento existente). **Adaptación:** la revisión anterior se lee del **estado del plan** (`PlanState.diagrams: [{id, title, hash}]`, solo cuando hay diagramas) y no del manifiesto del artefacto anterior por `artifactId`: es más barato, no depende de que el artefacto exista (puede estar borrado o caducado) ni de la ruta de archivos, y los estados antiguos siguen siendo válidos. `diagramHash` = SHA-256 de `[título, explicación, sección, tipo, mermaid normalizado]`. Estado por diagrama: `new` (id no estaba), `updated` (otro hash), `unchanged`; `removed` = ids de la revisión anterior que ya no están. `planHash(plan, diagramas?)`: sin diagramas es el SHA-256 del Markdown de antes; con ellos añade `id:hash` de cada uno, así que un cambio solo en un diagrama es otra propuesta (`PlanReview.hash`, evento `plan_proposed`). Las instrucciones piden reenviar **todos** los diagramas vigentes, actualizados, con el mismo id.

### 5.6 Instrucciones y guía de estilo

`planInstructions({diagrams, maxDiagrams})` construye el *prompt* del agente `plan` integrado y `agentRunOptions(agent, {plan})` lo aplica en cada ejecución (TUI, web y `alisio run`), de modo que `plan.diagrams: false` (o `maxDiagrams: 0`) **quita** la guía. Contenido de la guía: solo cuando un diagrama aporta comprensión; 0 a N por plan, uno sencillo ninguno; no repetir el texto ni añadir información que no esté en el plan; una idea por diagrama, unos 40 nodos, etiquetas de 1 a 4 palabras; campos `id/title/explanation/section/type`; tipos Mermaid permitidos; sin `click`, enlaces, HTML ni `%%{init}`; paleta semántica por **clases** `:::input` (entrada), `process` (paso o parte que trabaja), `data` (datos), `system` (parte principal), `external` (tercero), `decision` (decisión), `risk` (riesgo), sin colores propios; formas con significado (`[ ]` pasos, `([ ])` inicio/fin, `[( )]` datos, `{ }` decisiones) y `subgraph` para agrupar; ejemplo mínimo; sobre revisiones: reenviar todo lo vigente. ≈ 450 tokens por petición del agente `plan` mientras esté activa.

### 5.7 Tema de Alisio al dibujar (web)

`renderers/mermaid/palette.ts` (puro): paleta clara y oscura (contraste texto/relleno ≥ 4,5 comprobado por prueba) para las siete clases; `applyPalette(source, theme)` añade un bloque `classDef` para cada clase de la paleta que un flowchart usa sin definir (las que el diagrama define se respetan; otros tipos no se tocan); `themeVariables(theme)` (tema `base`) con los tokens de `styles/tokens.css`. `mermaidConfig(theme, themed)`: `themed` solo lo pide el visor del plan; los bloques del chat y las vistas previas Markdown no cambian. La seguridad (`securityLevel: "strict"`, `htmlLabels: false`, DOMPurify) no depende de `themed`.

### 5.8 Visor (web)

`LazyPlanViewer` (en el panel, ~1 KB) importa de forma diferida `components/plan/PlanViewer.tsx`; `ArtifactPanel` lo elige cuando el detalle tiene `entry === "plan.md"` y `plan.json` entre sus archivos (`isPlanArtifact`); si el fragmento no carga, cae a la vista previa Markdown. Carga por la ruta existente `GET /api/artifacts/:aid/files/*` (sin rutas nuevas): `loadPlanBundle` lee `plan.md` (obligatorio), el manifiesto y cada diagrama; manifiesto ausente o inválido → texto del plan más los `diagrams/*.mmd` encontrados con un aviso; un diagrama ilegible → error en su tarjeta, el resto sigue; `createPlanLoader` descarta respuestas obsoletas al cambiar de revisión. El manifiesto se lee de forma tolerante (`parsePlanManifest`): ignora campos desconocidos, descarta elementos mal formados y solo acepta archivos `diagrams/<id>.mmd`.

Secciones: Resumen, Objetivos principales, Etapas (recorrido por pasos), Diagramas, Componentes y relaciones (tipos `components` y `architecture`), Decisiones y consideraciones, Plan completo; barra de navegación fija con flechas/Inicio/Fin. Cada diagrama: título, tipo, explicación, enlace «Sección del plan» (mueve el foco al encabezado) y, en el plan completo, enlaces de vuelta bajo cada sección. Insignia «Nuevo/Actualizado en la revisión N» (solo desde la revisión 2) y lista de quitados. Tema claro/oscuro por tokens, 390 px sin desbordamiento, `prefers-reduced-motion` respetado. Seguridad: Preact puro, el texto del plan nunca se interpreta como HTML; el único `dangerouslySetInnerHTML` es el SVG saneado del renderizador existente; sin red. **Adaptación:** el visor corre en la aplicación web (no en el marco aislado `HtmlFrame`) porque el marco tiene `connect-src 'none'` y no puede cargar archivos ni Mermaid; los datos del plan se tratan como datos, no como instrucciones. Fuera de la lista del propietario: ninguna.

Panel de revisión: la decisión no cambia; se añade la línea «N diagramas» y **Abrir el visor del plan**; la tarjeta del artefacto abre el mismo visor.

### 5.9 Presupuesto web

Todo el código nuevo está en fragmentos diferidos; las cadenas viven en `components/plan/strings.ts` (EN/ES, mismo patrón que `goal/strings.ts`), no en `i18n/en.ts`. JS inicial: 79,9 → 80,2 KB (límite 90). Una prueba recorre los *imports* estáticos de `main.tsx` y exige que el visor, su CSS, sus cadenas, el motor Mermaid y la paleta no estén en el fragmento inicial.

## 6. TUI y modo sin interfaz

La TUI no dibuja Mermaid. Tras imprimir el plan en el transcript, `planDiagramsMarkdown` añade por diagrama: título, propósito, `section:`, insignia de revisión, la explicación y el código Mermaid **recortado a 8 líneas** (con «… N more lines in diagrams/<id>.mmd»), y después la ruta de la carpeta en disco (resuelta desde el almacén con `~`) y «Open it from /artifacts». `/artifacts` previsualiza la entrada `plan.md` como Markdown y ofrece abrir o revelar la carpeta. **Adaptación:** se usa un bloque de código Markdown del transcript en lugar de `renderCappedCode` (que es privado del renderizador de bloques `ui` y habría exigido un bloque de resultado de herramienta duplicado tras la decisión; se recorta la fuente antes de generar el Markdown). Sin interfaz (`alisio run`, `--json`) o con `--read-only`: el resultado es `unavailable`, el plan se devuelve como texto, los archivos se escriben igualmente (el evento `artifact_published` ya imprime la ruta) y no se abre nada. Ajustes: filas «Plan diagrams» y «Most diagrams per plan» en `/settings`.

## 7. Plan de implementación por fases (ejecutado en una sola entrega)

| Fase | Contenido | Estado |
|---|---|---|
| 1 | Contrato, validación, manifiesto, publicación de carpeta, revisiones, ajustes e instrucciones (core, SDK) | Hecha y probada |
| 2 | Visor web, paleta/tema, línea del panel de revisión, cadenas EN/ES | Hecha, probada y verificada en Chromium |
| 3 | TUI y modo sin interfaz | Hecha (pruebas de lógica pura; sin terminal real) |
| 4 | Documentación EN/ES con captura, `implementation-status.md`, `limitations.md` | Hecha; `CHANGELOG.md`: ver sección 11 |

## 8. Decisiones del propietario (confirmadas el 2026-10-03)

| # | Decisión | Resolución |
|---|---|---|
| P1 | Formato y generación | **Mermaid** (`.mmd`) escrito por el modelo y pasado como argumentos de `exit_plan`. Alisio aporta (a) guía de estilo en `PLAN_INSTRUCTIONS` y en la descripción de la herramienta con paleta semántica por clases (`input`, `process`, `data`, `system`, `external`, `decision`, `risk`), unos 40 nodos, etiquetas cortas, una idea por diagrama y «no añadir información que no esté en el plan»; (b) tema aplicado al dibujar (bloque `classDef` si el diagrama no define la clase, más `themeVariables` con los tokens de Alisio); (c) validación ligera en el servidor sin dibujar. Un diagrama inválido se **descarta** con una nota en el resultado; el plan se publica y la revisión nunca se rompe; un error de sintaxis que solo aparece al dibujar se muestra como código más el error. |
| P2 | Visor | Visor **nativo de la web** (componente Preact de carga diferida en el panel de artefactos), no un HTML autónomo. Lee `plan.json` y los `.mmd` y presenta las seis partes más el `plan.md` completo, con navegación en ambos sentidos, teclado, tema claro/oscuro, 390 px e insignia «actualizado en la revisión N». `plan.md` es lo que lleva el plan y se entiende solo. El ZIP contiene `plan.md`, `plan.json` y `diagrams/*.mmd`. |
| P3 | TUI y sin interfaz | Tras el plan, la TUI muestra por diagrama título, explicación, sección y código recortado, luego la ruta de la carpeta y la acción de abrirla desde `/artifacts` (vista previa de `plan.md`). No se dibuja Mermaid. `alisio run` y sesiones no interactivas: el plan como texto, archivos escritos, nada se abre. |
| P4 | Cuándo | Decide el modelo, con interruptor: `plan.diagrams` (booleano, `true`) y `plan.maxDiagrams` (0 a 8, 5), con etiquetas EN/ES y documentación. Límites por diagrama como constantes (8 KB, ~40 nodos). Cada revisión mantiene los diagramas sincronizados (5.5). |

P5 (cuándo) y P6 (límites) del borrador quedan resueltas por P4. Pendientes para el propietario: ver el informe de entrega (versión del paquete, entrada de `CHANGELOG.md`, visor autónomo, agrupar revisiones).

### 8.1 Comparación de las formas de generar los diagramas (hallazgos de la exploración)

| | (a) Mermaid como argumento de `exit_plan` | (b) segunda llamada al modelo | (c) JSON estructurado que Alisio dibuja a SVG | (d) Mermaid solo en bloques de `plan.md` |
|---|---|---|---|---|
| Código nuevo | Esquema de `exit_plan` y guardado | Paso nuevo en el runner | Módulo nuevo con validación y colocación propia | Extractor y visor |
| Coste en tokens | +500 a 2000 | +1 llamada completa | Algo menos que Mermaid | 0 extra |
| Determinismo | Bajo | Bajo | **Alto** (la salida del modelo son datos) | Bajo |
| Errores | Mermaid inválido no se detecta en el servidor | Igual, más latencia | Validación por esquema, sin errores de sintaxis | Error visible solo en la web |
| SVG en servidor sin navegador | No | No | **Sí** | No |
| TUI | Solo código | Solo código | Lista o árbol Unicode del mismo grafo | Solo código |
| Sin interfaz | Texto | Requiere modelo | **Funciona** | Texto |

**Recomendación revisada tras el requisito 2.5 (opinión, no un hecho del repositorio):** Mermaid como formato fuente, en archivos `.mmd`, escrito por el modelo del plan (opción a, y la d para los bloques dentro de `plan.md`). La razón es que la web **ya dibuja Mermaid** con tema claro y oscuro, y Mermaid ya trae lo que pide el requisito de diseño: `classDef` y `style` para colores, `subgraph` para agrupar, formas distintas por significado, y tipos de diagrama listos (flujo, secuencia, componentes en C4 o flowchart, estados). Un generador propio en SVG (opción c) daría un control total del aspecto, pero habría que escribir y mantener un algoritmo de colocación y un lenguaje de estilos que Mermaid ya resuelve.

Para que el resultado quede bien diseñado y no dependa de la suerte del modelo:
1. **Guía de estilo de Alisio** dentro de las instrucciones del agente `plan` y de la descripción de la herramienta: paleta con nombres semánticos (entrada, proceso, datos, sistema externo, riesgo) definida como `classDef`, máximo de nodos por diagrama, etiquetas de pocas palabras, un tipo de diagrama por idea y una explicación breve fuera del diagrama.
2. **Tema aplicado por Alisio al dibujar:** variables de tema de Mermaid con los colores de Alisio y su modo claro u oscuro, de modo que los diagramas sean coherentes con la interfaz aunque el modelo no ponga colores.
3. **Validación ligera en el servidor** (sin dibujar): tamaño máximo, tipos de diagrama permitidos, y rechazo de `click`, enlaces, `href`, HTML en etiquetas y de cualquier `%%{init}` que cambie `securityLevel`. Un diagrama inválido no rompe la revisión: se publica el plan y el diagrama se muestra como código con el motivo (comportamiento que ya tiene el renderizador).
4. **Dibujo en la web** con el renderizador existente (carga diferida, `securityLevel: "strict"`, DOMPurify). Con eso el visor nativo de la web es la vía principal; el visor autónomo en HTML tendría que incrustar Mermaid (unos 138 KB comprimidos de núcleo más fragmentos) y se pospone. La exportación a SVG que ya existe en la web sirve para obtener una versión ya dibujada si se necesita fuera.

Se evita (b) por coste y latencia, y Mermaid CLI en tiempo de ejecución por Chromium. Queda como alternativa descartable (c) si más adelante se necesita dibujar sin navegador (por ejemplo, un visor HTML descargable sin Mermaid).

**Publicación recomendada:** un artefacto principal `plan.md` por revisión (con vista previa en TUI y web) y los diagramas `.mmd` más un manifiesto `plan.json` (resumen, objetivos, etapas, decisiones y lista de diagramas con título, explicación y sección) en una carpeta `plan/`, que el visor nativo de la web lee para presentar las seis partes de la sección 2.3.

## 9. Riesgos conocidos

- **Diagramas incorrectos o decorativos:** un modelo puede inventar relaciones que el plan no dice. Mitigación prevista: cada diagrama debe citar la sección del plan que ilustra, y las instrucciones del agente exigen no añadir información que no esté en el plan.
- **Coste:** más tokens por plan. El límite de diagramas y la generación opcional lo acotan.
- **Seguridad del contenido generado por el modelo** (etiquetas con HTML o scripts en Mermaid/SVG): se sanea siempre y el visor corre aislado.
- **Presupuesto del paquete web:** una librería de diagramas incorporada de forma eager superaría el límite; solo carga diferida.
- **Divergencia entre `plan.md` y los diagramas** cuando el plan cambia: la sincronización por revisión es un requisito, no una mejora.

## 10. Definition of Done

1. `plan.md` sigue siendo comprensible por sí mismo y es lo único obligatorio.
2. Los diagramas son opcionales, simples, con título, explicación y sección asociada.
3. El visor se genera automáticamente y navega entre texto y diagramas, con las seis partes de la sección 2.3.
4. Una revisión nueva del plan mantiene sincronizados los diagramas afectados.
5. Web y TUI cubiertas; la TUI y el modo sin interfaz degradan con una salida útil.
6. Sin dependencias nuevas pesadas ni nativas; el paquete web inicial dentro del presupuesto.
7. Pruebas de comportamiento, documentación EN/ES con capturas de `docs/assets/web-ui/`, `docs/implementation-status.md` actualizado y todas las verificaciones del repositorio en verde.

## 11. Verificación

Pruebas nuevas (comportamiento en los límites de módulo): `plan-diagrams`, `plan-manifest`, `plan-diagrams-config`, `plan-review` (bloque «exit_plan with diagrams»), `server-artifacts` (carpeta del plan por la ruta de archivos y el ZIP, con la misma autenticación), `tui-plan-review` (texto de diagramas, ruta, vista previa de `plan.md`), `web-plan-viewer` (almacén/carga, manifiesto tolerante, navegación, insignias, paleta, cadenas, carga diferida) y la etiqueta de ajustes de `web-i18n`. Comprobación manual en Chromium contra `alisio serve` con un proveedor falso: plan sin diagramas (sin línea ni visor), con tres diagramas y uno inválido descartado, revisión 2 con uno actualizado y otro quitado, tema claro y oscuro, 390 px sin desplazamiento de la página, teclado, ZIP y `plan.diagrams: false`.

**`CHANGELOG.md`:** no se añadió la sección `## [Unreleased]`. El analizador la admite, pero `tests/changelog.test.ts` exige que las dos primeras entradas sean `0.1.1` y `0.1.0`, así que una sección `Unreleased` rompería esa prueba; el propietario añadirá la entrada junto con la versión.
