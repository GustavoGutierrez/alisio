# Installation

## Requirements

| Requirement | Details |
| --- | --- |
| Runtime | Node.js **>= 22.16** or Bun **>= 1.4.2** |
| Git | On `PATH`, for the `git_status` and `git_diff` tools |
| ripgrep (`rg`) | On `PATH`, for the `search_text` tool |

::: warning Node.js 22.16 is the minimum
Alisio stores sessions and memory with `node:sqlite` and needs FTS5. Earlier Node.js 22.x builds of
`node:sqlite` lack FTS5: 22.13 to 22.15 were verified to fail, 22.16 works.
:::

The standalone binary embeds Bun, so it needs no Node.js; Git and ripgrep remain external
dependencies. Run `alisio doctor` after installing to see the detected runtime, Git and ripgrep.

## Package managers

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

This installs the `alisio` command (the package name is scoped, the binary is `alisio`).

## Standalone binary

```sh
curl -fsSL https://raw.githubusercontent.com/GustavoGutierrez/alisio/main/scripts/install.sh | sh
```

The script detects your OS and architecture, downloads the matching binary from
[GitHub Releases](https://github.com/GustavoGutierrez/alisio/releases), verifies its SHA-256 against
the release `SHA256SUMS` file and installs it. It fails if the checksum is missing or does not match.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `ALISIO_VERSION` | latest release | Version to install, for example `0.1.0` |
| `ALISIO_INSTALL_DIR` | `~/.local/bin` | Installation directory |
| `ALISIO_DOWNLOAD_BASE` | GitHub Releases | Mirror URL holding the assets and `SHA256SUMS`; skips the release lookup |

```sh
curl -fsSL https://raw.githubusercontent.com/GustavoGutierrez/alisio/main/scripts/install.sh \
  | ALISIO_VERSION=0.1.0 ALISIO_INSTALL_DIR="$HOME/bin" sh
```

Published assets:

| Asset | Platform |
| --- | --- |
| `alisio-linux-x64` | Linux x64 |
| `alisio-linux-arm64` | Linux arm64 |
| `alisio-darwin-x64` | macOS Intel |
| `alisio-darwin-arm64` | macOS Apple Silicon |
| `alisio-windows-x64.exe` | Windows x64 |

The script needs `curl`, `uname` and `sha256sum` or `shasum`. If the install directory is not on
your `PATH`, it tells you to add it.

## Building from source

The repository uses pnpm 11.25.0 for dependencies and Bun for development and the compiled binary
(Bun 1.4.2 is installed as a development dependency).

```sh
git clone https://github.com/GustavoGutierrez/alisio.git
cd alisio
pnpm install --frozen-lockfile
pnpm build          # tsc per package
pnpm dev --help     # run the CLI from source with Bun
pnpm build:binary   # standalone binary at dist/alisio
```

`pnpm dev` runs `packages/cli/src/main.ts` with Bun and the `alisio-source` export condition, so
workspace packages resolve to their TypeScript sources. See [Architecture](/architecture).

Next: [Quick start](/quick-start).
