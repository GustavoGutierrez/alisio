# Interfaz web (`alisio serve`)

`alisio serve` arranca un servidor HTTP local que da acceso desde el navegador a varios workspaces
y sesiones a la vez. Conduce el mismo núcleo de agente que la terminal: sesiones, ejecuciones,
aprobaciones y la base de datos de sesiones se comparten con la TUI y con `alisio run`.

::: warning Estado
El servidor, su API y la interfaz del navegador están disponibles, incluidos los adjuntos de
imagen, el panel de archivos, la vista de trayectoria, los renderizadores de desarrollo (diff,
terminal, JSON, resultados de tests), los diagramas Mermaid, las fórmulas TeX y las páginas de
Ajustes para modelos, plugins, skills, servidores MCP y presets de agente. Consulte
[Limitaciones conocidas](/es/limitations).
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
`--allow-analysis`, `--allow-external`, `--allow-mcp`, `--read-only`) son el **techo** de toda sesión web: el navegador
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
iconos junto al encabezado buscan sesiones (también `Ctrl+K` / `Cmd+K`), muestran las sesiones y
los workspaces archivados y abren otro workspace (vea [Abrir un workspace](#abrir-un-workspace)).
Al pasar sobre una sesión aparecen **Fijar** y **Archivar**, y sobre una carpeta, una nueva sesión
dentro de ella y su menú de acciones (**Fijar**, **Archivar** / **Desarchivar**). **Ajustes** está abajo; el
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
pantalla. Los enlaces a rutas del workspace abren el archivo en el panel de archivos. Los bloques
` ```mermaid ` se convierten en diagramas, y ` ```math `, los párrafos `$$ … $$` y `\( … \)` en
línea, en fórmulas (un `$` suelto sigue siendo texto, así que los precios no se alteran). La página
carga Mermaid solo cuando un diagrama entra en pantalla y KaTeX con la primera fórmula. Los
diagramas tienen **Fuente**, zoom, **Exportar SVG**, pantalla completa y **Copiar**; las fórmulas,
un botón para copiar su TeX. Un diagrama o una fórmula no válidos muestran su fuente y el error, sin
romper el mensaje. El
razonamiento es solo de visualización: tras recargar, las filas de razonamiento
anteriores desaparecen porque nunca se guarda. Al desplazarse hacia arriba, un botón vuelve al
último mensaje; las sesiones largas muestran los últimos 30 turnos y cargan los mensajes anteriores
a demanda.

**Estado de la ejecución.** Mientras una ejecución está en curso, una línea al final de la
conversación dice lo que realmente está haciendo, a partir únicamente de los eventos y la salida en
streaming que la página ha recibido: *Esperando al modelo…*, *Pensando…*, *Redactando la
respuesta…*, *Leyendo tus datos (ventas.csv)…*, *Ejecutando Python (analisis.py)…*, *Publicando el
artefacto (dashboard.html)…*, *Ejecutando* `<herramienta>`*…*, *Compactando el contexto…*, *El modelo no respondió; reintentando (1/1)…* (mientras se reenvía una
petición silenciosa, ver `limits.firstTokenRetries`) o *Esperando
tu aprobación / tu respuesta* (estas dos nunca cuentan como bloqueo). Junto a ella aparecen el tiempo
transcurrido de la ejecución, el del paso actual y cuándo llegó algo por última vez (*última
actualización hace 3 s*). Si no llega nada durante 15 s, la línea indica cuánto lleva en silencio y
muestra **Detener**; a los 60 s dice sin rodeos *Sin respuesta del modelo desde hace 60 s* (o
*«herramienta» no ha producido salida…* cuando es una herramienta la que se ejecuta) y sugiere
esperar o detener. La espera de un subagente nunca se informa como bloqueo, porque sus eventos
pertenecen a otra sesión. La línea solo lee frames y nunca inventa actividad. Se anuncia a los
lectores de pantalla únicamente cuando cambia el paso o el nivel de silencio (no cada segundo) y su
indicador se detiene con *reducir movimiento*. Tras recargar, el tiempo transcurrido continúa desde
la hora de inicio del servidor; la hora de la *última actualización* se reinicia con la recarga,
porque la página no puede saber cuándo llegó el frame anterior.

Si una ejecución se detiene por su límite de tiempo, la conversación muestra un mensaje que nombra
el modelo y el proveedor, los segundos y cómo continuar (reintentar, cambiar de modelo, subir
`limits.timeoutMs`; ver [configuración](/es/configuration#limits)).

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
con ruta abre ese archivo. Las herramientas que aportan los plugins muestran su propio nombre
seguido del nombre del plugin como etiqueta (por ejemplo `Test report` · `Smoke tools`).

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
prompt. `/` fuera de un campo de texto lleva el foco al compositor.

**Preguntas laterales (`/btw`).** `/btw pregunta` consulta algo sobre la sesión actual sin añadirlo a
la conversación, también mientras un run trabaja. Un panel flotante muestra la pregunta pendiente
(con **Cancelar**), luego la respuesta en Markdown, el modelo y los tokens usados, un botón de copiar
y `‹ 2/5 ›` para recorrer las respuestas laterales anteriores (`←`/`→` cuando el foco no está en un
campo de texto; `Esc` lo cierra y cancela una pregunta pendiente). `/btw` solo abre el panel en tu
respuesta lateral más reciente, o muestra `Usage: /btw <question>` si no hay ninguna. Las preguntas
laterales nunca se escriben en la transcripción, los eventos, los runs ni los tokens de la sesión;
se guardan las 20 últimas por sesión, compartidas con la TUI.

Debajo del cuadro de texto:

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

**Ajustes.** El engranaje al pie de la barra lateral abre Ajustes. Las páginas que gestionan
recursos del agente actúan sobre el workspace de la sesión abierta (o el primer workspace si no hay
ninguna):

| Página | Qué hace |
| --- | --- |
| **General** | Idioma de la interfaz (este navegador) y los ajustes del agente: compactación, contexto, límites, tiempo máximo de los hooks de plugins y proveedor de búsqueda web, guardados en su `config.json` de usuario |
| **Modelos** | Perfiles de proveedor con sus valores no secretos, credenciales y **Activar en este workspace** con un modelo del perfil; **Añadir un perfil** crea uno |
| **Plugins** | **Configuración de plugins** (sin aislamiento, cómo se instalan, el archivo del proyecto) y **Lista de plugins**: búsqueda, contador y tarjetas con una píldora **Habilitado**, **Deshabilitado**, **Con fallo** o **Requiere reinicio**; el chevron muestra versión, categorías, origen, tools, comandos, diagnósticos y el interruptor |
| **Skills** | Skills descubiertas con su ámbito, tamaño e interruptor; las deshabilitadas salen de la paleta `/` |
| **Servidores MCP** | Estado, transporte y contadores de cada servidor configurado, interruptor y **Conectar**; **Conceder acceso MCP** pide antes una confirmación explícita |
| **Presets de agente** | `build`, `plan` y los agentes de usuario o de plugins aptos para la sesión principal, con instrucciones y modelo sugerido; **Usar en esta sesión** cambia la sesión abierta |
| **Apariencia** | Tema (oscuro, claro o sistema) y si las filas de herramientas empiezan plegadas o desplegadas, guardado en este navegador |

**Abrir archivo de configuración** (arriba a la derecha) muestra el archivo de configuración
efectivo del workspace, su archivo de ajustes de usuario y el de perfiles de proveedor, cada uno con
un botón de copiar. El servidor nunca abre un editor.

Las credenciales son de solo escritura. El campo de una credencial es de tipo contraseña: tras
**Guardar** se vacía y la página solo indica si hay un valor guardado, si viene de una variable de
entorno y, para valores guardados de 16 caracteres o más, los tres últimos caracteres
(`Guardada · termina en …71B`). Ninguna respuesta de la API contiene un secreto.

Habilitar o deshabilitar un plugin escribe un ajuste del proyecto (`.alisio/config.json`) y requiere
que el workspace sea de confianza. Los plugins se cargan al arrancar la aplicación del workspace,
así que el servidor recarga esa aplicación en cuanto no tiene runs: de inmediato si está inactiva o,
si no, cuando termina su último run (mientras tanto la tarjeta muestra **Requiere reinicio**). Las
sesiones conservan su historial y todas las paletas de comandos abiertas se actualizan. Los
interruptores de skills se aplican al momento. Los plugins no se instalan desde la web.

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
- El diálogo nativo de carpetas y el explorador de carpetas integrado solo existen en loopback. El
  explorador lista nombres de directorios (nunca archivos ni contenidos) que el usuario del servidor
  puede leer, la misma confianza que la terminal de ese usuario; con `--allow-remote` ambos se
  desactivan y solo se acepta una ruta escrita.

## Workspaces y confianza

Un workspace es un directorio (su raíz git cuando está dentro de un repositorio). El servidor lista
los workspaces de las sesiones existentes más el directorio donde arrancó `alisio serve`, y abre una
aplicación para un workspace solo cuando se usa. Como mucho hay `--max-workspaces` abiertos a la
vez: el inactivo usado hace más tiempo se cierra para dejar sitio y, cuando todos están ocupados, la
petición falla con `workspace_limit`. Los workspaces inactivos se cierran tras 10 minutos.

Un workspace cuya carpeta se eliminó o se movió sigue en la barra lateral, atenuado y marcado como
"carpeta no encontrada": sus sesiones siguen visibles, pero no se pueden crear sesiones ni enviar
prompts en él (el servidor responde `404 workspace_missing`). **Nueva sesión** usa el workspace de
la sesión actual o el usado más recientemente que todavía exista; si no hay ninguno, pide abrir un
workspace. Las carpetas con el mismo nombre muestran junto a él una ruta padre corta, y la ruta
completa al pasar el ratón.

Archive un workspace desde su menú de acciones para ocultarlo, junto con sus sesiones, de la barra
lateral; **Mostrar archivados** vuelve a mostrar ambos (los workspaces archivados van al final).
Archivar conserva todas las sesiones, que siguen visibles, cierra la aplicación inactiva del
workspace y se rechaza con `409 runs_active` mientras haya una ejecución activa. Las sesiones nuevas
en un workspace archivado se rechazan con `409 workspace_archived`; **Desarchívelo**, o vuelva a
abrir la misma carpeta, para usarlo. Así se oculta también un workspace cuya carpeta ya no existe.

### Abrir un workspace

El botón de carpeta junto a **Workspaces** (y **Nueva sesión** cuando aún no hay ningún workspace)
pide una carpeta de la mejor forma que admita el servidor:

1. **Diálogo nativo de carpetas.** Los navegadores nunca dan a una página la ruta absoluta de una
   carpeta, así que el servidor abre el diálogo del propio sistema operativo en su escritorio y usa
   la carpeta elegida (una nota en la barra lateral lo indica mientras está abierto; solo un diálogo
   a la vez).
   - **Linux** (y BSD): `zenity`, si no `kdialog`, si no `yad`, buscados en `PATH`; necesita una
     sesión de escritorio (`DISPLAY` o `WAYLAND_DISPLAY`).
   - **macOS**: `osascript` con `choose folder` de AppleScript.
   - **Windows**: Windows PowerShell (o `pwsh`) con el diálogo de carpetas de WinForms y, como
     alternativa, el explorador de carpetas de Shell.
2. **Explorador de carpetas integrado** cuando no hay herramienta de diálogo (máquina sin escritorio,
   sesión SSH, `ALISIO_NATIVE_PICKER=0`): una ventana que solo lista nombres de carpetas, empieza en
   su carpeta personal y tiene migas de pan, un botón de carpeta superior y **Mostrar carpetas
   ocultas**. En Windows, el nivel superior lista las unidades.
3. **Escribir una ruta** está siempre disponible como enlace y es la única opción cuando el servidor
   escucha para acceso remoto (`--allow-remote`), porque un diálogo o un listado de carpetas
   mostraría la máquina del servidor y no la suya.

Un directorio en el que no haya confiado se abre sin sus recursos de proyecto (configuración,
plugins, agentes, skills, prompts) y se marca como no confiable. Confíe en él desde su menú **⋯** de
la barra lateral (**Confiar en este workspace…**) o desde el editor de [Agentes](/es/agents), tras
una confirmación que explica lo que desbloquea la confianza; o ejecute `alisio` en ese directorio
para responder a la pregunta de la terminal. Ambos guardan la misma decisión, ligada al contenido de
`.alisio/config.json`: si ese archivo cambia, el workspace vuelve a no ser de confianza hasta que lo
confirme. El workspace se reabre para que el cambio se aplique al momento (se rechaza mientras tenga
ejecuciones activas, con `--read-only` y cuando `--trust-project`/`--config` fijan la confianza del
servidor). **Dejar de confiar en este workspace…** la retira.

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

### Análisis en Python y artefactos {#artifacts}

Los archivos que publica el [análisis en Python](/es/analysis) aparecen como tarjetas debajo de las
filas de herramientas del turno que los produjo: icono del tipo, nombre del archivo, etiqueta del
tipo y un botón de descarga siempre visible. Con el puntero encima o el foco del teclado, una
tarjeta previsualizable dice **Abrir archivo** en lugar de su tipo; una tarjeta que no se puede
previsualizar (DOCX, ZIP, archivos desconocidos o por encima del límite) nunca lo dice, y el
clic la descarga. Las tarjetas sobreviven a las recargas (salen de los resultados de herramienta
guardados) y muestran **Eliminado** o **Caducado** cuando el artefacto ya no existe, o **No
disponible** con **Reintentar** cuando no se pudo abrir.

Abrir una tarjeta muestra el **panel de artefactos** a la derecha del chat, en la misma ranura que el
panel de archivos (abrir uno cierra el otro):

- **Menú del título**: cambia entre los artefactos de la sesión (los más recientes primero, con
  filtro a partir de ocho, flechas, Enter, Esc y escritura para saltar; los publicados mientras
  tanto llevan un punto y nunca cambian la vista), y después **Abrir en una pestaña nueva**
  (dashboards y PDF), **Expandir panel**, **Descargar fuentes del análisis** (salidas de
  `python_run`), **Copiar al workspace…**, **Detalles**, **Ejecutar de nuevo** (salidas de
  `python_run`) y **Eliminar**. Un artefacto caducado sigue en la lista marcado como **Caducado**;
  al abrirlo solo ofrece **Detalles** y **Ejecutar de nuevo**.
- **Descargar**, **Pantalla completa** y **Cerrar** a la derecha; Cerrar devuelve el foco a la
  tarjeta.
- **Redimensionar** con el asa entre el chat y el panel (compartida con el panel de archivos):
  arrastrar, doble clic para restablecer, o enfocarla y usar ←/→ (16 px, 64 px con Shift),
  Inicio/Fin y Enter. El ancho se recuerda por navegador; el chat conserva al menos 360 px.
- **Vistas previas**: Markdown con el renderer del chat (las imágenes relativas se resuelven dentro
  del artefacto), dashboards HTML en el visor aislado, imágenes con Ajustar/100 %, PDF en el visor
  del propio navegador, JSON con el renderer de JSON, CSV, TSV y XLSX en el [visor de tablas](#tables), y código y texto
  con el renderer de código. Cualquier otro tipo, o lo que supere su límite, muestra el motivo y un botón **Descargar**.
- Por debajo de 900 px el panel es un diálogo a pantalla completa. **Esc** cierra primero el menú
  abierto y después el panel. Ajustes y Agentes se abren encima del panel, que sigue cargado detrás.
- **Copiar al workspace…** pide una carpeta y ejecuta la herramienta `artifact_export` en la sesión:
  se aplica la aprobación de escritura habitual y los archivos copiados aparecen en **Cambios**.
  `/artifacts [filtro]` abre el panel con su menú.

Los dashboards se ejecutan en un iframe con `sandbox="allow-scripts allow-downloads"` (nunca
`allow-same-origin`), servido desde `/artifact-view/<token>/…` con un enlace firmado que caduca a
los 10 minutos. Su Content-Security-Policy prohíbe toda conexión (`connect-src 'none'`) y añade la
directiva `sandbox`, así que la página tiene un origen opaco: no puede leer la cookie, la página de
Alisio, `localStorage` ni la red, tampoco al abrirla en una pestaña nueva. Los datos deben ir
incrustados en el HTML.

Ejecutar Python pregunta en el panel de aprobación con el título **¿Ejecutar análisis en Python?**,
la advertencia de que Python administrado no es un sandbox y las primeras 40 líneas del script;
**S** (**Permitir en esta sesión**) guarda el permiso para la sesión. El botón de llave de la
cabecera abre **Permisos de la sesión**, que lista los permisos guardados con **Revocar**;
`/permissions` también lo abre. Las demás pestañas se actualizan cuando se guarda o revoca un
permiso. `alisio serve --allow-analysis` permite Python sin preguntar en las sesiones cuyo preset
permite procesos (`full-access`); en las demás pregunta.

**Ejecutar de nuevo** repite el análisis como una ejecución nueva con artefactos nuevos (los
antiguos se conservan). Es una llamada `python_run { rerunOf }` de la sesión, así que se aplica el
permiso anterior y la aprobación muestra el script guardado; **Detalles** nombra la ejecución que
repite una repetición. Instalar los paquetes opcionales de Python pregunta con **¿Instalar paquetes
de Python?**, la lista de paquetes, la estimación de descarga y que necesita red, y ofrece solo
**Permitir esta vez** y **Denegar** (`S` no hace nada: nunca se guarda).

### Ajustes → Análisis de datos {#analysis-settings}

La página **Análisis de datos** de Ajustes muestra el runtime en solo lectura (modo, el Python
encontrado o cómo instalarlo en tu sistema, los paquetes opcionales, el motor e imagen de contenedor
y el recordatorio de que Python administrado no es un sandbox) y edita el interruptor
(`analysis.enabled`), el tiempo máximo de ejecución y los tres valores de retención. El servidor
valida los cambios, se escriben en el archivo de configuración global y se muestra cuándo fue la
última limpieza. `runtime` y `oci.*` no se editan aquí. Consulta
[Configuración](/es/configuration#analysis).

### Tablas y datos adjuntos {#tables}

El botón `+` del compositor (y arrastrar y soltar) acepta archivos de datos junto a las imágenes:
CSV, TSV, JSON, JSONL y XLSX. Un archivo se sube como cuerpo crudo de
`POST /api/sessions/:sid/datasets`, se guarda en el almacén de blobs por contenido y se ingiere en
segundo plano en un dataset SQLite (consulta [Datos tabulares](/es/analysis#data)). El chip dice
**Leyendo sales.csv…** mientras el servidor trabaja; el servidor sigue respondiendo (salud, latido)
porque la ingesta se ejecuta en un proceso aparte. Cuando llega el frame `dataset_ready`, el chip
muestra el tamaño de la tabla; un frame `dataset_failed` (archivo no admitido, por encima de
`analysis.data.maxUploadBytes` o `maxRows`, XLSX sin Python) lo convierte en un error con el motivo.
Al enviar el mensaje, el modelo recibe además un resumen acotado (esquema, cinco filas, estadísticas;
como máximo 4 KB), mientras que la conversación muestra lo que escribiste con los chips; un chip abre
la tabla en el panel derecho. Si solo envías datos, se manda una petición por defecto para que los
revise.

El **visor de tablas** (`SpreadsheetView`) también abre artefactos de hoja de cálculo (CSV, TSV, XLSX),
que se ingieren la primera vez que se previsualizan:

- Filas de 28 px fijos y una ventana de filas y columnas, así que una hoja de un millón de filas se
  desplaza con fluidez. Las páginas de 200 filas salen de la API de filas con paginación por clave
  (cursores de `rowid`) mediante una caché de 20 páginas: desplazarse u ordenar nunca repite ni se
  salta una fila. El salto a una fila funciona en cualquier posición sin orden; con orden o filtro
  llega a las primeras 100 000 filas, y las más lejanas se cargan al desplazarse.
- Haz clic en un encabezado para ordenar (ascendente, descendente, ninguno; `aria-sort`), escribe en
  el cuadro de filtro (una columna, o todas hasta 100 000 filas; coincidencia por subcadena), elige
  una hoja en un libro y cambia el ancho de las columnas arrastrando el asa del borde de un
  encabezado, o con **Alt**+←/→ (Mayús para pasos mayores) sobre un encabezado enfocado. El orden y el
  filtro se desactivan por encima de `analysis.data.maxInteractiveRows` (1 000 000) con un aviso: el
  archivo no tiene índices.
- `role="grid"` con recuentos e índices de filas y columnas, una sola parada de tabulador (las flechas,
  Inicio/Fin, RePág/AvPág y Ctrl+Inicio/Fin se mueven entre celdas; ↑ desde la primera fila llega al
  encabezado). **Ctrl/Cmd+C** copia la celda y **Ctrl/Cmd+Mayús+C** la fila (también hay un botón en
  la barra); **Descargar el original** está en la barra.

## API y eventos

El navegador habla con rutas JSON bajo `/api` y con un único stream de Server-Sent Events por
pestaña:

```text
GET  /api/health                       unauthenticated: name, version, protocolVersion, capabilities
GET  /api/workspaces?archived=false|true|all   POST /api/workspaces {path}
PATCH /api/workspaces/:wid {label?, pinned?, archived?}
POST /api/workspaces/pick {start?}     diálogo nativo de carpetas → {path} | {cancelled: true} (loopback)
GET  /api/fs/dirs?path=&hidden=        nombres de carpetas para el explorador integrado (loopback)
GET  /api/sessions                     POST /api/sessions            GET|PATCH /api/sessions/:sid
GET  /api/sessions/:sid/messages       GET /api/sessions/:sid/events GET /api/sessions/:sid/runs
POST /api/sessions/:sid/prompts        POST /api/sessions/:sid/cancel  POST /api/sessions/:sid/compact
GET  /api/sessions/:sid/models         GET /api/sessions/:sid/context GET /api/sessions/:sid/export
GET  /api/commands?session=<sid>       POST /api/sessions/:sid/commands {requestId, name, args?}
GET  /api/sessions/:sid/btw            POST /api/sessions/:sid/btw {question}  POST /api/sessions/:sid/btw/cancel
GET  /api/approvals                    POST /api/approvals/:aid      POST /api/interactions/:iid
GET  /api/sessions/:sid/artifacts      GET /api/artifacts/:aid       GET /api/artifacts/:aid/download
GET  /api/artifacts/:aid/files/*       POST /api/artifacts/:aid/view  POST /api/artifacts/:aid/export {target, overwrite?}
GET  /api/artifacts/:aid/sources?logs=1   DELETE /api/artifacts/:aid
GET  /artifact-view/:token/*           isolated viewer (signed link, no cookie)
GET  /api/sessions/:sid/capabilities   DELETE /api/sessions/:sid/capabilities/:gid
GET  /api/workspaces/:wid/tree?path=&cursor=   GET /api/workspaces/:wid/file?path=&maxBytes=&download=1
GET  /api/workspaces/:wid/diff?path=   GET /api/sessions/:sid/changes
POST /api/blobs                        raw image body (not JSON) → BlobRef   GET /api/blobs/:hash
POST /api/sessions/:sid/datasets       raw data file, X-File-Name header → 202 {pending} | 200 {dataset}
GET  /api/sessions/:sid/datasets       GET /api/datasets/:did        GET /api/datasets/:did/download
GET  /api/datasets/:did/rows?sheet=&after=&offset=&limit=&sort=&dir=&filter=&column=
POST /api/artifacts/:aid/dataset       ingest a spreadsheet artifact on first preview
GET  /api/events?session=<sid>         the event stream (snapshot, then live frames)
GET  /api/plugins?workspace=<wid>      PATCH /api/plugins/:id {workspace, enabled}
GET  /api/skills?workspace=<wid>       PATCH /api/skills/:id {workspace, enabled}
GET  /api/mcp?workspace=<wid>          PATCH /api/mcp/:name {workspace, enabled, connect?}
POST /api/mcp/consent {workspace, confirmed: true, remember?}
GET  /api/agents?workspace=<wid>       GET /api/settings?workspace=<wid>  PATCH /api/settings {workspace, key, value}
GET  /api/providers?workspace=<wid>    PUT /api/providers/:profile {workspace, provider, values, model}
PUT|DELETE /api/providers/:profile/credentials {apiKey?, bearerToken?}   write-only
POST /api/providers/:profile/activate {workspace, model}   GET /api/models?workspace=<wid>
```

Las subidas de datasets terminan con un frame `dataset_ready` o `dataset_failed` en el stream de la
sesión. Los errores de datos usan los códigos `dataset_unsupported` (415), `query_rejected` (400) y
`query_timeout` (408).

Los cambios de gestión envían un frame `catalog_changed` (`commands`, `plugins`, `skills`, `mcp`,
`models` o `agents`) a todos los streams, para que otras pestañas se actualicen. Activar un perfil
responde `409 runs_active` mientras el workspace tiene runs, y el acceso MCP concedido desde la web
queda registrado con la fuente `interactive-web`.

En cada (re)conexión el stream envía un snapshot de cada sesión suscrita (mensajes recientes, texto
que aún se está generando, la hora de inicio de la ejecución, aprobaciones pendientes) seguido de frames en vivo; los eventos durables
llevan su `eventId` como `id` de SSE, y el texto generado llega agrupado unas 30 veces por segundo.
La versión del protocolo aparece en `/api/health` y en el primer frame del stream.

## Limitaciones

- Un solo host: los bloqueos de sesión dependen de ids de proceso, y la web no ve en vivo los
  cambios que una TUI hace en una sesión hasta que la sesión se vuelve a abrir.
- Sin TLS; el acceso remoto es opcional y está pensado para túneles SSH.
- El proveedor es por workspace: **Activar en este workspace** cambia la aplicación de ese
  workspace (y guarda el perfil como predeterminado para los próximos arranques); los demás
  workspaces abiertos conservan su proveedor hasta que se vuelven a abrir. Las credenciales guardadas
  se aplican la próxima vez que se activa el perfil.
- El acceso MCP concedido desde la web dura hasta que se detiene `alisio serve` y cubre un
  workspace, salvo que elija recordarlo para el usuario.
- El binario independiente sirve solo la API; los assets de la interfaz web se distribuyen con el
  paquete npm.
- La interfaz web conserva la salida de comandos, los avisos y el razonamiento solo mientras la
  página está abierta; al recargar, la conversación se reconstruye desde los mensajes guardados.
- El panel de archivos muestra solo el workspace: los directorios añadidos con `--add-dir` no se
  pueden recorrer, los enlaces simbólicos se listan pero nunca se siguen (aunque apunten dentro del
  workspace) y el filtrado por `.gitignore` necesita `git` en el `PATH`. **Cambios** solo conoce los
  archivos escritos con `write_file` y `edit_file`; los que cambia un comando de shell aparecen en
  `git status`, no ahí.
- Vistas previas de artefactos: **Esc** pulsado dentro de un dashboard nunca llega a Alisio (usa
  **Cerrar**); los dashboards no pueden usar la red, `localStorage`, scripts de módulo ni fuentes
  web desde archivos (las fuentes deben ser URL `data:` en línea); un enlace de visualización
  caduca a los 10 minutos (al reabrir se renueva); los PDF usan el visor del navegador sin `sandbox`
  y pasan a descarga donde no lo hay. Las descargas de artefactos multiarchivo son archivos ZIP.
- Tablas: ordenar y filtrar recorren la hoja (el archivo del dataset no tiene índices), así que se
  desactivan por encima de `analysis.data.maxInteractiveRows`; las celdas de más de 4 096 caracteres
  se cortan en la cuadrícula (el dataset las conserva enteras); un XLSX necesita Python 3.10+ para
  leerse.
- Las imágenes subidas se guardan una vez por hash de contenido junto a la base de datos de
  sesiones y no se borran automáticamente.
- Los renderizadores ricos necesitan fragmentos de JavaScript que la página carga a demanda:
  Mermaid es grande (unos cientos de KB comprimidos entre sus fragmentos) y solo se carga cuando se
  muestra un diagrama.
