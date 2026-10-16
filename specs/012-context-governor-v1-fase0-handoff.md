# Handoff: Context Governor, Fase 0 (para reanudar)

| Campo | Valor |
| --- | --- |
| Spec | `specs/012-context-governor-v1.md` (Estado: aprobada 2026-10-15) |
| Documento | Nota operativa de relevo; **no es una especificación** y no ejecuta nada por sí sola |
| Fecha | 2026-10-15 |
| Base | `main`, 0.8.0, commit `c876aa6`; **todo lo descrito abajo está sin commit** |
| Fase | 0 (medición base): **medición terminada** (2026-10-15/16); `chain-walk-format-rule` resultó inválida (enunciado ambiguo) y se añadió `chain-walk-rules` (suite 1.1.0, no discrimina). **Fase 0 CERRADA el 2026-10-16**: el propietario aprobó el protocolo de la puerta de la Fase 6 (G1 a G3, M = 10 pp, segundo modelo `mimo-v2.6-flash`; T por fijar tras las Fases 1 y 2). Siguiente: Fase 1, solo cuando el propietario lo pida. Resultados definitivos en la spec, «Registro de la Fase 0»; §3 y §5.2/5.3 de este archivo quedan como historial |

## 1. Dónde estamos

- La spec 012 está **aprobada**; O1..O8 confirmadas (O1 `off→shadow→on`; O2 ≤2 pp; O3 2 vueltas; O4 grants como texto breve; O5 sin persistir ledger; O6 `/context` en TUI desde el inicio; O7 aplica a subagentes; O8 sin elisión de web).
- `packages/core/src/context/` **no existe**: del Governor no hay código.
- Fase 0 **no cerrada**: falta una línea base utilizable y la aprobación del umbral. La spec exige que el propietario revise la Fase 0 antes de la Fase 1.
- El registro detallado de resultados está en la spec, bajo la Fase 0 («Registro de la Fase 0»). Este archivo solo añade lo necesario para retomar.

## 2. Qué existe en el árbol de trabajo (sin commit)

| Ruta | Estado | Qué es |
| --- | --- | --- |
| `specs/012-context-governor-v1.md` | modificado | Estado aprobado, O1..O8 confirmadas, registro de Fase 0 |
| `specs/012-context-governor-v1-fase0-handoff.md` | nuevo | Este archivo |
| `tests/fixtures/eval/long-context-stress/` | nuevo (~296 KB) | Suite `long-context-stress` v1.0.0 (4 tareas), `compare.json`, fixtures |
| `scripts/eval-gen-long-context-stress.ts` | nuevo | Generador determinista (`pnpm eval:gen-stress`) |
| `scripts/eval-record-bundled.ts` | modificado | Scripts de referencia de las 4 tareas; `configOverrides` y `answerCompactions` |
| `tests/eval-bundled-suites.test.ts`, `tests/eval-ci.test.ts` | modificados | Validan la suite nueva |
| `package.json` | modificado | Script `eval:gen-stress` |
| `docs/eval.md`, `docs/es/eval.md`, `docs/limitations.md`, `docs/implementation-status.md` | modificados | Suite nueva y límites (EN/ES) |

Verificación que reportó el agente escritor: `pnpm test` (313 archivos, 4520 pruebas, 1 saltado), `pnpm typecheck`, `pnpm lint`, `pnpm docs:check` en verde. **No se ejecutaron** `pnpm build` completo tras los cambios, `test:cli`, `test:compiled`, `pack:check` ni `docs:build`. Antes de confirmar hay que correr la lista completa de `alisio-coding-standards`.

La suite `long-context` (v1.0.0) **no se modificó** a propósito, para conservar su línea base comparable.

## 3. Resultados medidos hasta ahora (2026-10-15, harness 0.8.0, live, `--seed 12`)

