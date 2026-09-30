# Interfaz web (`alisio serve`)

`alisio serve` arranca un servidor HTTP local que da acceso desde el navegador a varios workspaces
y sesiones a la vez. Conduce el mismo núcleo de agente que la terminal: sesiones, ejecuciones,
aprobaciones y la base de datos de sesiones se comparten con la TUI y con `alisio run`.

::: warning Estado
El servidor, su API y la interfaz del navegador están disponibles, incluidos los adjuntos de
imagen, el panel de archivos, la vista de trayectoria y los renderizadores de desarrollo (diff,
terminal, JSON, resultados de tests). El renderizado de Mermaid y fórmulas y la gestión de plugins y
modelos llegan en versiones posteriores. Consulte [Limitaciones conocidas](/es/limitations).
:::

## Arrancar el servidor

```sh
alisio serve                      # http://127.0.0.1:4317, opens the browser
alisio serve --no-open --port 0   # any free port, print the URL only
alisio serve --allow-write        # web sessions may write files without asking
```

El comando imprime una URL de arranque con un token de un solo uso, por ejemplo
`http://127.0.0.1:4317/?token=…`. Al abrirla, el token se canjea por una cookie de sesión y se
redirige a `/`. Mantenga la URL en privado: quien la abra primero en un navegador puede conducir el
agente con sus permisos. Pulse `Ctrl+C` (o envíe `SIGTERM`) para detener el servidor; un segundo
`Ctrl+C` fuerza la salida.

`alisio`, `alisio run` y la TUI nunca cargan el servidor: solo lo importa `alisio serve`.

## Flags

| Flag | Por defecto | Descripción |
| --- | --- | --- |
| `--port <port>` | `4317` | Puerto de escucha; `0` elige uno libre |
| `--host <address>` | `127.0.0.1` | Dirección de enlace; cualquier cosa que no sea loopback exige `--allow-remote` |
| `--allow-remote` | desactivado | Permite un `--host` que no sea loopback (sin TLS; mejor un túnel SSH) |
| `--no-open` | abre | No abre el navegador |
| `--max-workspaces <n>` | `4` | Workspaces con una aplicación abierta a la vez |
| `--max-runs <n>` | `4` | Ejecuciones simultáneas entre todas las sesiones; las demás esperan en cola |

También se aplican los flags globales. Los flags de permisos (`--allow-write`, `--allow-process`,
`--allow-external`, `--allow-mcp`, `--read-only`) son el **techo** de toda sesión web: el navegador
puede estrecharlos por sesión, pero nunca superarlos. `--trust-project` y `--config` se aplican a
cada workspace que abre el servidor, igual que en la terminal. `--db` elige la base de datos de
sesiones compartida. Defina `ALISIO_LOG_LEVEL` (`debug`, `info`, `warn`, `error`, `silent`) para
controlar las líneas de log JSON que el servidor escribe en stderr.

## Usar la interfaz web

La página tiene una barra lateral a la izquierda y la sesión abierta a la derecha.

**Barra lateral.** **Nueva sesión** empieza una sesión en el workspace que está viendo. Bajo
**Workspaces**, cada carpeta lista sus sesiones, primero las fijadas y luego las usadas más
recientemente, con un tiempo relativo ("4 min"). Un punto antes del título indica una sesión en
ejecución, que espera su respuesta, en uso por otro proceso o cuya última ejecución falló. Los
iconos junto al encabezado buscan sesiones (también `Ctrl+K` / `Cmd+K`), muestran las sesiones
archivadas y abren otro workspace por su ruta absoluta. Al pasar sobre una sesión aparecen **Fijar**
y **Archivar**, y sobre una carpeta, una nueva sesión dentro de ella. **Ajustes** está abajo; el
icono de panel contrae la barra a un riel estrecho. Por debajo de 900 px la barra lateral pasa a ser
un cajón que se abre desde la cabecera.

**Cabecera.** Haga clic en el título para renombrar la sesión (las sesiones sin título muestran su
primer prompt). La insignia muestra el agente y el preset de permisos. **Log de sesión** descarga la
sesión como JSON Lines: cada evento durable en el formato de `alisio run --json` y después una línea
`{"type":"message"}` por cada mensaje guardado. El icono de panel a la derecha abre el panel de
archivos (más abajo). Las pestañas **Conversación** y **Trayectoria** cambian la vista principal.

