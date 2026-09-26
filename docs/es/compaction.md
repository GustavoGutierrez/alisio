# Compactación de contexto

La compactación reemplaza los mensajes antiguos por un **checkpoint estructurado** generado por el
proveedor actual y conserva intactos los turnos recientes. Los mensajes reemplazados permanecen en la
base de datos de sesiones marcados como compactados (para auditoría), pero ya no se envían al modelo.

## Secciones del checkpoint

Al resumidor se le pide JSON validado con zod. El checkpoint tiene estas secciones:

| Sección | Campo | Contenido |
| --- | --- | --- |
| Goal | `goal` | Lo que la sesión intenta lograr |
| User instructions/constraints | `instructions` | Instrucciones y restricciones indicadas por el usuario |
| Discoveries | `discoveries` | Hechos aprendidos en el camino |
| Accomplished | `accomplished` | Trabajo ya realizado |
| Current state | `currentState` | Situación actual |
| Next steps | `nextSteps` | Lo que queda pendiente |
| Relevant files | `relevantFiles` | Archivos relevantes |

Si el resumidor no devuelve JSON válido, su texto se usa tal cual (un checkpoint solo de texto).

## Garantías

- Una llamada a herramienta nunca se separa de sus resultados, y los IDs de llamada nunca se alteran.
- Se conservan `keepTurns` turnos recientes; si hay menos, se conserva al menos el último. Dentro de un
  único turno largo, el corte se hace en el último límite seguro entre llamadas.
- Una sesión con resultados de herramientas inciertos no se compacta hasta recuperarla.
- La persistencia es transaccional.

## Manual y automática

- **Manual**: `/compact [focus]` en la TUI, con instrucciones de foco opcionales.
- **Automática**: antes de una llamada al modelo, cuando el contexto usado alcanza `threshold` de una
  ventana de contexto **conocida** (`provider.contextWindow`, el `values.contextWindow` del perfil
  activo de `/connect`, o `GET /models`). Cuando la ventana es
  desconocida — o una ventana declarada es absurdamente grande (más de `2_000_000` tokens, para que
  `ventana × threshold` no oculte la presión real) — Alisio recurre a `limits.maxContextChars`:
  los tokens estimados (≈ caracteres / 4) que alcanzan `maxContextChars / 4` también compactan.
  Aplica exactamente uno de los dos criterios, de modo que la barra de contexto de la TUI y el motor
  siempre coinciden sobre cuándo se compacta. `maxContextChars` además sigue siendo el límite duro
  posterior a la compactación: si comprimir no logra quedarse por debajo, la cola conservada se
  reduce (ver más abajo) y solo una sesión irreducible falla con un error accionable en vez de enviar
  una petición descomunal. `auto: false` desactiva la
  compactación automática por completo.

## Configuración

```json
{
  "compaction": { "auto": true, "threshold": 0.85, "keepTurns": 2, "maxOutputTokens": 16000 }
}
```

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `auto` | `true` | Compactación automática |
| `threshold` | `0.85` | Fracción de una ventana de contexto conocida (0.1–0.99) |
| `keepTurns` | `2` | Turnos recientes conservados sin cambios (0–20) |
| `maxOutputTokens` | `16000` | Presupuesto de tokens de salida para la llamada del resumidor; independiente de `limits.maxOutputTokens` |

La ventana de contexto proviene de `provider.contextWindow`, del `values.contextWindow` del perfil
activo de `/connect`, o de `GET /models`. El consumo de tokens de
la compactación no se descuenta de `limits.maxTokens`, y las estimaciones antes/después son
aproximadas (unos 4 caracteres por token).

## Resúmenes truncados

El resumidor tiene su propio presupuesto de salida (`compaction.maxOutputTokens`, por defecto 16000 —
mayor que el `limits.maxOutputTokens` del bucle del agente a propósito, porque un resumen debe caber en
todo el historial). Si el presupuesto corta un resumen:

- Un resumen parcial **aprovechable** (JSON de checkpoint estructurado o texto plano) se conserva: la
  compactación termina y `compaction_completed` incluye `"partial": true`. El aviso de la TUI marca el
  checkpoint como parcial y sugiere aumentar `compaction.maxOutputTokens`.