1. `long-context`, k=5, `opencode-go/deepseek-v4.1-flash`: **14/14 juzgados pasan**, 1 error `HTTP 400`; ~3 turnos y ~18k tokens de entrada por run, sin compactación → **saturada**, no detecta un umbral de 2 pp.
2. Piloto `long-context-stress`, k=2, ambas variantes, mismo modelo (16 runs): `default-limit` 7 pasan / 0 fallan / 1 error; `small-context` 4 pasan / 1 falla / 3 errores. `small-context` compacta de 1 a 4 veces por run; `default-limit`, nunca. El fallo fue de formato exacto de `report.txt` (posible pérdida de la regla tras compactar; no concluyente con 1 run).
3. **4 de 16 runs con `OpenCode request failed: HTTP 400`** en los turnos 1 a 3 (3 en `small-context` tras una compactación temprana; 1 en `default-limit` en el turno 1). Causa **desconocida**: el plugin externo `@alisio/plugin-opencode-go` 0.1.6 descarta el cuerpo de error (`dist/provider.js:56`).
4. Intento de diagnóstico con la API directa de DeepSeek (`deepseek-flash`), `small-context`, k=3: se canceló tras 2 de 12 runs (ambos pasaron, 0 errores HTTP). **Sin conclusión sobre el 400.**

Nada de esto permite afirmar mejora ni regresión del Governor (el Lab lo declara baja potencia).

## 4. Hechos verificados que conviene no volver a investigar

