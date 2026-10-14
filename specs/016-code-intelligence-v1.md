# Especificación Técnica: Interfaz de código — símbolos, diagnósticos acotados y pruebas dirigidas

| Campo | Valor |
| --- | --- |
| Versión | 0.1 |
| Origen | 🔬 **Investigación arXiv** (`specs/research/022-arxiv-features-research.md`) · **Orden de ejecución: 7 de 8** |
| Proyecto | Alisio |
| Estado | **Borrador.** Propuesta, no implementada. Decisiones O1–O7 pendientes (propuesta, a confirmar por el propietario). |
| Fecha | 2026-10-13 |
| Paquetes afectados | `@alisio/sdk` (tipos aditivos: `CodeDiagnostic`, `CodeSymbol`, `CodeCapabilities`; sin variantes nuevas de `UiBlock`), `@alisio/core` (nuevos `packages/core/src/tools/code.ts` y `packages/core/src/code/*`; registro en `packages/core/src/tools/standard.ts`; evidencia hacia Proof), `@alisio/server` (ruta de solo lectura `GET /api/code/capabilities`, fase 5), `@alisio/web` (privado: texto de ajustes), `@alisio/alisio-code` (CLI: `alisio code capabilities`; TUI: sin panel nuevo, reutiliza el bloque `test-results`) |
| Paquetes nuevos | Ninguno. **Sin dependencias nuevas de producción**: los parsers son código propio; los analizadores del proyecto (`tsc`, `eslint`, `vitest`, `pytest`) se ejecutan como subprocesos del workspace, nunca como imports. |
| Relación con otras especificaciones | Depende de `specs/archive/010-reliability-lab-v1.md` (puerta de promoción: solo se activa por defecto si el Lab demuestra beneficio), `specs/012-context-governor-v1.md` (las salidas entran como segmentos con criticidad) y `specs/011-proof-v1.md` (los diagnósticos son verificadores `typecheck|lint|test`). Ninguna es bloqueante para las Fases 1–3 en modo opt-in. Respeta `specs/018-perimeter-v1.md` (no decide permisos) y `specs/014-trust-boundaries-v1.md` (la salida de un analizador del workspace es dato no confiable). Complementaria de `specs/backlog/019-capability-routing-v1.md` (pausada: no reducir el catálogo de herramientas aquí). |
| Superficies | Web, TUI y headless (`alisio run`) con paridad funcional: son herramientas del modelo y se renderizan con bloques existentes |
| Política de versión | Funcionalidad nueva: **la siguiente minor al ejecutar**; aditiva. Por defecto **opt-in** (O1): el comportamiento y el catálogo de herramientas de 0.6.x quedan intactos hasta que la puerta del Lab apruebe la promoción. |

## 0. Cómo usar este documento (para agentes de código)

1. Lee primero `AGENTS.md` y `CONTRIBUTING.md`; prevalecen sobre este documento.
2. Etiquetas: **(verificado)** = comprobado leyendo el repositorio el 2026-10-13 (`main`, 0.6.0); **(no verificado)** = deducido o externo; **(nuevo)** = no existe.
3. **TDD estricto Rojo → Verde → Refactor.** Ninguna línea de producción sin una prueba que falle antes. Pruebas en `tests/*.test.ts` (vitest), sobre comportamiento en límites de módulo, **sin pruebas de instantánea**. Los parsers se prueban con fixtures de salida real recortada, no con snapshots de su propio resultado.
4. **Orden obligatorio**: Fase 0 (medición base con el Lab o, si aún no existe, con un arnés mínimo propio) → el propietario revisa → Fases 1–5. Cada fase deja el repo verde con `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:cli`, `pnpm test:compiled`, `pnpm pack:check`, `pnpm docs:check` y `pnpm docs:build`. No hagas commit hasta que lo pida el propietario.
5. **Asignación de modelos**: §13. Sonnet por defecto; Opus solo en los puntos listados.
6. Reglas del repo que no se rompen: solo pnpm; Node >=22.16 y debe funcionar en Bun; solo `node:fs`, `node:child_process`, `node:sqlite`; ningún SDK de proveedor ni import específico de runtime en `@alisio/sdk` ni en contratos del core; los plugins dependen solo de `@alisio/sdk` (peer); preservar IDs de llamadas a herramientas, datos de continuación del proveedor y consistencia de sesión; **un manifiesto de plugin o un subproceso no es un sandbox**.
7. Contratos **aditivos**: `RunEvent.schemaVersion` sigue en 1; las uniones solo ganan variantes.
8. Idioma: identificadores, claves, mensajes de error y textos generados en inglés; UI en inglés y español (`packages/web/src/i18n/es.ts`, `src/i18n`); esta especificación en español; docs EN/ES en paridad; límites en `docs/implementation-status.md`.
9. Esta especificación **no crea permisos nuevos ni modifica el gate**: toda ejecución pasa por `decideEffect` (`packages/core/src/permissions/decide.ts`) con el efecto declarado (§4.4).

