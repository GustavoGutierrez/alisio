# Arquitectura

Alisio es un monorepo pnpm con cuatro paquetes.

```text
                      ┌──────────────────────────────┐
                      │ @alisio/sdk                  │
                      │ plugin contract, zero deps   │
                      └──────────────▲───────────────┘
                 depends on          │           peer dependency
        ┌────────────────────────────┼────────────────────────────┐
        │                            │                            │
┌───────┴──────────────────────┐     │     ┌──────────────────────┴───────┐
│ @alisio/core                 │     │     │ @alisio/plugin-memory        │
│ runner, compaction, provider,│     │     │ @alisio/sdk (peer) + zod     │
│ tools, runtime adapters      │     │     │ uses the storage port        │
│ (node:sqlite, fs,            │     │     └──────────────▲───────────────┘
│ child_process), plugin host, │     │                    │
│ config, createApplication    │     │                    │
└───────▲──────────────────────┘     │                    │
        │                            │                    │
        │             ┌──────────────┴───────────────┐    │
        └─────────────┤ alisio (CLI)                 ├────┘
                      │ bin, TUI, clipboard,         │
                      │ built-in registry wiring     │
                      │ plugin-memory                │
                      └──────────────────────────────┘
```

| Paquete | Función | Depende de |
| --- | --- | --- |
| `@alisio/sdk` | Contrato público de plugins: tipos más `definePlugin` y `textResult`. Sin imports de runtime ni de proveedores | Nada |
| `@alisio/core` | Runner del agente y ciclo de herramientas, compactación, proveedor compatible con OpenAI, herramientas estándar, adaptadores de runtime (`node:sqlite`, `fs`, `child_process`), host de plugins, registro de extensiones, renderizado de inicio, configuración, cliente MCP, puente Herdr y `createApplication` | `@alisio/sdk`, `openai`, cliente MCP, `ajv`, `yaml`, `zod` |
| `@alisio/plugin-memory` | Plugin integrado de memoria persistente | `@alisio/sdk` (peer), `zod` |
| `alisio` | CLI: `bin`, TUI, adaptador de portapapeles y el registro de plugins integrados que conecta `plugin-memory` | `@alisio/core`, `@alisio/plugin-memory`, `@alisio/sdk`, `@earendil-works/pi-tui`, `commander` |

Los SDKs de proveedores y los imports específicos de un runtime quedan fuera del SDK público y de los
contratos del núcleo del agente.

## Puerto de almacenamiento

Los plugins nunca importan un driver SQLite. `api.storage.sqlite(path)` devuelve el puerto
`SqlDatabase` definido en `@alisio/sdk` (`exec`, `prepare`, `transaction`, `close`), implementado por
`@alisio/core` sobre `node:sqlite` con FTS5. El plugin de memoria está escrito únicamente contra este
puerto, y por eso solo depende del SDK y de `zod`.

## Plugins integrados y externos

| | Integrado | Externo |
| --- | --- | --- |
| Origen | Registro en la CLI (`packages/cli/src/builtin.ts`) | `--plugin`, configuración `plugins`, directorios de plugins globales o de proyecto de confianza |
| Ruta de confianza | Ruta de confianza del host, también con `--read-only`, sin `--trust-project` | Solo confianza explícita; desactivados por `--read-only` |
| Nombres | Herramientas y comandos sin prefijo | Prefijo `p_<hash>_` en herramientas, comandos `id:name` |
| Efecto `internal` | Permitido | Se degrada a `external` |
| Configuración | `builtinPlugins.<id>`; se desactiva con `enabled: false` o `--disable-plugin <id>` | Específica de cada plugin |

El núcleo no contiene referencias a la memoria: la CLI pasa su registro a `createApplication`. Añadir
otro plugin integrado consiste en agregar una entrada a ese registro.

## Registro de extensiones

`@alisio/core` mantiene un registro de extensiones tipado en el host de plugins
(`packages/core/src/extensions`). Los plugins registran proveedores para los puntos declarados en
`ExtensionPoints` de `@alisio/sdk` (`mascot`, `startup-screen`). La resolución es determinista e
independiente del orden de carga de los plugins: mayor prioridad, después ID del plugin y después
orden de registro dentro de un plugin; los empates en la prioridad ganadora se informan como
diagnósticos `extension_conflict`. `renderStartup` (`packages/core/src/startup`) resuelve los
proveedores, valida, sanea y recorta su salida, y recurre a `DefaultAlisioMascot` y
`DefaultStartupScreen` cuando un proveedor falla. La CLI (`packages/cli/src/banner.ts`) solo decide
cuándo mostrar la pantalla y detecta las capacidades de la terminal. Consulte
[Puntos de extensión](/es/plugins#extension-points).

## Runtime

Alisio se ejecuta en Node.js >= 22.16 o Bun >= 1.4.2. Ambos proporcionan `node:sqlite`, que guarda las
sesiones (conversación, eventos, journal de herramientas, estado de plugins, bloqueo de sesión) y la
memoria. Node.js 22.16 es el mínimo porque las compilaciones 22.x anteriores carecen de FTS5.

## Resolución de fuentes en desarrollo

Cada paquete exporta sus archivos compilados de `dist`, más una condición de exportación
`alisio-source`, solo para desarrollo, que apunta a `src/*.ts`. El `tsconfig.json` raíz define
`customConditions: ["alisio-source"]` y `pnpm dev` ejecuta Bun con `--conditions=alisio-source`, de
modo que los paquetes del workspace se resuelven a sus fuentes TypeScript sin compilar. La condición
se elimina de los `exports` publicados mediante `publishConfig`.

## Compilación y publicación

- **Compilación**: `pnpm build` ejecuta `tsc -p tsconfig.build.json` en cada paquete y emite
  JavaScript y declaraciones en `dist`.
- **Binario**: `pnpm build:binary` compila `packages/cli/dist/main.js` con `bun build --compile`.
- **Versionado**: [changesets](https://github.com/changesets/changesets). El workflow de release abre
  un PR de versión o publica en npm con provenance.
- **Binarios**: tras una publicación, el workflow de release compila de forma cruzada binarios
  independientes con Bun (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`),
  escribe `SHA256SUMS` y crea una GitHub Release (pre-release para versiones preliminares).
- **Documentación**: este sitio se construye con VitePress y se publica en GitHub Pages.