- Si el corte no produjo **nada aprovechable**, la compactación falla con un mensaje accionable que
  apunta a `compaction.maxOutputTokens`.

Un checkpoint parcial conserva todo lo que el modelo produjo antes del corte, pero puede omitir
contexto posterior; trátelo como un respaldo degradado, no como un resumen completo.

## Reducción de una cola conservada descomunal

La compactación conserva `keepTurns` turnos recientes **sin cambios**. Si esos turnos contienen
salidas enormes de herramientas (por ejemplo `grep` sobre un repositorio grande), ni siquiera un
checkpoint perfecto logra dejar la petición por debajo de `limits.maxContextChars`, y la sesión
solía morir en cada prompt. En su lugar, tras una compactación el runner ahora comprueba el límite
duro y, si sigue superado, **reduce los mensajes conservados en su sitio** antes de enviar nada:

- Los resultados de herramientas de más de **8 000 caracteres** y los textos de usuario/asistente de
  más de **16 000 caracteres** se cortan con el marcador explícito `… [truncated by context budget]`.
  Los límites aplican por mensaje.
- Solo cambia el **contenido** de los mensajes: roles, IDs de llamada, orden y fronteras de mensajes
  quedan idénticos, de modo que el transcript sigue siendo válido y reproducible y una llamada a
  herramienta nunca se separa de sus resultados. El transcript reducido se persiste (los originales
  permanecen en la base marcados como compactados, igual que en la propia compactación).
- El evento `context_reduced` informa cuántos mensajes se cortaron.
- Solo si incluso la cola reducida supera el límite — una sesión patológica — la ejecución falla con
  un error accionable que nombra el tamaño aproximado y sugiere `/compact`, recortar salidas grandes
  de herramientas o iniciar una sesión nueva. La reducción igualmente se persiste, así que la sesión
  sigue funcionando para prompts posteriores.

Los checkpoints (`summary: true`) están acotados por diseño y este paso nunca los corta.

## Eventos

| Evento | Cuándo |
| --- | --- |
| `compaction_started` | Comienza la compactación |
| `compaction_completed` | Terminó; incluye estimaciones `before`/`after`, el tamaño del tramo resumido y del checkpoint, informes de plugins y `partial: true` cuando el resumen se cortó pero se conservó |
| `compaction_skipped` | No hay historia suficiente para compactar |
| `context_reduced` | Tras la compactación los mensajes conservados seguían superando `maxContextChars` y se cortaron por mensaje (`messages` = cuántos) |
| `compaction_failed` | Falló la llamada al resumidor (incluido un resumen cortado sin nada aprovechable) |
| `plugin_hook_failed` | Un hook de plugin falló o agotó su tiempo; la compactación continúa sin él |

Con `--json` los eventos se emiten como JSONL versionado.

## Modo Responses

En modo Responses, los items opacos de continuación (por ejemplo, el razonamiento cifrado) del tramo
resumido se descartan junto con esos mensajes. Los mensajes conservados mantienen los suyos sin cambios.

## Hooks de plugins

Los plugins pueden ampliar la compactación con `compaction.register({ beforeCompact, afterCompact })`:

- `beforeCompact` añade instrucciones y campos JSON adicionales (`outputFields`) a la **misma** llamada
  al resumidor.
- `afterCompact` recibe el checkpoint y los campos extraídos propios del plugin, y puede devolver
  `injectContext` (texto añadido tras el checkpoint) y un `report` (su `summary` se muestra en la TUI).

Los hooks se ejecutan con el tiempo límite del host `pluginHooks.timeoutMs`. El
[plugin de memoria](/es/memory) integrado usa estos hooks. Consulte
[Escribir plugins](/es/plugins#compaction-hooks).

## Resultados inciertos de herramientas {#uncertain-tool-results}

Si una caída deja una herramienta con un resultado incierto, Alisio no la repite automáticamente.
Inspeccione sus efectos y después ejecute:

```sh
alisio sessions recover <session> --acknowledge
```

La recuperación registra la incertidumbre como resultado; no asegura que un efecto externo se haya
completado ni deshace cambios.
