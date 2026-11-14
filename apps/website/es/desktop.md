# Aplicación de escritorio

Alisio Desktop es la forma más sencilla de usar Alisio: se instala como cualquier otro programa, se
abre y tú describes lo que necesitas. No hace falta terminal. Está pensada para el trabajo de todos
los días (redactar una tesis, preparar un examen, analizar una hoja de cálculo, producir un informe)
sobre tus propios archivos: tú eliges la carpeta, Alisio pregunta antes de cambiar algo y tú
revisas el resultado antes de usarlo. Desde la misma ventana puedes instalar complementos desde el
catálogo, crear los tuyos con el [creador de complementos](/es/plugin-creator) y conectar
herramientas y servicios desde el [catálogo MCP](/es/mcp-catalog).

::: info Para tener en cuenta
La aplicación de escritorio ejecuta el mismo servidor local que [`alisio serve`](/es/web) en su
propia ventana. Descarga los instaladores desde la
[página de versiones de GitHub](https://github.com/GustavoGutierrez/alisio/releases); no se publica
en npm. Las nuevas versiones se instalan descargando el nuevo instalador (todavía no hay
actualización automática) y los instaladores no están firmados. Consulta
[Limitaciones conocidas](#limitations).
:::

La aplicación de escritorio abre la [interfaz web](/es/web) en su propia ventana. No añade
funcionalidades propias: las sesiones, la configuración, los complementos y la base de datos de sesiones
son los mismos que usa la CLI.

## Descargar e instalar

Descarga el archivo de tu sistema desde la [versión Alisio 0.11.12](https://github.com/GustavoGutierrez/alisio/releases/tag/v0.11.12) (los mismos
enlaces están en la [página de inicio](/es/)):

| Sistema | Descarga | Cómo instalar |
| --- | --- | --- |
| Windows 10/11 (x64) | [`Alisio-Setup-0.11.12-x64.exe`](https://github.com/GustavoGutierrez/alisio/releases/download/v0.11.12/Alisio-Setup-0.11.12-x64.exe) | Ejecútalo y sigue el asistente |
| macOS Apple Silicon (arm64) | [`Alisio-0.11.12-arm64.dmg`](https://github.com/GustavoGutierrez/alisio/releases/download/v0.11.12/Alisio-0.11.12-arm64.dmg) | Ábrela y arrastra Alisio a Aplicaciones |
| macOS Intel (x64) | [`Alisio-0.11.12-x64.dmg`](https://github.com/GustavoGutierrez/alisio/releases/download/v0.11.12/Alisio-0.11.12-x64.dmg) | Ábrela y arrastra Alisio a Aplicaciones |
| Linux, cualquier distribución | [`Alisio-0.11.12-x86_64.AppImage`](https://github.com/GustavoGutierrez/alisio/releases/download/v0.11.12/Alisio-0.11.12-x86_64.AppImage) | Hazlo ejecutable (`chmod +x`) y ejecútalo |
| Debian y Ubuntu | [`Alisio-0.11.12-amd64.deb`](https://github.com/GustavoGutierrez/alisio/releases/download/v0.11.12/Alisio-0.11.12-amd64.deb) | Instálalo con tu gestor de paquetes |

Cada versión incluye también `SHA256SUMS-desktop.txt`, para que puedas verificar una descarga. Para
construir los instaladores tú mismo, consulta [Construir los instaladores](#construir-los-instaladores).

**Windows.** El instalador asistido se construye con NSIS 3 y Modern UI 2. Se instala por usuario,
así que no necesita derechos de administrador, y permite elegir la carpeta. Crea accesos directos en
el escritorio y en el menú Inicio, ejecuta Alisio al terminar y está disponible en español e inglés.

**Linux.** La ventana y el lanzador se muestran como «Alisio» con su icono (tomado de
`packages/web/public/favicon.png`).

### Instaladores sin firmar: SmartScreen y Gatekeeper {#unsigned}

Los instaladores no están firmados digitalmente, así que el sistema muestra un aviso la primera vez:

- **Windows (SmartScreen):** cuando aparezca «Windows protegió su PC», elige **Más información** y
  luego **Ejecutar de todas formas**.
- **macOS (Gatekeeper):** la aplicación tiene una firma ad hoc y no está notarizada. Si macOS indica
  que no se puede abrir la aplicación, abre **Ajustes del Sistema**, luego **Privacidad y
  seguridad**, y elige **Abrir de todos modos** para Alisio. También puedes hacer clic sobre la
  aplicación con la tecla Control pulsada y elegir **Abrir**. Si macOS sigue indicando que la
  aplicación está dañada, ejecuta una vez `xattr -cr /Applications/Alisio.app` en una terminal y
  ábrela de nuevo.

Haz esto solo con un instalador que hayas construido tú mismo o que hayas descargado de la
versión oficial.

## Primer inicio

Abre Alisio desde el acceso directo del escritorio, el menú Inicio, la carpeta Aplicaciones o tu
lanzador. La aplicación inicia su servidor local en segundo plano y abre la ventana por sí sola. Al
cerrar, el servidor se detiene.

## Conectar un modelo

Alisio funciona con el modelo que elijas; no incluye ningún modelo ni credencial por defecto.
Abre **Ajustes**, luego **Modelos**, añade un perfil para tu proveedor (compatible con OpenAI,
DeepSeek, OpenRouter y otros), introduce tu clave y activa un modelo. Las claves se guardan como
credenciales, nunca en archivos de configuración en texto plano. Consulta la
[interfaz web](/es/web) y [Configuración](/es/configuration) para ver todos los campos.

## Abrir una carpeta

Por defecto el workspace es tu directorio personal. Usa el selector de workspaces para abrir la
carpeta con los archivos en los que deseas trabajar. Alisio lee por defecto y pregunta antes de
escribir, de modo que tú controlas cada cambio. Consulta
[Herramientas y permisos](/es/tools#permission-flags).

## Instalar complementos por profesión {#instalar-plugins-por-profesion}

Los complementos dan a Alisio habilidades para una profesión. Se publican desde el repositorio público
[alisio-plugins](https://github.com/GustavoGutierrez/alisio-plugins) y se instalan con
`alisio install npm:<paquete>`; o abre **Ajustes → Complementos** y usa la pestaña **Catálogo de complementos**:
un clic instala un complemento y aparece de inmediato en **Complementos instalados**. **Instalar desde archivo**
instala un complemento privado desde un `.tgz`. El asistente también puede instalar uno por ti mediante
su herramienta con permisos `plugin_install`, una vez que lo apruebes. La aplicación incluye
npm, así que instalar complementos no requiere Node.js en tu sistema; al actualizar un complemento que ya está
cargado, un aviso te pide reiniciar y **Reiniciar ahora** reinicia el proceso en segundo plano de la
aplicación y recarga la ventana. Mira
[Catálogo de complementos, instalación y actualizaciones](/es/web#plugin-catalog).

| Complemento | Para |
| --- | --- |
| `@alisio/plugin-thesis` | Estudiantes: planifica, investiga, redacta y compone tesis universitarias en PDF con Typst |
| `@alisio/plugin-literature-research` | Estudiantes: búsqueda de metadatos académicos |
| `@alisio/plugin-evalua` | Docentes: exámenes imprimibles (por ahora solo matemáticas escolares) |
| `@alisio/plugin-cardsmith` | Oficina: certificados, tarjetas y gráficos |

Estos complementos **todavía no vienen incluidos en la aplicación de escritorio**; tú los instalas. Los
complementos se ejecutan con tus privilegios de usuario y no están aislados, así que instala solo código
de confianza. Consulta [Escribir complementos](/es/plugins).

## Cómo funciona

El proceso principal de Electron inicia un host en segundo plano: el servidor de Alisio ejecutándose
sobre el binario de Electron como Node simple (`ELECTRON_RUN_AS_NODE=1`), enlazado a `127.0.0.1`. El
primer inicio toma un puerto libre y lo guarda (`host-port.json` en la carpeta de datos de usuario de
la aplicación); los siguientes lo reutilizan, así que la ventana conserva la misma dirección y tus
preferencias de la interfaz (carpetas plegadas, paneles, «Mostrar todo») sobreviven a un reinicio. El host comunica su URL de lanzamiento al proceso principal, que la abre en un
`BrowserWindow` aislado (aislamiento de contexto activado, integración de Node desactivada, sin
script de precarga). Los enlaces que salen de la aplicación se abren en el navegador
predeterminado. Un host que pierde la aplicación (su canal IPC) se detiene solo, y uno iniciado para
la aplicación sin ese canal se niega a arrancar.

Al salir, la aplicación pide al host que se cierre (un mensaje IPC, igual en Linux, macOS y
Windows). El host deja de aceptar trabajo, cancela los turnos del agente en curso, detiene las tareas
en segundo plano y después termina todos los comandos que Alisio inició y siguen en ejecución:
primero con una petición amable (SIGTERM en Linux y macOS) y, un segundo después, a la fuerza. Eso
incluye un comando que ignora la petición amable y un programa que un comando dejó en segundo plano
(`cmd &`). El cierre del host tarda como máximo 9 segundos; si no ha terminado a los 10 segundos, la
aplicación lo mata junto con su árbol de procesos (`taskkill /T /F` en Windows; en Linux y macOS se
le indica al host que salga de inmediato, lo que mata los comandos que registra, y después se le
mata). Por tanto, salir tarda como máximo unos 13 segundos, y normalmente bastante menos de uno.

Nada más cambia: Alisio sigue usando `node:sqlite`, sin módulos nativos, y las mismas comprobaciones
de Host, Origin y token de lanzamiento que `alisio serve`.

## Dónde se guardan los datos

La aplicación de escritorio comparte sus datos con la CLI y la TUI:

| Datos | Ubicación |
| --- | --- |
| Configuración | `~/.config/alisio` (`ALISIO_CONFIG_HOME`) |
| Sesiones y estado | `~/.local/state/alisio` (`ALISIO_STATE_HOME`) |

## Ejecutarla desde un checkout

```sh
pnpm install
pnpm desktop:dev
```

`pnpm desktop:dev` construye los paquetes del workspace y la aplicación de escritorio, y luego
inicia Electron con las rutas de desarrollo.

## Construir los instaladores

Esta sección es para quienes mantienen el proyecto.

```sh
pnpm desktop:package:dir
pnpm desktop:package
```

`pnpm desktop:package:dir` genera una aplicación sin empaquetar en `apps/desktop/release/` (rápida
de comprobar). `pnpm desktop:package` construye con `electron-builder` los instaladores de la
plataforma actual: `AppImage` y `deb` en Linux, un instalador asistido `nsis` por usuario en Windows
y un `dmg` en macOS. Construye cada plataforma en su propio sistema operativo: el `.dmg` de macOS
debe construirse en un Mac o en un runner de CI de macOS. Los instaladores oficiales los construye el
workflow de GitHub `Desktop release` (consulta
[Publicar Alisio Desktop](/es/publishing#publicar-alisio-desktop)).

El paso de empaquetado ejecuta `pnpm deploy --legacy --prod --config.node-linker=hoisted` para
ensamblar un árbol `node_modules` autocontenido y plano en `apps/desktop/build/runtime`. Se
distribuye junto a la aplicación (fuera del archivo asar) porque los procesos worker de Alisio
ejecutan archivos reales. La compilación falla si ese árbol contiene algún enlace simbólico, porque
los instaladores no pueden depender de ellos.

## Limitaciones {#limitations}

- Los complementos por profesión no vienen incluidos en la aplicación.
- Las funciones de Git requieren tener `git` instalado.
- La selección de carpetas usa el mismo selector nativo que `alisio serve` (una herramienta del
  sistema), no un diálogo de Electron.
- El descubrimiento global de complementos deriva su prefijo de la ruta del ejecutable, lo cual no tiene
  sentido dentro de Electron: los complementos instalados con un gestor de paquetes global no se
  encuentran desde la aplicación de escritorio. Los complementos instalados mediante Alisio y los
  complementos de proyecto no se ven afectados.
- No hay actualización automática. Instala una versión nueva sobre la anterior.
- Los instaladores no están firmados: Windows SmartScreen y macOS Gatekeeper muestran avisos. La
  aplicación de macOS solo tiene firma ad hoc y no está notarizada.
- La aplicación no se ha verificado en Windows ni en macOS; solo se probaron compilaciones de
  Linux.
- Si otro programa ocupa el puerto guardado, ese inicio usa otro puerto y tus preferencias de la
  interfaz no se ven hasta que un inicio posterior recupere el puerto guardado (no se pierden).
- Si Alisio se cierra de golpe (administrador de tareas, SIGKILL, corte de luz), los comandos y las
  tareas en segundo plano que inició pueden seguir en ejecución; el siguiente inicio no los detiene
  (solo marca esas tareas como `lost`). Los contenedores iniciados con Docker o Podman tampoco se
  detienen al salir.
- Los programas que un servidor MCP inició por su cuenta (por ejemplo con `npx` o `uvx`) solo se
  detienen cuando ese servidor MCP los detiene.
- Una compilación o comprobación del creador de complementos que esté en curso al salir no se cancela de
  forma ordenada: el barrido final mata sus procesos y hay que volver a ejecutar la compilación.
- En Windows, un programa que un comando inició y dejó en ejecución después de terminar ya no puede
  vincularse a Alisio y sigue en ejecución. La salida no se ha verificado en una máquina real con
  Windows ni con macOS.
