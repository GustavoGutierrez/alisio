# Interfaz de terminal

Sin subcomando, y con stdin y stdout conectados a una terminal, Alisio abre una TUI construida con
[`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui). Acepta los mismos
flags globales que el resto de la CLI (`--config`, `--model`, `--allow-write`, `--allow-process`,
`--read-only`, etc.).

```sh
alisio --config ./my-api.json
alisio resume <id>        # TUI on an existing session
alisio --no-tui           # plain readline mode instead of the TUI
```

`run`, `resume <id> "prompt"` y `--json` nunca abren la TUI. La TUI usa la pantalla alternativa de la
terminal; al salir imprime la conversación y el ID de sesión.

## Pantalla de inicio

Las sesiones interactivas comienzan con una pantalla de inicio: la mascota (por defecto "Ali", un
espíritu-nube de los vientos alisios), la versión, una línea de bienvenida, el modelo, el host del
proveedor (nunca las claves), el directorio de trabajo, el acceso (estado de `write`/`process` o
`read-only`), si la memoria está activada, los plugins cargados y dos consejos rotativos. Se dispone
en paralelo cuando la terminal es ancha y apilada cuando es estrecha; por debajo de 40 columnas la
mascota se reduce a una sola línea. En la TUI es el primer bloque de la conversación y se desplaza
con ella; en el modo `--no-tui` se imprime en stderr.

Solo se muestra en la TUI interactiva (stdout es una terminal) o en el modo readline (solo cuando
stderr es una terminal). Nunca se muestra con `run`, `resume <id> "prompt"`, `--json`, `--quiet`,
`--no-banner`, cuando la variable de entorno `CI` está definida, ni cuando el flujo de destino no es
una terminal. La salida JSONL nunca se ve afectada, aunque los plugins registren una mascota.

```sh
alisio --no-banner        # interactive, without the startup screen
alisio --quiet            # no startup screen and no non-essential hints
```

`TERM=dumb` la muestra en ASCII sin color, `NO_COLOR` desactiva el color y una locale `C`/`POSIX`
cambia a ASCII. Los plugins pueden reemplazar la mascota o toda la pantalla mediante
[puntos de extensión](/es/plugins#extension-points).

## Disposición

La pantalla se reorganiza al redimensionar la terminal, y cada línea se trunca o ajusta al ancho.

| Zona | Contenido |
| --- | --- |
| Cabecera | Versión, modelo, host del proveedor (nunca la clave ni la ruta), modo de API, directorio de trabajo abreviado, ID corto de sesión y permisos con color (`write`/`process`: `on`, `ask` u `off`; `mcp`; `read-only`) |
| Conversación | Mensajes del usuario resaltados; respuestas del asistente en streaming renderizadas como Markdown (títulos, negritas, listas, código en línea y en bloque, enlaces). El razonamiento visible que envía el proveedor (por ejemplo `reasoning_content` de DeepSeek) se muestra atenuado mientras llega y luego se colapsa en una línea; nunca se persiste ni se reenvía |
| Bloques de herramientas | Un bloque por llamada: nombre, argumento resumido (ruta, comando, patrón), spinner mientras se ejecuta, estado ✓/✗, duración y vista previa truncada. `edit_file`/`write_file` muestran un diff `+`/`-` calculado a partir de los argumentos |
| Barra de estado | Contexto usado frente a la ventana, `used / total (pct%)`, con barra verde (< 60 %), amarilla (< 85 %) o roja; tokens acumulados de entrada/salida y en caché (`⚡`) cuando se informan; turnos; duración del turno en curso; estado; estado de plugins (por ejemplo `mem N`) |
| Selectores | Listas seleccionables para `/model`, `/resume` y las aprobaciones |

Los errores aparecen en rojo dentro de la conversación sin cerrar la TUI.

La ventana de contexto proviene de `provider.contextWindow`, luego del campo `context_window` (o
`context_length`) de `GET /models`, y en otro caso es `unknown`. El contexto usado es el último
`prompt + completion` informado por el proveedor; sin `usage`, se muestra una estimación marcada con
`~` (unos 4 caracteres por token).

## Comandos

Al escribir `/` se abre el autocompletado.

| Comando | Función |
| --- | --- |
| `/help` | Comandos y teclas |
| `/model [id]` | Sin argumento: lista seleccionable de `GET /models` (o el modelo configurado). Con argumento: cambia directamente. Aplica al siguiente turno y queda guardado en la sesión |
| `/compact [focus]` | Resume la historia antigua con el modelo actual, con instrucciones de foco opcionales |
| `/stats` | Tokens (entrada, salida, caché), turnos, llamadas y errores por herramienta, duración, modelos, contexto y detalles de plugins |
| `/clear` (`/new`) | Inicia una sesión nueva con el modelo actual |
| `/sessions` | Sesiones recientes del workspace |
| `/resume <id>` | Reanuda por ID o prefijo; sin argumento muestra un selector |
| `/tools` | Herramientas y su estado según los permisos (`enabled`, `ask`, `disabled`) |
| `/copy` | Copia la última respuesta del asistente al portapapeles |
| `/init [focus]` | [Plantilla de prompt](/es/prompt-templates#built-in-init) integrada: analiza el repositorio y crea o actualiza el `AGENTS.md` raíz |
| `/exit` (`/quit`) | Salir |
| `/skill:name request` | Carga una skill y envía la solicitud |
| `/command plugin.id:name args` | Ejecuta un comando de plugin |
| `/memory …` | Comando del plugin integrado de memoria; consulte [Memoria persistente](/es/memory) |
| `/agents …` | Comando del plugin integrado de subagentes: lista, `open`, `cancel`, `kill`, `resume`, `merge`, `discard`, `defs`; consulte [Subagentes](/es/subagents#in-the-tui) |

`/init` es una plantilla de prompt, no el comando `alisio init`: `alisio init` solo escribe un
`.alisio/config.json` de ejemplo. Las demás [plantillas de prompts](/es/prompt-templates) aparecen en
una sección propia de `/help` y en el autocompletado.

Los demás comandos de plugins se enrutan de la misma manera y aparecen en `/help` y en el
autocompletado. Mientras un turno está en curso, los prompts y los comandos `/model`, `/compact`,
`/clear` y `/resume` esperan: pulse Esc para interrumpir primero.

En el modo `--no-tui` los comandos admitidos son `/exit`, `/new`, `/skill:name request` y
`/command plugin.id:name args`. Las líneas se procesan secuencialmente; Ctrl+C cancela y sale.

## Teclas

| Tecla | Acción |
| --- | --- |
| Enter | Enviar |
| Shift+Enter, Alt+Enter, Ctrl+J | Insertar una línea nueva (depende de la terminal) |
| Tab | Autocompletar |
| ↑ / ↓ | Historial de entrada |
| Esc | Interrumpir el turno en curso |
| Ctrl+C | Borrar la entrada; interrumpir un turno activo; pulsado dos veces con la entrada vacía, salir |
| Ctrl+D | Salir cuando la entrada está vacía |
| PgUp / PgDn, rueda del ratón | Desplazar la conversación |
| Ctrl+X | Enfocar el [panel de agentes](#agent-panel) |
| Ctrl+B | Pasar a segundo plano los agentes en primer plano en ejecución (durante un turno) |
| Ctrl+K | Cancelar el agente seleccionado o visualizado |

## Panel de agentes {#agent-panel}

Cuando se ejecutan [subagentes](/es/subagents), aparece bajo el editor un panel en árbol plegable. Su
cabecera muestra cuántos agentes están en ejecución, en cola y terminados; cada fila muestra un icono
de estado, el nombre y el color del agente, el tiempo transcurrido, los tokens y un resumen en vivo de
una línea. La sangría muestra padre → hijo.

| Foco | Tecla | Acción |
| --- | --- | --- |
| Editor | Ctrl+X, o ↓ con el editor vacío cuando hay agentes | Enfocar el panel |
| Editor | Ctrl+X y después ↓ en menos de 800 ms | Abrir directamente el primer agente |
| Panel | ↑ / ↓ | Mover la selección |
| Panel | → | Expandir, o entrar en los hijos |
| Panel | ← | Plegar, o ir al padre |
| Panel | Enter | Abrir la conversación del agente en una vista de solo lectura |
| Panel | Esc, Tab | Volver al editor |
| Vista de hijo | ↑ | Agente padre (desde un agente de primer nivel, vuelve a la conversación raíz) |
| Vista de hijo | ↓ | Primer hijo |
| Vista de hijo | ← / → | Hermano anterior / siguiente |
| Vista de hijo | Esc | Volver a la conversación raíz |
| Panel o vista de hijo | Ctrl+K | Cancelar el agente seleccionado o visualizado (pide s/n —`y`/`n`— cuando tiene descendientes) |
| Cualquiera | Ctrl+B | Pasar a segundo plano los agentes en primer plano en ejecución |

En una vista de hijo, el pie muestra la ruta del agente, su índice y el total, el porcentaje de
contexto, los tokens y sugerencias de teclas. Escribir mientras el panel tiene el foco devuelve el
foco al editor.

## Copiar al seleccionar

La TUI captura el ratón. Al arrastrar se selecciona texto y se copia al portapapeles con la primera
herramienta disponible, sin shell:

| Plataforma | Herramientas probadas en orden |
| --- | --- |
| Linux | `wl-copy`, `xclip -selection clipboard`, `xsel -b` (más las herramientas de Windows bajo WSL) |
| macOS | `pbcopy` |
| Windows | `clip.exe`, PowerShell `Set-Clipboard` |

Si ninguna funciona, Alisio envía una secuencia de escape OSC 52 y la informa como **no verificada**,
porque la terminal no puede confirmarla. `/copy` copia la última respuesta del asistente de la misma
manera.

Mientras la captura del ratón está activa, la selección nativa de la terminal suele requerir
**Shift+arrastrar**.

## Aprobaciones interactivas {#interactive-approvals}

En la TUI, cuando `write` o `process` no están permitidos mediante flags, las herramientas
correspondientes se ofrecen igualmente al modelo, y Alisio pregunta antes de ejecutarlas:

- **Permitir una vez** (*Allow once*)
- **Permitir siempre `<effect>` en esta sesión** (*Always allow*; dura mientras vive el proceso)
- **Denegar** (*Deny*)

Con `--read-only` no se pregunta y esas herramientas siguen desactivadas. Los modos headless nunca
preguntan. El tiempo de espera de una aprobación cuenta dentro de `limits.timeoutMs`. Consulte
[Herramientas y permisos](/es/tools).
