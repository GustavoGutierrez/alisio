# Acerca de Alisio

**Alisio es una aplicación de escritorio con inteligencia artificial que te ayuda a realizar tareas
de tu trabajo, tus estudios y tu vida diaria.** Describe lo que necesitas: Alisio organiza los pasos,
utiliza las herramientas disponibles y te ayuda a obtener un resultado que puedas revisar y usar,
como un PDF, una hoja de cálculo, un gráfico, un informe o un panel. Está pensada para personas que
conocen su oficio (docentes, estudiantes, personal de oficina, contadores y cualquier persona en su
hogar) y quieren una forma sencilla de aprovechar la inteligencia artificial, sin aprender
ingeniería primero. Programar sigue siendo posible, pero es un uso avanzado y secundario.

En el nivel avanzado, Alisio tiene un núcleo propio en TypeScript. Se conecta a cualquier servicio
de modelos compatible con OpenAI y controla su propio ciclo de herramientas. Se ejecuta en la
aplicación de escritorio, en tu terminal (como TUI interactiva o en modo headless para scripts y CI)
o en tu navegador con `alisio serve`.

## Pilares

1. **Fácil para empezar.** Una aplicación de escritorio, sin terminal. Consulta
   [Aplicación de escritorio](/es/desktop).
2. **Tus archivos, tus decisiones.** Tú eliges la carpeta y Alisio pregunta antes de cambiar
   archivos o ejecutar programas. Trabajar con archivos locales no significa que nada salga de tu
   equipo: lo que Alisio lee se envía al modelo que configuraste. Consulta
   [Herramientas y permisos](/es/tools#permission-flags).
3. **Aplicaciones para tu oficio.** Instala complementos desde el catálogo o crea los tuyos con el
   [creador de complementos](/es/plugin-creator); conecta herramientas y servicios desde el
   [catálogo MCP](/es/mcp-catalog). Consulta [Escribir complementos](/es/plugins).
4. **Resultados que puedes usar.** Documentos, hojas de cálculo, gráficos y paneles que tú revisas
   y ajustas. Consulta [Forja](/es/forja) y [Análisis de datos](/es/analysis).
5. **El modelo que elijas.** Un servicio en línea (compatible con OpenAI, DeepSeek, OpenRouter y
   otros) o un servidor de modelos compatible en tu propio equipo. Consulta
   [Configuración](/es/configuration).

## Para quién es

Esta tabla recoge solo lo que existe hoy. Los complementos externos viven en el repositorio público
[alisio-plugins](https://github.com/GustavoGutierrez/alisio-plugins). Se instalan con un clic desde
**Ajustes → Complementos → Catálogo de complementos** en la aplicación, o con
`alisio install npm:<paquete>`; **todavía no vienen incluidos en la aplicación de escritorio**
(consulta [Aplicación de escritorio](/es/desktop#limitations)).

| Quién | Qué puede hacer Alisio hoy | Respaldado por |
| --- | --- | --- |
| Estudiantes | Redactar una tesis, investigar fuentes y estudiar | `@alisio/plugin-thesis` (planifica, investiga, redacta y compone tesis universitarias en PDF con Typst), `@alisio/plugin-literature-research` (búsqueda de metadatos académicos) y la [memoria persistente](/es/memory) integrada |
| Docentes | Crear exámenes imprimibles. Hoy el complemento cubre solo exámenes escolares de **matemáticas** | `@alisio/plugin-evalua` |
| Contadores | Papeles de trabajo y análisis de hojas de cálculo | Análisis con Python de Forja ([Forja](/es/forja), [Análisis de datos](/es/analysis)) |
| Oficina y secretarías | Analizar datos de Excel y CSV, gráficos, certificados e informes | Forja y análisis, más `@alisio/plugin-cardsmith` (certificados, tarjetas y gráficos) |
| Hogar | Presupuestos, gráficos y organización de información | Forja; no hay un complemento dedicado |

También pueden existir complementos privados específicos de una profesión. Por ejemplo, existe un complemento
de papel de trabajo de ICA para contadores colombianos, pero no está disponible públicamente.

## Quién lo hizo

Alisio está **desarrollado en Bogotá, Colombia** por el **Ing. Gustavo Gutiérrez Mercado**.

- Perfil del desarrollador: <https://github.com/GustavoGutierrez>
- LinkedIn: <https://www.linkedin.com/in/gustavo-gutierrez-mercado>
- Repositorio fuente: <https://github.com/GustavoGutierrez/alisio>

## Paquetes

Todos los paquetes se publican bajo la
[organización npm de alisio](https://www.npmjs.com/settings/alisio/packages):

- CLI: [`@alisio/alisio-code`](https://www.npmjs.com/package/@alisio/alisio-code) — instala el
  comando `alisio`
- Núcleo: [`@alisio/core`](https://www.npmjs.com/package/@alisio/core)
- SDK: [`@alisio/sdk`](https://www.npmjs.com/package/@alisio/sdk)
- Complementos: `@alisio/plugin-memory`, `@alisio/plugin-subagents`,
  `@alisio/plugin-openai-compatible`

Los proveedores dedicados de modelos (`@alisio/plugin-deepseek`, `@alisio/plugin-opencode`,
`@alisio/plugin-opencode-go`) se publican desde el monorepo
[alisio-plugins](https://github.com/GustavoGutierrez/alisio-plugins) y se instalan con
`alisio install npm:@alisio/plugin-...`.

## Documentación

Este sitio de documentación (inglés y español) se publica en
<https://alisioair.com/>.

## Documentos del proyecto

Algunos documentos del proyecto no forman parte de este sitio; viven en el repositorio y se
enlazan aquí con su URL absoluta de GitHub:

- [Especificación del producto](https://github.com/GustavoGutierrez/alisio/blob/main/apps/website/specification.md):
  la dirección del producto; no afirma que se cumplan todos sus criterios de release.
- [Estado de implementación](https://github.com/GustavoGutierrez/alisio/blob/main/apps/website/implementation-status.md)
  (en español): la fuente de verdad de las limitaciones y del alcance de la verificación.
- [Registro de validación](https://github.com/GustavoGutierrez/alisio/blob/main/apps/website/validation.txt):
  el registro de la ejecución final de validación.
- [Datos de benchmark](https://github.com/GustavoGutierrez/alisio/blob/main/apps/website/benchmark.json):
  JSON sin procesar; GitHub lo muestra como datos, no como página renderizada.