## 1. Objetivo, no-objetivos y principio rector

### 1.1 Objetivo

Dar al agente una **interfaz de código con salidas tipadas, acotadas y navegables** para tres tareas donde hoy gasta turnos y tokens con herramientas genéricas:

1. **Diagnosticar**: saber si el proyecto compila, pasa lint y pasa pruebas, con errores normalizados `{file, line, code, message}`, deduplicados y paginados, en lugar de volcar la salida cruda de `tsc`/`eslint`/`vitest`/`pytest`.
2. **Navegar símbolos**: localizar definiciones y referencias de un identificador con resultados `path:line` y contexto mínimo, sin leer archivos enteros.
3. **Probar lo cambiado**: dado un conjunto de archivos modificados, proponer (y opcionalmente ejecutar) el comando mínimo de pruebas que los cubre.

Y **solo si el benchmark lo demuestra** (principio rector).

### 1.2 Principio rector

> **Una herramienta nueva existe solo si gana, medido, frente a `search_text` + `read_file` + `run_process`. Sin ganancia demostrada, queda opt-in y el agente sigue con las genéricas.**

Reglas derivadas: toda salida es acotada y dice cuándo fue recortada; la ausencia de un analizador se declara (no se inventa); ningún análisis es autoridad sobre permisos; la evidencia que produce es reproducible (comando, cwd, código de salida, huella del árbol).

### 1.3 No-objetivos

| Excluido | Motivo |
| --- | --- |
| Cliente LSP completo / servidor de lenguaje residente | Dependencia y estado de larga vida; el agente no necesita rename/hover. Un adaptador opcional por subproceso puede venir después (O3). |
| Refactors automáticos (rename, extract) | Escrituras masivas; el flujo `edit_file` con precondición sha256 ya es la vía segura. |
| Análisis estático propio de TypeScript/Python (AST completo) | Ya existe `code_ast_explorer` fuera de Alisio, pero aquí sería una dependencia nueva; las heurísticas sobre ripgrep bastan para ubicar. |
| Instalar analizadores o dependencias del proyecto | Alisio ejecuta lo que el proyecto ya trae; nunca instala. |
| Reducir el catálogo de herramientas por tarea | Es el backlog `specs/backlog/019-capability-routing-v1.md`. |
| Windows/macOS certificados | CI cubre solo Linux (`docs/implementation-status.md`). Los parsers son portables, pero la detección de capacidades se marca `unverified` fuera de Linux. |

## 2. Base verificada

| Hecho (verificado en repo) | Dónde | Implicación |
| --- | --- | --- |
| Registro de herramientas con `register({ name, effect, ... })` y `textResult` | `packages/core/src/tools/standard.ts` (`register`, l.161; `textResult` importado l.13) | Patrón a replicar en `tools/code.ts`. |
| `runProcess(command, args, { cwd, signal, timeoutMs, maxBytes, env, onOverflow, logFiles })` con `onOverflow: "kill"\|"truncate"` | `packages/core/src/runtime/process.ts` l.56 | Ejecución acotada de analizadores; `truncate` conserva el final (donde `tsc` y `vitest` imprimen el resumen). |
| `search_text` sobre ripgrep, salida acotada, con diagnóstico si falta `rg` | `tools/standard.ts`, `ripgrepDiagnostic` en `runtime/process.ts` l.27 | Base de la heurística de símbolos. |
| `read_file` con `startLine`, `limit` ≤ 1000 y `sha256` | `tools/standard.ts` | La navegación devuelve rangos que el agente lee con precisión. |
| Acotado y recuperación de truncado | `packages/core/src/core/output-limit.ts`, `core/truncation.ts` | Reutilizar límites; no inventar un tercero. |
| Bloque de UI `test-results` y `TestCaseResult {name,status,durationMs,error,line}` | `packages/sdk/src/index.ts` l.64 y l.208 | Render de pruebas ya existe en Web/TUI; `code_test` lo emite. |
| `GoalEvidence {kind: file\|test\|log\|command\|denied\|other, detail}` en texto libre | `packages/sdk/src/index.ts` l.1177 | Hoy la evidencia de pruebas es texto; Proof la tipará y esta spec la alimenta. |
| No existe herramienta de símbolos ni de diagnósticos | búsqueda en `packages/core/src/tools/*` | **(nuevo)** todo lo de §4. |

