# Acerca de Alisio

**Alisio es un arnés de IA de escritorio para el trabajo de todos los días de personas no
técnicas:** docentes, estudiantes, secretarias y personal de oficina, contadores y el hogar. Se
instala con un clic, trabaja sobre sus propios archivos y siempre pide permiso. Se especializa
mediante plugins por profesión y entrega resultados listos para usar: PDF, hojas de cálculo,
gráficos, informes y dashboards. Programar sigue siendo posible, pero es un uso avanzado y
secundario.

Por dentro es un arnés con núcleo propio en TypeScript. Se conecta a cualquier endpoint compatible
con OpenAI y controla su propio ciclo de herramientas. Se ejecuta en la aplicación de escritorio, en
su terminal (como TUI interactiva o en modo headless para scripts y CI) o en su navegador con
`alisio serve`.

## Pilares

1. **Fácil.** Una aplicación de escritorio, sin terminal. Consulte
   [Aplicación de escritorio](/es/desktop).
2. **Sus archivos, su control.** Local primero, con permisos explícitos: lee por defecto y escribir
   pide aprobación. Consulte [Herramientas y permisos](/es/tools#permission-flags).
3. **Plugins por profesión.** Tesis, exámenes, contabilidad, certificados, investigación. Consulte
   [Escribir plugins](/es/plugins).
4. **Resultados entregables.** Documentos, hojas de cálculo, gráficos y dashboards. Consulte
   [Forja](/es/forja) y [Análisis de datos](/es/analysis).
5. **Cualquier modelo.** Endpoints compatibles con OpenAI, DeepSeek, OpenRouter y otros. Consulte
   [Configuración](/es/configuration).

## Para quién es

Esta tabla recoge solo lo que existe hoy. Los plugins externos viven en el repositorio público
[alisio-plugins](https://github.com/GustavoGutierrez/alisio-plugins) y se instalan con
`alisio install npm:<paquete>`; **todavía no vienen incluidos en la aplicación de escritorio**
(consulte [Aplicación de escritorio](/es/desktop#limitations)).

| Quién | Qué puede hacer Alisio hoy | Respaldado por |
| --- | --- | --- |
| Estudiantes | Redactar una tesis, investigar fuentes y estudiar | `@alisio/plugin-thesis` (planifica, investiga, redacta y compone tesis universitarias en PDF con Typst), `@alisio/plugin-literature-research` (búsqueda de metadatos académicos) y la [memoria persistente](/es/memory) integrada |
| Docentes | Crear exámenes imprimibles. Hoy el plugin cubre solo exámenes escolares de **matemáticas** | `@alisio/plugin-evalua` |
| Contadores | Papeles de trabajo y análisis de hojas de cálculo | Análisis con Python de Forja ([Forja](/es/forja), [Análisis de datos](/es/analysis)) |
| Oficina y secretarías | Analizar datos de Excel y CSV, gráficos, certificados e informes | Forja y análisis, más `@alisio/plugin-cardsmith` (certificados, tarjetas y gráficos) |
| Hogar | Presupuestos, gráficos y organización de información | Forja; no hay un plugin dedicado |

También pueden existir plugins privados específicos de una profesión. Por ejemplo, existe un plugin
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
- Plugins: `@alisio/plugin-memory`, `@alisio/plugin-subagents`,
  `@alisio/plugin-openai-compatible`

Los proveedores dedicados de modelos (`@alisio/plugin-deepseek`, `@alisio/plugin-opencode`,
`@alisio/plugin-opencode-go`) se publican desde el monorepo
[alisio-plugins](https://github.com/GustavoGutierrez/alisio-plugins) y se instalan con
`alisio install npm:@alisio/plugin-...`.

## Documentación

Este sitio de documentación (inglés y español) se publica en
<https://gustavogutierrez.github.io/alisio/>.

## Documentos del proyecto

Algunos documentos del proyecto no forman parte de este sitio; viven en el repositorio y se
enlazan aquí con su URL absoluta de GitHub:

- [Especificación del producto](https://github.com/GustavoGutierrez/alisio/blob/main/docs/specification.md):
  la dirección del producto; no afirma que se cumplan todos sus criterios de release.
- [Estado de implementación](https://github.com/GustavoGutierrez/alisio/blob/main/docs/implementation-status.md)
  (en español): la fuente de verdad de las limitaciones y del alcance de la verificación.
- [Registro de validación](https://github.com/GustavoGutierrez/alisio/blob/main/docs/validation.txt):
  el registro de la ejecución final de validación.
- [Datos de benchmark](https://github.com/GustavoGutierrez/alisio/blob/main/docs/benchmark.json):
  JSON sin procesar; GitHub lo muestra como datos, no como página renderizada.