**Conversación.** Sus mensajes aparecen a la derecha con un botón de copiar. El trabajo del agente
aparece como filas de una línea: `Razonamiento · …`, `Inyección de contexto · AGENTS.md` y una fila
por llamada a herramienta, como `Read · README.md` o `Shell · npm test`. Haga clic en una fila para
ver su entrada y su salida. La respuesta llega en streaming como Markdown; los bloques de código
tienen etiqueta de lenguaje, **Ajustar líneas** y **Copiar**, y se resaltan cuando entran en
pantalla. Los enlaces a rutas del workspace abren el archivo en el panel de archivos. El
razonamiento es solo de visualización: tras recargar, las filas de razonamiento
anteriores desaparecen porque nunca se guarda. Al desplazarse hacia arriba, un botón vuelve al
último mensaje; las sesiones largas muestran los últimos 30 turnos y cargan los mensajes anteriores
a demanda.

**Salida de herramientas.** Las herramientas que devuelven bloques estructurados tienen una vista
nativa, que se carga la primera vez que hace falta: las escrituras y ediciones de archivos muestran
un diff (unificado por defecto, **Lado a lado** a demanda, hunks plegables y una lista de archivos
cuando un parche toca varios); los comandos de shell muestran su salida con colores ANSI, el código
de salida y la duración, en streaming mientras se ejecutan y con las últimas 2 000 líneas visibles
detrás de **Mostrar líneas anteriores**; JSON se muestra como un árbol plegable con copia de valores
y de su JSONPath; los resultados de tests muestran el total de correctos, fallidos y omitidos con
un filtro **Solo fallos**; los bloques de progreso muestran sus pasos. El texto original de la
herramienta, que es lo que recibió el modelo, queda bajo **Salida en bruto**. Un bloque que la
página no conoce muestra su texto y el JSON plegado. El icono de panel de una fila de herramienta
con ruta abre ese archivo.

**Trayectoria.** La pestaña **Trayectoria** lista los eventos durables de la sesión agrupados por
ejecución: estado, hora de inicio, turnos y duración de cada ejecución, y una fila por evento con su
hora, turno, tipo, un resumen breve y su duración cuando la tiene. Se actualiza a medida que llegan
eventos; las ejecuciones antiguas quedan detrás de **Mostrar runs anteriores**.

**Panel de archivos.** El icono de panel de la cabecera abre un panel a la derecha (una hoja
inferior por debajo de 900 px) con tres pestañas. **Archivos** recorre el workspace a demanda, de
1 000 en 1 000 entradas, ocultando `.git` y, en repositorios git, lo que excluye `.gitignore`.
**Cambios** lista los archivos que esta sesión (y sus subagentes) escribió, los más recientes
primero, con su código de `git status`; al elegir uno se ven su diff frente a `HEAD` y el archivo.
**Vista previa** muestra texto y código resaltado, Markdown, JSON como árbol e imágenes; los
archivos de más de 2 MB se recortan con un enlace **Descargar**, los binarios solo se pueden
descargar, y HTML o SVG se muestran como código, nunca como página. Desde la vista previa se puede
copiar la ruta, descargar el archivo o mencionarlo (`@ruta`) en el compositor.

**Compositor.** `Enter` envía, `Shift+Enter` inserta un salto de línea, y `↑`/`↓` en la primera línea
recorren los prompts enviados. Escribir `/` abre la paleta de comandos (flechas para moverse,
`Enter` o `Tab` para elegir, `Esc` para cerrar): los comandos se ejecutan en el servidor y su salida
aparece en la conversación; las plantillas de prompt, las skills y `/ask` se convierten en un
prompt. `/` fuera de un campo de texto lleva el foco al compositor. Debajo del cuadro de texto:

| Control | Qué hace |
| --- | --- |
| `+` | Adjuntar imágenes PNG, JPEG, GIF o WebP, de hasta 10 MB cada una y 8 por mensaje (también se pueden pegar o arrastrar) |
| Preset de permisos | `Solo lectura`, `Preguntar`, `Escritura en workspace` o `Acceso total` para esta sesión |
| Modelo y esfuerzo | Modelo del proveedor del workspace y el esfuerzo de razonamiento que admite |
| Anillo de contexto | Contexto estimado de la próxima petición frente a la ventana del modelo |
| Enviar / Detener | Detener sustituye a Enviar mientras hay una ejecución activa y el cuadro está vacío |

Mientras hay una ejecución activa puede seguir escribiendo: el texto se encola para el siguiente
turno de la sesión. Las imágenes se suben en cuanto se añaden y aparecen como miniaturas que se
pueden quitar; solo se pueden enviar cuando no hay una ejecución activa.

**Línea de estadísticas.** Bajo el compositor, una línea resume la última ejecución: turnos, pasos
(llamadas a herramientas), tiempo en el modelo y en herramientas, tiempo medio hasta el primer
token, tokens de salida por segundo, la parte de la entrada servida desde la caché de prompts del
proveedor y los tokens de entrada. Al pasar el ratón se ven los totales de toda la sesión. La caché
muestra `—` cuando el proveedor no informa de la entrada en caché.

**Aprobaciones y preguntas.** Cuando una herramienta necesita aprobación, un panel ocupa el lugar del
compositor y recibe el foco: indica la herramienta, el efecto y su entrada. Responda con **Denegar**
(`D`), **Permitir una vez** (`O`) o **Permitir en la sesión** (`S`); las teclas pulsadas en los
primeros 300 ms se ignoran para que un `Enter` accidental no apruebe. Las preguntas de plugins (por
ejemplo `ask_user_question`) aparecen del mismo modo.

**Ajustes.** Elija el idioma (inglés o español; por defecto el del navegador), el tema (oscuro, claro
o sistema) y si las filas de herramientas empiezan plegadas o desplegadas. Estas preferencias se
guardan solo en este navegador.

## Modelo de seguridad

El servidor está pensado para un usuario en una máquina:

- Se enlaza a `127.0.0.1` por defecto. Exponerlo en una red exige `--host <address>
  --allow-remote` y muestra una advertencia; no hay TLS, así que use un túnel SSH en su lugar.
- Se genera un token de arranque de 256 bits por proceso que nunca se escribe en disco. El
  navegador lo canjea una vez por una cookie `HttpOnly; SameSite=Strict` que guarda otro secreto.
- Toda petición debe nombrar a este servidor en `Host` (defensa contra DNS rebinding), y las
  peticiones con efectos necesitan un `Origin` coincidente y `Content-Type: application/json`
  (defensa contra CSRF).
- Las respuestas llevan una Content-Security-Policy estricta, `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: no-referrer` y políticas de opener/recursos del mismo origen; las respuestas de
  la API no se cachean.
- Las aprobaciones fallan cerradas: si ninguna pestaña del navegador observa la sesión durante 30
  segundos, si la ejecución se cancela o tras 10 minutos, la respuesta es **denegar**.
- Los plugins no están aislados: los plugins de un proyecto de confianza se ejecutan dentro del
  proceso del servidor con sus permisos del sistema operativo, exactamente igual que en la
  terminal.

## Workspaces y confianza

Un workspace es un directorio (su raíz git cuando está dentro de un repositorio). El servidor lista
los workspaces de las sesiones existentes más el directorio donde arrancó `alisio serve`, y abre una
aplicación para un workspace solo cuando se usa. Como mucho hay `--max-workspaces` abiertos a la
vez: el inactivo usado hace más tiempo se cierra para dejar sitio y, cuando todos están ocupados, la
petición falla con `workspace_limit`. Los workspaces inactivos se cierran tras 10 minutos.

La web nunca concede confianza de proyecto. Un directorio cuya configuración `.alisio` no haya
aceptado desde la terminal se abre sin sus recursos de proyecto (plugins, skills, prompts,
configuración) y se marca como no confiable. Ejecute `alisio` en ese directorio para responder a la
pregunta de confianza.

## Sesiones, ejecuciones y permisos

