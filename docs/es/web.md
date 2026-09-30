# Interfaz web (`alisio serve`)

`alisio serve` arranca un servidor HTTP local que da acceso desde el navegador a varios workspaces
y sesiones a la vez. Conduce el mismo núcleo de agente que la terminal: sesiones, ejecuciones,
aprobaciones y la base de datos de sesiones se comparten con la TUI y con `alisio run`.

::: warning Estado
El servidor y su API ya están disponibles. La interfaz del navegador (`@alisio/web`) aún está en
construcción: hasta que se publique, `alisio serve` sirve una página provisional junto a la API.
Consulte [Limitaciones conocidas](/es/limitations).
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
GET  /api/approvals                    POST /api/approvals/:aid      POST /api/interactions/:iid
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