- **Compactación**: la dispara `limits.maxContextChars` (por defecto 800 000; umbral 0,85). Es un disparador por caracteres **independiente de la ventana del modelo** (`packages/core/src/core/runner.ts`, `compaction.ts`: `shouldCompactContext`, `effectiveContextBudget`). Un modelo de 1M de contexto compacta igual con `maxContextChars: 40000`.
- El formato de tarea del Lab **no admite overrides de configuración**; solo `eval variants` (claves hasheadas, entre ellas `limits`). `eval run` no tiene flag de override.
- Las compactaciones ya se registran como incidente: `incidents: [{kind: "compaction", count}]` en cada `EvalRunRecord`. `measured` hoy trae `inputTokens, outputTokens, wallMs, turns, toolCalls`. Los tokens del resumidor **no** se miden.
- La suite pide solo `--allow-write` (la antigua `long-context` sí pide además `--allow-process` por `truncated-command-output`). Una suite no puede pedir más permisos que quien la invoca (D16 de `specs/archive/010-reliability-lab-v1.md`).
- El perfil activo de Alisio es `opencode-go` (modelo mimo). No hay flag para elegir otro perfil; `--model` solo cambia el modelo dentro del proveedor activo.
- Modelos de la API directa de DeepSeek (`GET /v1/models`): `deepseek-flash`, `deepseek-v4-pro`. **`deepseek-flash` es el nombre de API de DeepSeek-V4.1-Flash** (<https://api-docs.deepseek.com/quick_start/pricing/>).
- Los resultados de OpenCode y de la API directa **no son comparables entre sí** (otro proveedor y otro `configHash`).

## 5. Cómo reanudar (cada paso lo ejecuta el propietario si consume tokens)

### 5.1 Antes de gastar tokens

1. `pnpm build` y `pnpm test -- tests/eval-bundled-suites.test.ts` para confirmar que el árbol sigue verde y `node packages/cli/dist/main.js eval list` muestra `long-context-stress`.
2. Resolver las **decisiones abiertas** (ver §6).

### 5.2 Diagnosticar el HTTP 400 (recomendado antes del k=5)

Configuración aislada para usar el perfil `deepseek` sin tocar el activo (ajustar rutas; `S` = un directorio temporal tuyo):

```bash
C=$S/cfg-deepseek && mkdir -p $C
cp ~/.config/alisio/config.json $C/config.json
ln -s ~/.config/alisio/plugins $C/plugins
# providers.json con solo el perfil deepseek y active: "deepseek"
node -e '
const p=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.config/alisio/providers.json","utf8"));
require("fs").writeFileSync(process.argv[1]+"/providers.json",JSON.stringify({schemaVersion:1,profiles:{deepseek:p.profiles.deepseek},active:"deepseek"},null,2))' $C
# límite pequeño, solo en esta config aislada
node -e '
const f=process.argv[1]+"/config.json";const c=JSON.parse(require("fs").readFileSync(f,"utf8"));
c.limits={...(c.limits||{}),maxContextChars:40000};require("fs").writeFileSync(f,JSON.stringify(c,null,2))' $C
```

Capturador temporal de respuestas con error (guardar como `$S/capture-errors.cjs`; no registra cabeceras ni claves):

```js
const fs = require("node:fs");
const out = process.env.CAPTURE_FILE;
const real = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const res = await real.call(this, input, init);
  if (res.status >= 400) {
    try {
      const url = new URL(typeof input === "string" ? input : (input.url ?? String(input)));
      const body = await res.clone().text();
      const reqLen = typeof init?.body === "string" ? init.body.length : -1;
      fs.appendFileSync(out, JSON.stringify({ t: new Date().toISOString(), status: res.status, where: url.host + url.pathname, reqChars: reqLen, body: body.slice(0, 2000) }) + "\n");
    } catch {}
  }
  return res;
};
```

Ejecución (clave solo por entorno, nunca pegada en el chat ni en archivos):

```bash
export DEEPSEEK_API_KEY=<tu clave>   # o leerla de credentials.json sin imprimirla
CAPTURE_FILE=$S/errors.jsonl NODE_OPTIONS="--require $S/capture-errors.cjs" \
ALISIO_CONFIG_HOME=$C \
node packages/cli/dist/main.js --allow-write eval run long-context-stress --k 3 --seed 12 --out $S/ds-capture
```

Si aparece algún 400, `errors.jsonl` traerá el cuerpo y el tamaño de la petición. Para repetirlo con OpenCode, usar el mismo preload con `--model opencode-go/deepseek-v4.1-flash` (sin `ALISIO_CONFIG_HOME`).

### 5.3 Línea base final (cuando los errores sean ~0)

```bash
node packages/cli/dist/main.js --model <modelo> --allow-write eval variants long-context-stress \
  --variants tests/fixtures/eval/long-context-stress/compare.json --k 5 --seed 12 --out <dir>
```

- 40 runs; estimado ~9M tokens de entrada (**no medido**; el agente estimó ~220k por run).
- En cada reporte revisar `turns` y `incidents.compaction`; si `small-context` no compacta, bajar el límite.
- Con k=5 y 100% de éxito el intervalo de Wilson sigue siendo ancho (~57%–100%); un umbral de ≤2 pp requiere tareas que **discriminen** (que no saturen) o más repeticiones.

### 5.4 Cerrar la Fase 0

1. Escribir la línea base final en la spec (sustituir el «Registro de la Fase 0» por la tabla definitiva) y fijar el umbral de O2.
2. El propietario revisa y aprueba.
3. Ejecutar la lista de entrega y solo entonces pedir/hacer commit (el propietario decide).
4. Pasar a la Fase 1 (`core/src/context/{types,inventory}.ts`, prueba de propiedad de llamada/resultado con `mulberry32` de `scripts/bench/lib.ts`).

## 6. Decisiones de la Fase 0 (cerradas por el propietario, 2026-10-15)

1. **Confirmada**: `limits.maxContextChars: 40000` como variante `small-context` (`STRESS_COMPACTION_LIMIT_CHARS`; con 20 000 hay thrashing, con el límite por defecto no compacta).
2. **Confirmada**: `maxTokens` 450 000 por run (coste estimado, no medido).
3. **Resuelta**: se usa el incidente `compaction` existente; **no** se añade `measured.compactions` ni se toca `@alisio/sdk`.
4. **Resuelta**: la línea base oficial usa la API directa `deepseek-flash` con la configuración aislada de §5.2 (no comparable con OpenCode).
5. **Resuelta**: la Fase 1 **no** arranca antes de que el propietario revise la Fase 0.

Siguiente paso real: §5.2 (diagnóstico del HTTP 400 con captura) y luego §5.3 (k=5). Ambos consumen tokens y los lanza el propietario.

## 7. Reglas que siguen vigentes

- TDD estricto; sin commit hasta que el propietario lo pida; solo pnpm; Node ≥22.16 y compatible con Bun; docs EN/ES en paridad.
- No ejecutar nada que consuma tokens sin autorización del propietario; no pegar claves en el chat.
- Reportar los resultados como medidos, con sus condiciones (suite, versión, modelo, k, semilla, `configHash`).