Varias sesiones pueden ejecutarse a la vez, en uno o varios workspaces. Una sesión ejecuta un
prompt cada vez: el texto enviado mientras se ejecuta se encola para su siguiente turno, mientras
que los adjuntos deben esperar a que quede inactiva. Las ejecuciones que superan `--max-runs`
esperan en una cola por orden de llegada. Reintentar un prompt con el mismo id de petición nunca
inicia una segunda ejecución.

Una sesión que usa otro proceso de Alisio (por ejemplo la TUI) aparece bloqueada y es de solo
lectura en la web hasta que ese proceso la libere.

Cada sesión tiene un preset de permisos. Los efectos que los flags de arranque no permiten siguen
preguntando, sea cual sea el preset:

| Preset | Permitido sin preguntar | Otros efectos |
| --- | --- | --- |
| `read-only` | lecturas | denegados |
| `ask` | lecturas | piden aprobación |
| `workspace-write` (por defecto) | lecturas, escrituras | piden aprobación |
| `full-access` | lecturas, escrituras, procesos, red | piden aprobación |

"Permitir para la sesión" en una aprobación amplía solo esa sesión, nunca las demás sesiones del
mismo workspace.

## API y eventos

El navegador habla con rutas JSON bajo `/api` y con un único stream de Server-Sent Events por
pestaña:

```text
GET  /api/health                       unauthenticated: name, version, protocolVersion, capabilities
GET  /api/workspaces                   POST /api/workspaces {path}   PATCH /api/workspaces/:wid
GET  /api/sessions                     POST /api/sessions            GET|PATCH /api/sessions/:sid
GET  /api/sessions/:sid/messages       GET /api/sessions/:sid/events GET /api/sessions/:sid/runs
POST /api/sessions/:sid/prompts        POST /api/sessions/:sid/cancel  POST /api/sessions/:sid/compact
GET  /api/sessions/:sid/models         GET /api/sessions/:sid/context GET /api/sessions/:sid/export
GET  /api/commands?session=<sid>       POST /api/sessions/:sid/commands {requestId, name, args?}
GET  /api/approvals                    POST /api/approvals/:aid      POST /api/interactions/:iid
GET  /api/workspaces/:wid/tree?path=&cursor=   GET /api/workspaces/:wid/file?path=&maxBytes=&download=1
GET  /api/workspaces/:wid/diff?path=   GET /api/sessions/:sid/changes
POST /api/blobs                        raw image body (not JSON) → BlobRef   GET /api/blobs/:hash
GET  /api/events?session=<sid>         the event stream (snapshot, then live frames)
```

En cada (re)conexión el stream envía un snapshot de cada sesión suscrita (mensajes recientes, texto
que aún se está generando, aprobaciones pendientes) seguido de frames en vivo; los eventos durables
llevan su `eventId` como `id` de SSE, y el texto generado llega agrupado unas 30 veces por segundo.
La versión del protocolo aparece en `/api/health` y en el primer frame del stream.

## Limitaciones

- Un solo host: los bloqueos de sesión dependen de ids de proceso, y la web no ve en vivo los
  cambios que una TUI hace en una sesión hasta que la sesión se vuelve a abrir.
- Sin TLS; el acceso remoto es opcional y está pensado para túneles SSH.
- El proveedor es por workspace: todas las sesiones de un workspace usan su perfil de proveedor
  activo; la web cambia el modelo dentro de él.
- El binario independiente sirve solo la API; los assets de la interfaz web se distribuyen con el
  paquete npm.
- La interfaz web conserva la salida de comandos, los avisos y el razonamiento solo mientras la
  página está abierta; al recargar, la conversación se reconstruye desde los mensajes guardados.
- El panel de archivos muestra solo el workspace: los directorios añadidos con `--add-dir` no se
  pueden recorrer, los enlaces simbólicos se listan pero nunca se siguen (aunque apunten dentro del
  workspace) y el filtrado por `.gitignore` necesita `git` en el `PATH`. **Cambios** solo conoce los
  archivos escritos con `write_file` y `edit_file`; los que cambia un comando de shell aparecen en
  `git status`, no ahí.
- Las imágenes subidas se guardan una vez por hash de contenido junto a la base de datos de
  sesiones y no se borran automáticamente.
