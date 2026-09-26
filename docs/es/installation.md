# Instalación

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
npm i -g alisio
```

```sh [pnpm]
pnpm add -g alisio
```

```sh [bun]
bun add -g alisio
```

:::

Esto instala el comando `alisio`.

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
