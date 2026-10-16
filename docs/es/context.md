# Contexto: AGENTS.md y skills

Alisio construye las instrucciones del modelo a partir de archivos de instrucciones del proyecto
(`AGENTS.md`, según la convención [agents.md](https://agents.md/)) y expone Agent Skills mediante
revelación progresiva.

## AGENTS.md

### Qué archivos se leen

| Alcance | Archivos |
| --- | --- |
| Global | `<config home>/AGENTS.md`; `<config home>/AGENTS.override.md` lo reemplaza cuando existe |
| Proyecto | Un archivo por directorio, recorriendo desde la raíz del workspace hasta el directorio de trabajo |

En cada directorio gana el primer archivo existente:

| Orden | Archivo | Tipo en `context_explain` |
| --- | --- | --- |
| 1 | `AGENTS.override.md` | `override` |
| 2 | `AGENTS.md` | `agents` |
| 3 | `AGENT.md` (alias heredado, conservado por compatibilidad) | `legacy` |
| 4 | `CLAUDE.md`, solo con `context.claudeMdFallback: true` | `claude` |

`Agente.md` ya no se lee. Los archivos se concatenan empezando por la raíz, bajo una cabecera que
indica al modelo que, ante instrucciones en conflicto, gana el archivo más cercano y que los prompts
explícitos del usuario tienen prioridad sobre ellas.

### Archivos anidados

Los archivos de instrucciones de directorios por debajo del directorio de trabajo se adjuntan de
forma perezosa, cuando una herramienta toca una ruta bajo ellos:

- una vez por sesión y por archivo, y de nuevo si el archivo cambia;
- en las herramientas de lectura, las instrucciones se adjuntan al resultado de la herramienta;
- en las llamadas de escritura o de procesos, la llamada se devuelve al modelo con las nuevas
  instrucciones para que la reconsidere antes de reintentarla.

### Límite de tamaño

El conjunto de archivos de instrucciones está limitado a `context.maxBytes` (por defecto 32 KiB). Se
conservan los archivos más cercanos; los más lejanos se truncan o se descartan con un aviso de
truncado.

```json
{
  "context": { "claudeMdFallback": false, "maxBytes": 32768 }
}
```

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `claudeMdFallback` | `false` | Usar `CLAUDE.md` en directorios sin archivo `AGENTS` |
| `maxBytes` | `32768` | Bytes totales de archivos de instrucciones (1024–1048576) |

`alisio context explain <path>` (y la herramienta `context_explain`) muestra qué archivos se aplican a
una ruta y su tipo. La plantilla integrada [`/init`](/es/prompt-templates#built-in-init) crea o
actualiza el `AGENTS.md` raíz.

## Skills

Las skills son directorios que contienen un archivo `SKILL.md` con frontmatter `name` y
`description`.

### Descubrimiento

Las raíces se recorren en este orden; gana la primera skill con un nombre dado, y las posteriores se
informan como ocultadas:

| Orden | Raíces | Cuándo |
| --- | --- | --- |
| 1 | `.agents/skills`, `.alisio/skills`, `.claude/skills` en cada directorio desde el directorio de trabajo hasta la raíz del workspace | Solo proyectos de confianza (`--trust-project` o un `--config` explícito) |
| 2 | Rutas de la clave de configuración `skills` | Siempre |
| 3 | `~/.agents/skills`, `<config home>/skills` | Siempre |
| 4 | Directorios registrados por plugins (`api.resources.skills`) | Cuando el plugin está cargado |

El recorrido está acotado: como máximo 5 niveles de profundidad y 2000 directorios.

### Validación

Los nombres siguen la especificación de Agent Skills: 1–64 letras minúsculas y dígitos con guiones
simples, sin guion al principio ni al final. La descripción es obligatoria (hasta 1024 caracteres).
Un nombre de directorio que no coincide con el nombre de la skill solo produce una advertencia.
`alisio skills validate [path]` informa todos los diagnósticos.

### Revelación progresiva

Al principio solo se incluyen en el contexto el nombre y la descripción de cada skill. El cuerpo se
carga con la herramienta `skill_load` o con `/skill:name`, y los archivos de apoyo con
`skill_resource`. `skill_search` busca en el catálogo.

En la TUI, `/skills` abre el catálogo efectivo sin cargar los cuerpos. Muestra
alcance/origen, estado habilitado u ocultado y un coste aproximado de tokens (`~`, estimado desde los
bytes del archivo a cuatro caracteres por token). Los ganadores de proyecto, configuración y usuario
están habilitados por defecto y se pueden cambiar de inmediato. La anulación local se guarda de forma
atómica en `.alisio/config.json`; un archivo existente debe ser de confianza. Las skills de plugins
usan un nombre visible como `vercel:nextjs`, están bloqueadas por su plugin y remiten a `/plugins`.

```sh
alisio skills list
alisio skills validate ./.agents/skills
```

Los comandos headless incluyen metadatos de origen/estado y rutas de diagnóstico de confianza. El
catálogo normal de la TUI nunca muestra rutas absolutas ni cuerpos de skills.

## Context Governor {#context-governor}

El Context Governor es una proyección **experimental y opcional** del historial de la conversación.
Las sesiones largas reenvían una y otra vez resultados de herramientas que un resultado posterior ha
vuelto redundantes; con el governor en `on`, esos resultados se sustituyen en la petición por un stub
de una línea. Está desactivado por defecto (`context.governor: "off"`) y entonces no cambia nada.

| Modo | Qué se envía al proveedor | Qué calcula |
| --- | --- | --- |
| `off` | El historial, exactamente como antes | Nada |
| `shadow` | El historial, byte a byte como antes | Qué elidiría `on` y cuántos tokens ahorraría |
| `on` | El historial con los resultados redundantes sustituidos por stubs | Lo mismo, y lo aplica |

### Qué se elide

Solo los resultados correctos de herramientas, y solo cuando un resultado posterior correcto los
vuelve redundantes:

| Motivo | Un resultado se sustituye cuando | Stub |
| --- | --- | --- |
| `superseded_read` | Un `write_file` o `edit_file` posterior cambió la misma ruta, o un `read_file` posterior de esa ruta devolvió otro `sha256` | `[elided: read_file "src/a.ts"@1a2b3c4d; re-read to view]` (con ` lines 10+50` antes del `;` si se indicaron `startLine` o `limit`; `@unknown` si la lectura no tenía `sha256`) |
| `stale_bg_output` | Un `bg_output` posterior de la misma tarea tiene argumentos idénticos (el `offset` por defecto es 0 y el `limit` su valor por defecto), o la consulta anterior devolvió texto vacío | `[elided: bg_output "task-id" offset 0; a later bg_output covers it]` |
| `duplicate_search` | Un `search_text` posterior tiene los mismos argumentos y las mismas coincidencias (el código de salida y las líneas `match`/`context`; se ignora el tiempo transcurrido) | `[elided: search_text "pattern"; identical to a later result]` |

Una consulta de `bg_output` que continúa desde un `next_offset` previo **nunca** se elide: la salida
en segundo plano se lee de forma incremental, así que cada fragmento es información nueva.

Nunca se elide: el último resultado de una ruta, nada de la última vuelta, los resultados con error,
los mensajes del usuario, los checkpoints de compactación ni los mensajes del asistente. Un resultado
solo se sustituye cuando tiene al menos `elide.minAgeTurns` mensajes del asistente de antigüedad. Los
stubs son una línea de ASCII (las rutas y los patrones se citan como JSON) y dependen solo de la
llamada elidida, así que el mismo historial produce siempre el mismo stub. Un resultado nunca se sustituye si su stub no es más corto que el original.

### Garantías

- La transcripción guardada nunca cambia. La proyección existe solo en la petición.
- Los IDs de llamada, los roles, el orden y los datos de continuación del proveedor no se tocan: un
  resultado conserva su `callId` y solo cambia su texto.
- `shadow` envía exactamente los bytes que envía `off`.
- Los disparadores de compactación, el límite duro de contexto, la barra de contexto y la entrada del
  resumidor usan el historial **completo**, no la proyección.
- También se aplica a las sesiones de subagentes, cada una con su propio historial.

### Ajustes

```json
{
  "context": {
    "governor": "shadow",
    "elide": { "minAgeTurns": 2, "epochMessages": 32 }
  }
}
```

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `governor` | `"off"` | `"off"`, `"shadow"` o `"on"` |
| `elide.minAgeTurns` | `2` | Mensajes del asistente (1–20) de antigüedad que debe superar un resultado redundante antes de sustituirse |
| `elide.epochMessages` | `32` | La proyección crece en pasos de este número de mensajes (0–1000); `0` proyecta lo antes posible |
| `policyVersion` | sin definir | Fijación opcional de las reglas de elisión (un entero de 1 a la versión actual, que es 1); sin definir sigue a esta versión |

Con `epochMessages` mayor que 0, solo son elegibles los primeros
`floor(longitud / epochMessages) * epochMessages` mensajes. Entre dos épocas la petición solo crece
añadiendo al final, así que la caché de prompt del proveedor sigue acertando; en el límite de una
época los resultados que se han vuelto redundantes se elidirán de golpe.

### Límites de las garantías

La proyección es estable al añadir mensajes, con estas excepciones, cada una de las cuales reescribe o
reinterpreta el historial a propósito:

- Una compactación sustituye los mensajes antiguos por un checkpoint.
- La reducción en el sitio de una transcripción que supera el límite recorta resultados de
  herramientas; recortar el resultado posterior que justificaba una elisión puede volver a mostrar el
  anterior.
- Cambiar el modo o los ajustes de `elide` cambia la política.

Las rutas se comparan tal como están escritas: `./a.ts` y `a.ts` son archivos distintos para el
governor, lo que solo supone perder un ahorro. Un resultado de `read_file` sin `sha256` (archivos de
más de 1 MiB) solo puede elidirse por una escritura o edición posterior. Las cifras de tokens son
estimaciones (unos cuatro caracteres por token), no el uso real del proveedor. En esta versión las
decisiones solo se guardan en memoria; ningún evento ni pantalla las muestra todavía.
