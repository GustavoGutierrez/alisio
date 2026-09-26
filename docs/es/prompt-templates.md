# Plantillas de prompts

Una plantilla de prompt es un archivo Markdown que se expande en un turno normal del usuario cuando
escribe `/name args`. Alisio incluye una plantilla integrada, [`/init`](#built-in-init), y carga
otras desde plugins, su directorio de usuario y proyectos de confianza.

## Formato

Una plantilla es un archivo Markdown con frontmatter YAML. El nombre de la plantilla es el nombre del
archivo sin `.md`.

```md
---
description: Review the staged changes
argument-hint: "[area]"
requires: [process]
---
Review the staged changes in this repository. Run `git diff --staged` and report correctness bugs
first, then style issues. Focus on: $ARGUMENTS
```

| Campo | Obligatorio | Descripción |
| --- | --- | --- |
| `description` | Sí | Se muestra en `/help` y en el autocompletado (1–300 caracteres) |
| `argument-hint` | No | Sugerencia que se muestra junto al nombre, por ejemplo `"[focus]"` (hasta 120 caracteres) |
| `requires` | No | Capacidades que necesita la plantilla: `write`, `process` o ambas |

Reglas:

- Se rechazan las claves de frontmatter desconocidas.
- El nombre debe usar letras minúsculas, dígitos y guiones (`^[a-z0-9][a-z0-9-]{0,40}$`).
- El archivo está limitado a 64 KB y el cuerpo no puede estar vacío.

## Sintaxis de argumentos

| Marcador | Se reemplaza por |
| --- | --- |
| `$ARGUMENTS` | La cadena completa de argumentos, sin espacios en los extremos |
| `$1` … `$9` | Argumentos posicionales al estilo de la shell: los espacios los separan y las comillas simples o dobles agrupan palabras. Un argumento ausente queda vacío |

- Los marcadores posicionales tienen un solo dígito: `$10` es `$1` seguido de `0`.
- Si el cuerpo no hace referencia ni a `$ARGUMENTS` ni a `$1`…`$9`, los argumentos no vacíos se
  añaden al final tras una línea en blanco.

```text
/review "error handling" src/core
  $ARGUMENTS → "error handling" src/core
  $1         → error handling
  $2         → src/core
```

## Orígenes y precedencia

Las plantillas se cargan desde cuatro niveles. Un nivel posterior reemplaza a uno anterior con el
mismo nombre.

| Nivel | Ubicación | Cuándo |
| --- | --- | --- |
| builtin | Incluidas en la CLI (`/init`) | Siempre |
| plugin | Directorios registrados con `api.resources.prompts(dir)` | Cuando el plugin está cargado |
| user | `<config home>/prompts/` (`~/.config/alisio/prompts` o `$ALISIO_CONFIG_HOME/prompts`) | Siempre |
| project | `<workspace>/.alisio/prompts/` | Solo cuando el proyecto es de confianza |

Solo se leen los archivos `*.md` situados directamente en cada directorio. Si varios plugins definen
el mismo nombre, se resuelve por ID de plugin y después por orden de registro.

## Confianza

Las plantillas de proyecto siguen el
[modelo de confianza de la configuración](/es/quick-start#configuration-trust-model):
`.alisio/prompts/` solo se lee con `--trust-project` o con un `--config` explícito. Abrir un
repositorio que no es de confianza nunca añade sus plantillas.

## Diagnósticos

Los problemas nunca detienen Alisio; se listan en `/stats` en la TUI.

| Diagnóstico | Significado |
| --- | --- |
| `prompt_invalid` | Un archivo no superó la validación (frontmatter, nombre, tamaño o cuerpo vacío) y se omitió |
| `prompt_override` | Un nivel superior reemplazó una plantilla de un nivel inferior |
| `prompt_conflict` | Varios plugins definieron el mismo nombre; el ganador se elige por ID de plugin y después por orden de registro |
| `prompt_shadowed` | Una plantilla intentó usar el nombre o alias de un comando de la TUI (por ejemplo `/help`, `/new`) o el nombre de un comando de plugin, y se ignoró |

## Requisitos

`requires` hace que Alisio compruebe las capacidades antes de comenzar el turno:

| Modo | `requires: [write]` sin `--allow-write` |
| --- | --- |
| `--read-only` | Se rechaza, con una sugerencia para ejecutar sin `--read-only` |
| Headless (`run`, `resume <id> "prompt"`) | Se rechaza: `rerun with --allow-write` |
| TUI | Se ejecuta; cada escritura pide la [aprobación](/es/tui#interactive-approvals) habitual por llamada |

`requires: [process]` se comporta igual con `--allow-process`.

## En la TUI

Las plantillas aparecen como comandos con barra en una sección propia de `/help` y en el
autocompletado, con su descripción y su sugerencia de argumentos. Ejecutar una transmite un turno
normal del usuario con herramientas y aprobaciones. La conversación muestra lo que usted escribió
(por ejemplo `/init focus on tests`) en lugar del prompt completo renderizado; ese texto se persiste
como la visualización del mensaje y lo reutiliza `/resume`.

## Uso headless

Las ejecuciones headless usan la misma sintaxis `/name args`; no hay ningún flag adicional.

```sh
alisio run "/init focus on the plugin SDK" --allow-write
alisio run "/review error-handling" --allow-process
```

Un `/name` que no es una plantilla (ni `/skill:name`) se envía al modelo literalmente.

## Escribir una plantilla

Guarde esto como `~/.config/alisio/prompts/explain.md`:

```md
---
description: Explain a file or module for a newcomer
argument-hint: "<path> [audience]"
---
Read $1 and explain what it does, how it fits in this repository and the non-obvious parts.
Write for this audience: $2
```

Después ejecute `/explain src/index.ts "a new contributor"` en la TUI, o
`alisio run '/explain src/index.ts "a new contributor"'`.

## Plantillas desde plugins {#templates-from-plugins}

Un plugin registra un directorio de plantillas con `resources.prompts`; la ruta es relativa al
archivo del plugin.

```ts
import { definePlugin } from "@alisio/sdk";

export default definePlugin({
  id: "acme.prompts",
  version: "0.1.0",
  apiVersion: 1,
  setup(api) {
    api.resources.prompts("./prompts"); // ./prompts/*.md
  },
});
```

Las plantillas de usuario y de proyecto con el mismo nombre reemplazan a las de los plugins.
Consulte [Escribir plugins](/es/plugins).

## `/init` integrado {#built-in-init}

`/init` analiza el repositorio y crea o actualiza el `AGENTS.md` raíz: instrucciones concisas y
específicas del proyecto para agentes de programación. Su frontmatter:

```yaml
description: Analyze this repository and create or update the root AGENTS.md
argument-hint: "[focus]"
requires: [write]
```

La plantilla indica al modelo que:

1. **Explore primero en solo lectura**: liste la raíz y los directorios clave, compruebe
   `git_status`, lea los manifiestos y lockfiles, la configuración de build/test/lint, los workflows
   de CI, README, CONTRIBUTING y los archivos de instrucciones para agentes existentes (`AGENTS.md`,
   `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.cursor/rules/*`, `.github/copilot-instructions.md`),
   y examine algunos archivos de código y de pruebas representativos, prefiriendo `search_text` a
   leer muchos archivos.
2. **Escriba `AGENTS.md`** (unas 150 líneas o menos) cubriendo, solo donde el repositorio lo
   respalde: descripción del proyecto, comandos exactos, arquitectura, estilo de código aplicado,
   enfoque de pruebas, y particularidades y restricciones. Solo hechos verificados, sin consejos
   genéricos ni comandos inventados, sin secretos ni valores de entorno y sin leer `.env`; las reglas
   útiles de otros archivos de instrucciones se integran citando su origen.
3. **Cree o actualice de forma segura**: si `AGENTS.md` no existe, lo crea con `write_file`
   (`expectedHash: null`). Si existe, primero lo lee y lo actualiza en su lugar con `edit_file`,
   usando el SHA-256 de `read_file` como `expectedHash` y preservando el contenido escrito por
   personas. Nunca sobrescribe a ciegas un archivo existente.
4. **Termine** con un breve resumen de lo que cambió y de lo que no pudo verificar.

El argumento opcional es un foco adicional que se añade al final (`$ARGUMENTS`):

```sh
alisio run "/init focus on the plugin SDK" --allow-write
```

`/init` no es `alisio init`: el comando `alisio init` escribe un `.alisio/config.json` de ejemplo y
ahora muestra una sugerencia que remite a `/init`.

::: tip Repositorios grandes
La exploración reenvía el contexto creciente en cada turno, y `limits.maxTokens` (por defecto
`100000`) es un presupuesto acumulado por ejecución. En repositorios grandes, auméntelo en su
configuración. En una ejecución real con DeepSeek, las ediciones se aplicaron pero el resumen final
agotó el presupuesto.
:::

## Límites

No hay inclusiones ni parciales entre plantillas, no hay ejecución de shell ni inyección de archivos
dentro de las plantillas, no se admite `$10` ni superiores, y los argumentos posicionales son solo
texto.