## 3. Principios de diseño y decisiones

### Decisiones del propietario (propuesta, a confirmar)

| ID | Decisión | Recomendación |
| --- | --- | --- |
| O1 | ¿Las herramientas `code_*` se registran por defecto o tras `code.enabled`? | **Opt-in** (`code.enabled: false`) hasta que el Lab (Fase 4) apruebe. Tras la puerta, pasar a `true` en una minor y documentarlo. |
| O2 | ¿Alcance de lenguajes en la primera entrega? | **TypeScript/JavaScript y Python** (los dos ecosistemas que Alisio ya conoce vía Forja). Otros lenguajes: `code_capabilities` los declara `unsupported`. |
| O3 | ¿Adaptador de servidor de lenguaje por subproceso? | **Diferido** a una v1.1; solo heurística ripgrep en esta entrega. |
| O4 | ¿Ejecutar `code_diagnostics` con efecto `process` aprobable por modo, o con una lista de scripts permitidos? | Efecto **`process`** con el gate existente (los modos `auto|full` ya lo cubren); el comando exacto se muestra antes de aprobar. |
| O5 | ¿Cachear diagnósticos por huella del árbol? | **Sí**, caché en memoria por sesión, clave = huella (git `HEAD` + `git diff` hash, o mtime+tamaño de archivos rastreados si no hay git); se invalida al escribir. |
| O6 | ¿`code_test` ejecuta o solo sugiere? | **Dos modos**: `plan` (efecto `read`, solo devuelve el comando) y `run` (efecto `process`). |
| O7 | ¿Los diagnósticos se registran automáticamente como evidencia Proof? | **Sí cuando Proof esté presente**; sin Proof, solo se devuelven al modelo. |

### Decisiones de diseño (vinculantes)

- **D1.** Toda herramienta `code_*` devuelve JSON tipado en `ToolResult` + un bloque `UiBlock` existente (`table` o `test-results`); **ninguna variante nueva de `UiBlock`**.
- **D2.** Toda salida tiene `limit`, `nextCursor` y `truncated`; el límite por defecto es de 50 elementos y el máximo duro de 200. La salida cruda completa se guarda con `logFiles` y se referencia, nunca se pega.
- **D3.** Los analizadores se ejecutan con `runProcess`, sin shell, con `args` como arreglo, `cwd` en el workspace, `timeoutMs` y `maxBytes` finitos. Los comandos se **descubren** (scripts de `package.json`, `tsconfig.json`, `pyproject.toml`), nunca los compone el modelo (evita inyección de argumentos). El modelo elige un `kind` de una enumeración cerrada.
- **D4.** Si el analizador no está disponible, la herramienta devuelve `{ available: false, reason }` y **el agente sigue con las genéricas**. Nunca se finge un resultado vacío.
- **D5.** La salida de un analizador del workspace es **dato no confiable** (puede venir de código del proyecto): se etiqueta con procedencia `tool:code_*` para que `specs/014-trust-boundaries-v1.md` la trate como dato. Mientras esa spec no exista, el texto se devuelve entre delimitadores y se recorta.
- **D6.** `code_symbols` es **heurística, no semántica**: devuelve candidatos con `confidence: "pattern"` y documenta falsos positivos y negativos. Nunca afirma «no hay referencias»; dice «no se encontraron coincidencias de patrón».
- **D7.** Sin estado persistente nuevo en la base: capacidades y caché viven en memoria por sesión. **No hay migración** (evita competir por el número con otras specs).

