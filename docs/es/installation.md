# Instalación

## Aplicación de escritorio

La aplicación de escritorio es la forma más sencilla de instalar Alisio y no necesita terminal ni
Node.js. Elija el instalador de su sistema:

| Sistema | Descarga |
| --- | --- |
| Windows 10/11 (x64) | [`Alisio-Setup-0.11.0-x64.exe`](https://github.com/GustavoGutierrez/alisio/releases/download/desktop-v0.11.0/Alisio-Setup-0.11.0-x64.exe) (asistente NSIS, por usuario, sin derechos de administrador) |
| macOS Apple Silicon (arm64) | [`Alisio-0.11.0-arm64.dmg`](https://github.com/GustavoGutierrez/alisio/releases/download/desktop-v0.11.0/Alisio-0.11.0-arm64.dmg) |
| macOS Intel (x64) | [`Alisio-0.11.0-x64.dmg`](https://github.com/GustavoGutierrez/alisio/releases/download/desktop-v0.11.0/Alisio-0.11.0-x64.dmg) |
| Linux, cualquier distribución | [`Alisio-0.11.0-x86_64.AppImage`](https://github.com/GustavoGutierrez/alisio/releases/download/desktop-v0.11.0/Alisio-0.11.0-x86_64.AppImage) |
| Debian y Ubuntu | [`Alisio-0.11.0-amd64.deb`](https://github.com/GustavoGutierrez/alisio/releases/download/desktop-v0.11.0/Alisio-0.11.0-amd64.deb) |

Todos los archivos están en la [página de la versión](https://github.com/GustavoGutierrez/alisio/releases/tag/desktop-v0.11.0). Los instaladores no están firmados, así
que Windows SmartScreen y macOS Gatekeeper muestran un aviso la primera vez.
[Aplicación de escritorio](/es/desktop) explica cada paso y cómo continuar tras los avisos.

El resto de esta página cubre el paquete de npm y el binario independiente, la vía avanzada para la
terminal, los scripts y CI.

## Requisitos

| Requisito | Detalles |
| --- | --- |
| Runtime | Node.js **>= 22.16** o Bun **>= 1.4.2** |
| Git | En el `PATH`, para las herramientas `git_status` y `git_diff` |
| ripgrep (`rg`) | En el `PATH`, para la herramienta `search_text` |

::: warning Node.js 22.16 es el mínimo
Alisio guarda sesiones y memoria con `node:sqlite` y necesita FTS5. Las compilaciones de
`node:sqlite` de Node.js 22.x anteriores carecen de FTS5: se verificó que 22.13 a 22.15 fallan y que
22.16 funciona.
:::

El binario independiente incluye Bun, por lo que no necesita Node.js; Git y ripgrep siguen siendo
dependencias externas. Ejecute `alisio doctor` después de instalar para ver el runtime, Git y ripgrep
detectados.

## Gestores de paquetes

::: code-group

```sh [npm]
npm i -g @alisio/alisio-code
```

```sh [pnpm]
pnpm add -g @alisio/alisio-code
```

```sh [yarn]
yarn global add @alisio/alisio-code
```

```sh [bun]
bun add -g @alisio/alisio-code
```

:::

Esto instala el comando `alisio` (el paquete tiene scope; el binario es `alisio`).

## Binario independiente

```sh
curl -fsSL https://raw.githubusercontent.com/GustavoGutierrez/alisio/main/scripts/install.sh | sh
```

El script detecta su sistema operativo y arquitectura, descarga el binario correspondiente desde
[GitHub Releases](https://github.com/GustavoGutierrez/alisio/releases), verifica su SHA-256 contra el
archivo `SHA256SUMS` de la release y lo instala. Falla si la suma de verificación falta o no coincide.

| Variable de entorno | Valor por defecto | Función |
| --- | --- | --- |
| `ALISIO_VERSION` | última release | Versión a instalar, por ejemplo `0.1.0` |
| `ALISIO_INSTALL_DIR` | `~/.local/bin` | Directorio de instalación |
| `ALISIO_DOWNLOAD_BASE` | GitHub Releases | URL de un espejo con los binarios y `SHA256SUMS`; omite la consulta de la release |

```sh
curl -fsSL https://raw.githubusercontent.com/GustavoGutierrez/alisio/main/scripts/install.sh \
  | ALISIO_VERSION=0.1.0 ALISIO_INSTALL_DIR="$HOME/bin" sh
```

Binarios publicados:

| Archivo | Plataforma |
| --- | --- |
| `alisio-linux-x64` | Linux x64 |
| `alisio-linux-arm64` | Linux arm64 |
| `alisio-darwin-x64` | macOS Intel |
| `alisio-darwin-arm64` | macOS Apple Silicon |
| `alisio-windows-x64.exe` | Windows x64 |

El script necesita `curl`, `uname` y `sha256sum` o `shasum`. Si el directorio de instalación no está
en su `PATH`, se lo indica para que lo agregue.

## Compilar desde el código fuente

El repositorio usa pnpm 11.25.0 para las dependencias y Bun para el desarrollo y el binario compilado
(Bun 1.4.2 se instala como dependencia de desarrollo).

```sh
git clone https://github.com/GustavoGutierrez/alisio.git
cd alisio
pnpm install --frozen-lockfile
pnpm build          # tsc per package
pnpm dev --help     # run the CLI from source with Bun
pnpm build:binary   # standalone binary at dist/alisio
```

`pnpm dev` ejecuta `packages/cli/src/main.ts` con Bun y la condición de exportación `alisio-source`,
de modo que los paquetes del workspace se resuelven a sus fuentes TypeScript. Consulte
[Arquitectura](/es/architecture).

Siguiente: [Inicio rápido](/es/quick-start).
