# Acerca de Alisio

**Alisio es un arnés de agentes de programación con núcleo propio en TypeScript.** Se conecta a
cualquier endpoint compatible con OpenAI, controla su propio ciclo de herramientas y se ejecuta en
su terminal (como TUI interactiva o en modo headless para scripts y CI) o en su navegador con
`alisio serve`.

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