## 4. Diseño

### 4.1 Contratos (`@alisio/sdk`, aditivos)

```ts
export type CodeLanguage = "typescript" | "javascript" | "python";
export type CodeCheckKind = "typecheck" | "lint" | "test";

export interface CodeDiagnostic {
  file: string;            // ruta relativa al workspace, normalizada
  line: number;            // 1-based; 0 si el analizador no da línea
  column?: number;
  code?: string;           // TS2322, no-unused-vars, E501, ...
  severity: "error" | "warning";
  message: string;         // una línea, recortada a 300 caracteres
  source: "tsc" | "eslint" | "vitest" | "pytest" | "ruff" | "mypy";
}

export interface CodeSymbol {
  name: string;
  kind: "definition" | "reference";
  file: string;
  line: number;
  preview: string;         // una línea de contexto, recortada
  confidence: "pattern";
}

export interface CodeCapability {
  kind: CodeCheckKind | "symbols";
  language: CodeLanguage;
  available: boolean;
  command?: { bin: string; args: string[] }; // lo detectado, mostrado al usuario antes de aprobar
  reason?: string;         // por qué no está disponible
}
export interface CodeCapabilities { cwd: string; detectedAt: number; items: CodeCapability[]; platformVerified: boolean }
```

### 4.2 Detección de capacidades (`packages/core/src/code/capabilities.ts`, nuevo)

- Entradas: `package.json` (`scripts.typecheck|lint|test`, `devDependencies`), `tsconfig.json`, `pyproject.toml`/`pytest.ini`, presencia de `node_modules/.bin/{tsc,eslint,vitest}`, `rg` en PATH.
- Salida: `CodeCapabilities`. Se calcula una vez por sesión y se invalida si cambia el mtime de los archivos de configuración.
- Preferencia de comando: script del proyecto > binario local > ausente. Para `pnpm`/`npm`/`yarn` se infiere del lockfile (`pnpm-lock.yaml` primero, coherente con `AGENTS.md`).
- Ausencia total = rutas genéricas intactas; la herramienta `code_capabilities` lo dice.

### 4.3 Parsers (`packages/core/src/code/parsers/*.ts`, nuevo)

Funciones puras `parse(text: string): CodeDiagnostic[]` por analizador, sin E/S:

| Parser | Entrada | Notas |
| --- | --- | --- |
| `tsc` | `--pretty false`: `path(l,c): error TSxxxx: msg` | Fusiona líneas de continuación indentadas en `message`. |
| `eslint` | `--format json` si el script lo permite; si no, formato `stylish` | Preferir JSON; fallback tolerante. |
| `vitest` | `--reporter=json` cuando el comando lo admite; si no, texto | Alimenta `TestCaseResult` además de `CodeDiagnostic`. |
| `pytest` | `-q --tb=line` | `file:line: Error`. |
| `ruff`/`mypy` | salida concisa | Fase 3 (opcionales). |

Reglas: deduplicar por `(file,line,code,message)`; ordenar por `(severity, file, line)`; **un parser que no reconoce ninguna línea con código de salida ≠ 0 devuelve un único diagnóstico `source` genérico con las últimas líneas** (nunca «sin errores» con fallo). Probado con fixtures.

### 4.4 Herramientas (`packages/core/src/tools/code.ts`, nuevo)

| Herramienta | Efecto | Entrada | Salida |
| --- | --- | --- | --- |
| `code_capabilities` | `read` | `{}` | `CodeCapabilities` |
| `code_diagnostics` | `process` | `{ kind: CodeCheckKind, paths?: string[], limit?, cursor?, fresh? }` | `{ exitCode, truncated, total, diagnostics: CodeDiagnostic[], nextCursor?, logPath, treeFingerprint }` |
| `code_symbols` | `read` | `{ name: string, mode: "definition"\|"reference"\|"both", language?, glob?, limit?, cursor? }` | `{ matches: CodeSymbol[], truncated, nextCursor?, note }` |
| `code_test` | `read` en `plan`, `process` en `run` | `{ files: string[], mode: "plan"\|"run" }` | `{ command, rationale, results?: TestCaseResult[] }` |

