# Contribuir

Las contribuciones son bienvenidas. El repositorio es
[GustavoGutierrez/alisio](https://github.com/GustavoGutierrez/alisio); las instrucciones para
contribuir también están en `AGENTS.md` y `CONTRIBUTING.md`.

## Herramientas

- **pnpm** (11.25.0) para las dependencias. Mantenga solo `pnpm-lock.yaml`; no añada otros lockfiles.
- **Bun** para el desarrollo (`pnpm dev`) y el binario independiente; los paquetes compilados se
  ejecutan en **Node.js >= 22.16** o **Bun >= 1.4.2**.
- **Biome** para lint y formato, **Vitest** para las pruebas y **TypeScript** (`tsc`) para los tipos y
  la compilación.

```sh
pnpm install --frozen-lockfile
pnpm dev --help
```

## Comprobaciones

Ejecute estas comprobaciones antes de abrir un pull request:

| Comando | Qué comprueba |
| --- | --- |
| `pnpm typecheck` | TypeScript en paquetes, pruebas, fixtures, scripts y la configuración de la documentación |
| `pnpm lint` | Lint y formato con Biome |
| `pnpm test` | Suite de Vitest (algunos fixtures también se ejecutan en Bun) |
| `pnpm build` | Compilación con `tsc` de cada paquete |
| `pnpm test:cli` | La CLI compilada bajo Node contra un proveedor simulado local |
| `pnpm test:compiled` | Compila el binario independiente y ejecuta contra él el fixture de extremo a extremo |
| `pnpm pack:check` | Contenido de los paquetes npm |
| `pnpm docs:check` | Enlaces internos, `#anclas` y paridad inglés/español |
| `pnpm docs:build` | Este sitio de documentación, incluidos `docs:check` y la comprobación de enlaces rotos |

`pnpm check` las ejecuta todas en orden.

## Reglas de desarrollo

- **TDD estricto**: escriba primero la prueba que falla y después la implementación.
- Pruebe el comportamiento en los límites de los módulos. No añada pruebas de snapshot que
  simplemente repitan la implementación.
- Mantenga los SDKs de proveedores y los imports específicos de un runtime fuera de `@alisio/sdk` y de
  los contratos del núcleo del agente.
- Preserve los IDs de llamadas a herramientas, los datos de continuación del proveedor y la
  consistencia de las sesiones persistidas.
- Nunca trate un manifiesto de plugin ni un subproceso como un sandbox.
- El código, los comentarios y las pruebas se escriben en inglés; este sitio se escribe en inglés y
  en español. `docs/implementation-status.md` se escribe en español y
  registra las limitaciones y el alcance de la verificación; actualícelo cuando cambien.

## Decision Intelligence {#decision-intelligence}

Antes de añadir un Decision Pack o cualquier uso de `ctx.decisions`, el cambio debe pasar la
[regla de admisión](/es/decision-intelligence#admission-rule): cuatro preguntas sobre si la
decisión es cerrada, frecuente, vale la pena resolverla así y admite una alternativa segura, y ocho
respuestas escritas en la pull request (la decisión, el trabajo del LLM que se elimina, la métrica,
la alternativa, el comportamiento sin proveedor, cómo se valida la salida, por qué el código
determinista no basta y qué va en `state`). Las funciones que no pueden responderlas no usan el
motor de decisiones.

## Versionado

Las versiones y los changelogs se gestionan con [changesets](https://github.com/changesets/changesets).
Añada un changeset a cada pull request que modifique un paquete publicado:

```sh
pnpm changeset
```

En `main`, el workflow de release abre un pull request de versión y, una vez fusionado, publica en npm
con provenance y adjunta los binarios independientes a una GitHub Release.

## Documentación

El sitio está en `docs/` y se construye con VitePress:

```sh
pnpm docs:dev     # local preview
pnpm docs:check   # internal links, anchors and EN/ES parity
pnpm docs:build   # production build with dead-link check
```

Las páginas en inglés están en `docs/<page>.md` y las páginas en español en `docs/es/<page>.md`. Los
enlaces internos usan rutas del sitio (`/configuration` en inglés, `/es/configuration` en español).
`specification.md`, `herdr.md`, `implementation-status.md`, `validation.txt`, `benchmark.json` y
`README.md` de `docs/` están excluidos del sitio; enlácelos con URLs absolutas de GitHub.

### Lista de paridad de la documentación

- [ ] Cada página existe en ambos idiomas (`docs/<page>.md` y `docs/es/<page>.md`), y ambas figuran
      en la barra lateral de `docs/.vitepress/config.ts`.
- [ ] Ambas versiones tienen los mismos títulos en el mismo orden y los mismos bloques de código; los
      comandos, flags y claves de configuración son idénticos.
- [ ] La prosa se traduce fielmente; ninguna versión es un resumen de la otra.
- [ ] El inglés y el español se actualizan en el mismo pull request.
- [ ] `docs/es/limitations.md` sigue incluyendo `docs/implementation-status.md`, y
      `docs/limitations.md` en inglés refleja su contenido actual.
- [ ] `pnpm docs:build` termina sin enlaces rotos (`pnpm docs:check` valida `#anclas` y paridad, algo
      que la propia comprobación de enlaces de VitePress no cubre).
