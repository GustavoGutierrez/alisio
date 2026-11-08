# Aplicación de escritorio

Alisio Desktop es la forma más sencilla de usar Alisio: se instala como cualquier otro programa y se
abre. No hace falta terminal. Está pensada para el trabajo de todos los días (redactar una tesis,
preparar un examen, analizar una hoja de cálculo, producir un informe) sobre sus propios archivos, y
siempre pide permiso antes de leer o cambiar algo.

::: warning Experimental
La aplicación de escritorio es una capa fina de Electron sobre el mismo servidor local que
[`alisio serve`](/es/web). Se construye desde el repositorio y **no se publica en npm**. No hay
actualización automática y los instaladores no están firmados. Consulte
[Limitaciones conocidas](#limitations).
:::

La aplicación de escritorio abre la [interfaz web](/es/web) en su propia ventana. No añade
funcionalidades propias: las sesiones, la configuración, los plugins y la base de datos de sesiones
son los mismos que usa la CLI.

## Descargar e instalar

Descargue el archivo de su sistema desde la [versión Alisio 0.11.2](https://github.com/GustavoGutierrez/alisio/releases/tag/v0.11.2) (los mismos
enlaces están en la [página de inicio](/es/)):

| Sistema | Descarga | Cómo instalar |
| --- | --- | --- |
| Windows 10/11 (x64) | [`Alisio-Setup-0.11.2-x64.exe`](https://github.com/GustavoGutierrez/alisio/releases/download/v0.11.2/Alisio-Setup-0.11.2-x64.exe) | Ejecútelo y siga el asistente |
| macOS Apple Silicon (arm64) | [`Alisio-0.11.2-arm64.dmg`](https://github.com/GustavoGutierrez/alisio/releases/download/v0.11.2/Alisio-0.11.2-arm64.dmg) | Ábrala y arrastre Alisio a Aplicaciones |
| macOS Intel (x64) | [`Alisio-0.11.2-x64.dmg`](https://github.com/GustavoGutierrez/alisio/releases/download/v0.11.2/Alisio-0.11.2-x64.dmg) | Ábrala y arrastre Alisio a Aplicaciones |
| Linux, cualquier distribución | [`Alisio-0.11.2-x86_64.AppImage`](https://github.com/GustavoGutierrez/alisio/releases/download/v0.11.2/Alisio-0.11.2-x86_64.AppImage) | Hágalo ejecutable (`chmod +x`) y ejecútelo |
| Debian y Ubuntu | [`Alisio-0.11.2-amd64.deb`](https://github.com/GustavoGutierrez/alisio/releases/download/v0.11.2/Alisio-0.11.2-amd64.deb) | Instálelo con su gestor de paquetes |

Cada versión incluye también `SHA256SUMS-desktop.txt`, para que pueda verificar una descarga. Para
construir los instaladores usted mismo, consulte [Construir los instaladores](#construir-los-instaladores).

**Windows.** El instalador asistido se construye con NSIS 3 y Modern UI 2. Se instala por usuario,
así que no necesita derechos de administrador, y permite elegir la carpeta. Crea accesos directos en
el escritorio y en el menú Inicio, ejecuta Alisio al terminar y está disponible en español e inglés.

**Linux.** La ventana y el lanzador se muestran como «Alisio» con su icono (tomado de
`packages/web/public/favicon.png`).

### Instaladores sin firmar: SmartScreen y Gatekeeper {#unsigned}

Los instaladores no están firmados digitalmente, así que el sistema muestra un aviso la primera vez:

- **Windows (SmartScreen):** cuando aparezca «Windows protegió su PC», elija **Más información** y
  luego **Ejecutar de todas formas**.
- **macOS (Gatekeeper):** la aplicación tiene una firma ad hoc y no está notarizada. Si macOS indica
  que no se puede abrir la aplicación, abra **Ajustes del Sistema**, luego **Privacidad y
  seguridad**, y elija **Abrir de todos modos** para Alisio. También puede hacer clic sobre la
  aplicación con la tecla Control pulsada y elegir **Abrir**. Si macOS sigue indicando que la
  aplicación está dañada, ejecute una vez `xattr -cr /Applications/Alisio.app` en una terminal y
  ábrala de nuevo.

Haga esto solo con un instalador que haya construido usted mismo o que haya descargado de la
versión oficial.

## Primer inicio

Abra Alisio desde el acceso directo del escritorio, el menú Inicio, la carpeta Aplicaciones o su
lanzador. La aplicación inicia su servidor local en segundo plano y abre la ventana por sí sola. Al
cerrar, el servidor se detiene.

## Conectar un modelo

Alisio funciona con el modelo que usted elija; no incluye ningún modelo ni credencial por defecto.
Abra **Ajustes**, luego **Modelos**, añada un perfil para su proveedor (compatible con OpenAI,
DeepSeek, OpenRouter y otros), introduzca su clave y active un modelo. Las claves se guardan como
credenciales, nunca en archivos de configuración en texto plano. Consulte la
[interfaz web](/es/web) y [Configuración](/es/configuration) para ver todos los campos.

## Abrir una carpeta

Por defecto el workspace es su directorio personal. Use el selector de workspaces para abrir la
carpeta con los archivos en los que desea trabajar. Alisio lee por defecto y pregunta antes de
escribir, de modo que usted controla cada cambio. Consulte
[Herramientas y permisos](/es/tools#permission-flags).

## Instalar plugins por profesión

Los plugins dan a Alisio habilidades para una profesión. Se publican desde el repositorio público
[alisio-plugins](https://github.com/GustavoGutierrez/alisio-plugins) y se instalan con
`alisio install npm:<paquete>`; o abra **Ajustes → Plugins** y use la pestaña **Catálogo de plugins**:
un clic instala un plugin y aparece de inmediato en **Plugins instalados**. **Instalar desde archivo**
instala un plugin privado desde un `.tgz`. El asistente también puede instalar uno por usted mediante
su herramienta con permisos `plugin_install`, una vez que usted lo apruebe. La aplicación incluye
npm, así que instalar plugins no requiere Node.js en su sistema; al actualizar un plugin que ya está
cargado, un aviso le pide reiniciar y **Reiniciar ahora** reinicia el proceso en segundo plano de la
aplicación y recarga la ventana. Vea
[Catálogo de plugins, instalación y actualizaciones](/es/web#plugin-catalog).

| Plugin | Para |
| --- | --- |
| `@alisio/plugin-thesis` | Estudiantes: planifica, investiga, redacta y compone tesis universitarias en PDF con Typst |
| `@alisio/plugin-literature-research` | Estudiantes: búsqueda de metadatos académicos |
| `@alisio/plugin-evalua` | Docentes: exámenes imprimibles (por ahora solo matemáticas escolares) |
| `@alisio/plugin-cardsmith` | Oficina: certificados, tarjetas y gráficos |

Estos plugins **todavía no vienen incluidos en la aplicación de escritorio**; usted los instala. Los
plugins se ejecutan con sus privilegios de usuario y no están aislados, así que instale solo código
de confianza. Consulte [Escribir plugins](/es/plugins).

## Cómo funciona

El proceso principal de Electron inicia un host en segundo plano: el servidor de Alisio ejecutándose
sobre el binario de Electron como Node simple (`ELECTRON_RUN_AS_NODE=1`), enlazado a `127.0.0.1` en
un puerto libre. El host comunica su URL de lanzamiento al proceso principal, que la abre en un
`BrowserWindow` aislado (aislamiento de contexto activado, integración de Node desactivada, sin
script de precarga). Los enlaces que salen de la aplicación se abren en el navegador
predeterminado. Al cerrar, el host se detiene.

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
y un `dmg` en macOS. Construya cada plataforma en su propio sistema operativo: el `.dmg` de macOS
debe construirse en un Mac o en un runner de CI de macOS. Los instaladores oficiales los construye el
workflow de GitHub `Desktop release` (consulte
[Publicar Alisio Desktop](/es/publishing#publicar-alisio-desktop)).

El paso de empaquetado ejecuta `pnpm deploy --legacy --prod --config.node-linker=hoisted` para
ensamblar un árbol `node_modules` autocontenido y plano en `apps/desktop/build/runtime`. Se
distribuye junto a la aplicación (fuera del archivo asar) porque los procesos worker de Alisio
ejecutan archivos reales. La compilación falla si ese árbol contiene algún enlace simbólico, porque
los instaladores no pueden depender de ellos.

## Limitaciones {#limitations}

- Los plugins por profesión no vienen incluidos en la aplicación.
- Las funciones de Git requieren tener `git` instalado.
- La selección de carpetas usa el mismo selector nativo que `alisio serve` (una herramienta del
  sistema), no un diálogo de Electron.
- El descubrimiento global de plugins deriva su prefijo de la ruta del ejecutable, lo cual no tiene
  sentido dentro de Electron: los plugins instalados con un gestor de paquetes global no se
  encuentran desde la aplicación de escritorio. Los plugins instalados mediante Alisio y los
  plugins de proyecto no se ven afectados.
- No hay actualización automática. Instale una versión nueva sobre la anterior.
- Los instaladores no están firmados: Windows SmartScreen y macOS Gatekeeper muestran avisos. La
  aplicación de macOS solo tiene firma ad hoc y no está notarizada.
- La aplicación no se ha verificado en Windows ni en macOS; solo se probaron compilaciones de
  Linux.