- Registro en `registerStandardTools` solo si `code.enabled` (O1) y existe al menos una capacidad disponible; `code_symbols` requiere `rg`.
- `code_symbols`: patrones por lenguaje (p. ej. TS: `function|class|interface|type|const|let|enum <name>`, `export … <name>`; Python: `def|class <name>`) sobre `rg --json`; referencias = coincidencia de palabra completa excluyendo la línea de definición. Excluye `node_modules`, `dist`, `.git` y respeta `.gitignore` (comportamiento de ripgrep).
- `code_test` en `plan`: para vitest, `vitest related --run <files>`; para pytest, `-k` derivado del nombre de módulo, o los archivos de prueba cuyo nombre corresponde; si el runner no soporta selección, devuelve la suite completa marcada `rationale: "no related-selection support"`.
- `treeFingerprint`: hash de `git rev-parse HEAD` + `git diff --stat` + `git ls-files -o --exclude-standard` (solo lecturas) o fallback documentado.

### 4.5 Integración con otras especificaciones

- **Context Governor**: `code_diagnostics` declara criticidad `high` para errores y `low` para warnings, y su salida es elidible de forma determinista (los errores anteriores a una ejecución posterior del mismo `kind` son obsoletos). Sin esa spec, aplica el recorte existente de `reduceMessagesToBudget()` (`packages/core/src/core/compaction.ts`).
- **Proof**: cada `code_diagnostics` y `code_test` emite evidencia tipada `{kind: "typecheck"|"lint"|"test", command, exitCode, treeFingerprint, logPath}`; un verificador Proof puede **reutilizarla solo si la huella coincide** con el estado actual. Mientras Proof no exista, se escribe como `GoalEvidence` (`kind: "test"|"command"`) con el detalle resumido.
- **Lab**: dos variantes (A = genéricas, B = `code_*`) sobre una suite de tareas «arreglar el error de tipos», «encontrar dónde se define X», «¿qué prueba cubre este cambio?».

## 5. Fases

Cada fase: pruebas primero (Rojo), mínimo para verde, refactor. Criterios de aceptación = condición de cierre.

### Fase 0 — Medición base (sin código de producto)

- Con el Lab (si existe) o un script en `scripts/bench/` que reutilice `readBenchParams`/`mulberry32` de `scripts/bench/lib.ts`: definir 12–15 tareas sintéticas deterministas sobre un repo semilla (errores de tipos sembrados, símbolos conocidos, cambios con prueba asociada) y medir el baseline con las herramientas genéricas: turnos, tokens, aciertos de ubicación (archivo:línea correcto), éxito.
- **Aceptación**: informe de baseline reproducible (semilla fija) comprometido en `docs/`; el propietario fija la **umbral de promoción** (propuesta: ≥20 % menos tokens **o** ≥15 puntos más de acierto de ubicación, sin caer el éxito).
- **Pruebas**: determinismo del generador del repo semilla (misma semilla → mismo árbol).

### Fase 1 — Capacidades y parsers

- Implementar `code/capabilities.ts` y `code/parsers/{tsc,eslint,vitest,pytest}.ts`.
- **Aceptación**: (1) cada parser normaliza fixtures reales a `CodeDiagnostic`; (2) un parser con salida irreconocible y `exitCode ≠ 0` nunca devuelve lista vacía (D4/§4.3); (3) deduplicación y orden estables; (4) capacidades correctas en un repo TS+pnpm, un repo Python y un directorio vacío (todo `available: false` con `reason`).
- **Pruebas**: `tests/code-parsers.test.ts`, `tests/code-capabilities.test.ts` (directorios temporales, sin red).

### Fase 2 — `code_diagnostics` y `code_capabilities`

- `tools/code.ts`; ejecución con `runProcess` (`onOverflow: "truncate"`, `logFiles`), caché por `treeFingerprint`, paginación por cursor, registro condicionado a `code.enabled`.
- **Aceptación**: (1) la salida respeta `limit`/`truncated`/`nextCursor`; (2) el comando mostrado a la aprobación coincide con el ejecutado; (3) con la caché, una segunda llamada sin cambios no ejecuta el proceso y lo dice (`cached: true`); escribir un archivo la invalida; (4) sin analizador → `{available:false}`; (5) cancelación por `signal` mata el árbol de procesos (`killProcessTree`).
- **Pruebas**: `tests/code-diagnostics-tool.test.ts` con un «analizador» falso (script Node) que imprime salida tipo `tsc`.

### Fase 3 — `code_symbols` y `code_test`

- Heurística ripgrep por lenguaje; modos `plan|run` de `code_test`; render con `test-results`.
- **Aceptación**: (1) definición y referencias de un símbolo de un repo semilla aparecen con `path:line` correctos y `confidence: "pattern"`; (2) excluye `node_modules`/`dist`; (3) sin `rg`, `{available:false, reason}` (reutiliza `ripgrepDiagnostic`); (4) `code_test` en `plan` no ejecuta nada (efecto `read`); en `run` pasa por el gate; (5) runner sin selección → suite completa con `rationale`.
- **Pruebas**: `tests/code-symbols-tool.test.ts`, `tests/code-test-tool.test.ts`.

### Fase 4 — Puerta de promoción con el Lab

- Repetir la Fase 0 con `code.enabled: true`; comparar con el baseline.
- **Aceptación**: informe A/B con el umbral de la Fase 0. **Si se cumple**, proponer al propietario cambiar el valor por defecto en la siguiente minor; **si no**, las herramientas quedan opt-in y se documenta el resultado en `docs/implementation-status.md` (resultado negativo válido).
- **Pruebas**: el arnés ejecuta ambas variantes con proveedor guionado; verifica que el informe contiene ambas columnas y semilla.

### Fase 5 — Superficies y documentación

- `alisio code capabilities [--json]`, ruta `GET /api/code/capabilities` (solo lectura), ajuste `code.enabled` en Settings (Web/TUI, EN/ES), docs EN/ES en paridad (`docs/tools.md`, `docs/configuration.md`), límites en `docs/implementation-status.md`. Captura Web UI de la herramienta en una sesión (`docs/assets/web-ui/code_intelligence_web_ui.webp`, EN y ES) según `AGENTS.md`.
- **Aceptación**: `pnpm docs:check` pasa con paridad; la configuración es global-only o por proyecto según la política existente de ajustes (O: confirmar en revisión); paridad CLI/TUI/Web verificada.
- **Pruebas**: `tests/server-code.test.ts`, prueba de CLI `--json`.

## 6. Pruebas transversales

- Sin red ni analizadores reales: fixtures y scripts Node falsos.
- Regresión de compatibilidad: con `code.enabled: false` el registro de herramientas es **idéntico** a 0.6.x (prueba sobre la lista de nombres).
- Seguridad: el modelo no puede inyectar argumentos (enumeración cerrada de `kind`; rutas `paths` validadas dentro del workspace con las utilidades de `runtime/paths.ts`).

## 7. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Catálogo inflado sin beneficio | Puerta del Lab (Fase 4); opt-in por defecto (O1). |
| Heurística de símbolos imprecisa | D6: `confidence: "pattern"`, nota explícita, sin afirmaciones negativas. |
| Coste de typecheck completo | Caché por huella; `paths` opcional; `timeoutMs` finito. |
| Salida de analizador con instrucciones inyectadas | D5: dato no confiable, delimitado y recortado. |
| Deriva de formato de `tsc`/`eslint` | Preferir salidas JSON; fallback tolerante; fixtures por versión. |
| Falso «todo bien» por parser roto | Regla de §4.3: salida irreconocible con fallo nunca queda vacía. |

## 8. Fuera de esta entrega (candidatos)

Adaptador de servidor de lenguaje por subproceso (O3), más lenguajes, símbolos exportados por archivo, diagnósticos incrementales por archivo cambiado.

## 13. Asignación de modelos

| Trabajo | Modelo |
| --- | --- |
| Parsers, capacidades, herramientas, superficies, docs | Sonnet 5.5 |
| Diseño del umbral de promoción y revisión de la puerta del Lab (Fase 0/4) | Opus 5.5 (razonamiento profundo sobre qué medir) |
| Revisión de seguridad de la construcción de comandos (D3) | Opus 5.5 |

## 14. Estado

**Borrador (2026-10-13).** Pendiente de revisión del propietario: decisiones O1–O7 y umbral de promoción de la Fase 0. No se ejecuta hasta aprobación.
