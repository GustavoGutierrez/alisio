# Configuración

## Selección global del proveedor

En la TUI, `/connect` escribe los perfiles no secretos y el proveedor/modelo activo en
`<config home>/providers.json`. Los secretos se guardan por separado en
`<config home>/credentials.json`, escrito atómicamente con modo `0600`; el directorio usa `0700`
donde se admiten permisos POSIX. Es protección del sistema de archivos, **no cifrado**. Las claves
nunca aparecen en `doctor`, el inicio, los eventos ni el estado de plugins.

Los `values` de un perfil pueden incluir un `contextWindow` opcional (en **tokens**) para el modelo
de ese perfil. Existe para servidores locales compatibles con OpenAI (por ejemplo llama.cpp) cuyo
`GET /models` omite `context_window`: con él, la barra de contexto y la compactación automática usan
la ventana real en lugar de un honesto `?`. `/connect` lo pregunta cuando el catálogo descubierto no
informa la ventana del modelo seleccionado. La ventana efectiva de un modelo es, por prioridad: el
`provider.contextWindow` heredado (solo para el modelo configurado), luego el
`values.contextWindow` del perfil activo (intención del usuario: prevalece sobre el catálogo) y
luego el `context_window` del propio catálogo.

Cada conexión también recuerda el nombre de la variable de entorno de su clave de API: los `values`
del perfil guardan `apiKeyEnv` (el nombre que elegiste para esa conexión). Cuando un proveedor
necesita una clave, la precedencia es: primero la credencial guardada en `credentials.json`, luego
`process.env[apiKeyEnv]` usando el **nombre recordado en el perfil** y, solo si el perfil no lo
registra, el nombre por defecto del plugin (por ejemplo `OPENAI_API_KEY` para OpenAI-compatible;
los plugins de proveedores dedicados como DeepSeek registran su propio valor).
Como el nombre se persiste con el perfil, el
respaldo por entorno sigue funcionando aunque luego se elimine la credencial guardada. No interviene
ningún almacén de secretos nuevo: el nombre de la variable de entorno es un valor de configuración
no secreto, y las claves solo se leen del archivo de credenciales o de esa variable de entorno.

`/model` y `/models` abren el mismo selector global. Agrupa por título de proveedor todos los
perfiles creados mediante `/connect`, marca la pareja proveedor/modelo activa y mantiene disponibles
los perfiles sanos si falla otro catálogo. Elegir una pareja distinta la persiste e inicia una sesión
nueva; elegir la pareja activa no hace nada. La configuración raíz `provider` heredada se conserva
para compatibilidad de inicio y modos headless, pero no aparece en este selector.

Los selectores usan `proveedor/modelo` como forma canónica, por ejemplo
`deepseek/deepseek-chat`. Un ID sin proveedor solo se acepta cuando coincide exactamente con un
perfil configurado mediante `/connect`. Cero coincidencias falla con opciones disponibles; varias
fallan por ambigüedad. La pareja global activa es el valor por defecto de las sesiones nuevas, no
estado mutable compartido: un hijo o reemplazo programático queda vinculado sin modificar al padre.

Los integradores pueden usar `app.listAvailableModels()`, `app.resolveModel(reference)`,
`app.createSession(reference?)` y `app.switchModel(reference)`. Solo participan en la resolución
cruzada los perfiles globales de `/connect`; la configuración raíz heredada `provider` sigue siendo
compatibilidad de arranque/headless. Los metadatos y errores nunca exponen credenciales.

La configuración raíz `provider`, las variables de entorno y los flags heredados siguen admitidos y
no se reescriben. `AppOptions.provider` tiene máxima prioridad. Después, una anulación explícita del
endpoint (`--base-url`, `--api-mode`, `OPENAI_BASE_URL`, `ALISIO_API_MODE`) o una capa de proyecto de
confianza/explícita que defina un `provider` en la raíz utilizable — su `provider.model` analizado no
está vacío y no es el marcador `YOUR_MODEL_ID` que escribe `alisio setup` — selecciona el proveedor
heredado compatible con OpenAI para esa ejecución; un modelo vacío o marcador nunca anula una
selección de `/connect`. Los ajustes de MCP, plugins, skills u otros campos por sí solos no lo hacen.
En caso contrario se restaura el perfil activo de `/connect`; `--model` o `ALISIO_MODEL` solo pueden
reemplazar su modelo. El `provider` heredado global es el respaldo cuando no existe un perfil
guardado, por lo que no anula de forma permanente una selección de `/connect`.
Los modos headless nunca preguntan.

Un proveedor de modelos está integrado y activado por defecto: **Compatible con OpenAI**. Los
proveedores dedicados de la tabla siguiente son plugins independientes publicados desde el
monorepo [alisio-plugins](https://github.com/GustavoGutierrez/alisio-plugins): instálelos con
`alisio install npm:@alisio/plugin-deepseek`, `alisio install npm:@alisio/plugin-opencode` y
`alisio install npm:@alisio/plugin-opencode-go`, y aparecerán en `/connect` como el integrado:

| Proveedor | Alcance |
| --- | --- |
| DeepSeek | Descubre modelos desde `https://api.deepseek.com`; admite Chat Completions y Responses. `/connect` también muestra una URL base opcional, etiquetada para proxies compatibles con DeepSeek. |
| OpenCode Console (Zen) | Descubre entradas `opencode/<id-del-modelo>` desde `https://opencode.ai/zen/v1/models`. Los modelos documentados GPT/Grok/Muse usan Responses; DeepSeek/GLM/Kimi/MiMo/MiniMax y los compatibles documentados usan Chat Completions; Claude y los Qwen documentados usan Anthropic Messages. Se ocultan Gemini nativo y System One. |
| OpenCode Go | Descubre entradas `opencode-go/<id-del-modelo>` desde `https://opencode.ai/zen/go/v1/models`. Su mapa independiente envía GPT/Grok/Muse a Responses, familias abiertas compatibles a Chat Completions y MiniMax/Qwen a Anthropic Messages. |
| Compatible con OpenAI | Endpoint genérico y configurable de Chat Completions o Responses. |

Las peticiones de modelos de OpenCode Console y Go envían `user-agent: alisio/<versión>` y un identificador opaco y
estable de conversación `x-opencode-session`. Ninguna cabecera contiene rutas, prompts ni credenciales.
Sus catálogos no requieren autenticación. Ambos fallan de forma cerrada: ocultan cualquier entrada
ausente del mapa de protocolos documentado, en lugar de adivinar su endpoint.

Alisio combina la configuración global con una capa seleccionada y valida cada archivo de forma
estricta (se rechazan las claves desconocidas). La precedencia se describe en
[Servidores MCP](#servidores-mcp) y el
[modelo de confianza de la configuración](/es/quick-start#configuration-trust-model).

```json
{
  "schemaVersion": 1,
  "provider": {
    "baseURL": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "YOUR_MODEL_ID",
    "apiMode": "chat",
    "auth": "bearer",
    "tokenParameter": "max_tokens",
    "streamUsage": false
  },
  "limits": { "maxTurns": 100, "timeoutMs": 600000, "firstTokenTimeoutMs": 90000, "firstTokenRetries": 1 },
  "compaction": { "auto": true, "threshold": 0.85, "keepTurns": 2, "maxOutputTokens": 16000 },
  "builtinPlugins": { "memory": { "enabled": true } },
  "pluginHooks": { "timeoutMs": 15000, "sessionEndTimeoutMs": 10000 },
  "plugins": [],
  "skills": [],
  "additionalDirectories": [],
  "mcp": { "servers": {} }
}
```

`schemaVersion` debe ser `1` (el valor por defecto).

## `provider`

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `baseURL` | `https://api.openai.com/v1` | URL base, incluyendo `/v1` cuando el servidor lo requiera. Solo HTTP(S), sin credenciales en la URL |
| `apiKeyEnv` | `OPENAI_API_KEY` | Nombre de la variable de entorno que contiene la clave |
| `model` | `""` | Identificador exacto del modelo en su servidor (obligatorio para ejecutar) |
| `apiMode` | `chat` | `chat` (Chat Completions) o `responses` (API Responses) |
| `auth` | `bearer` | `bearer` o `none`; `none` omite la cabecera `Authorization` |
| `tokenParameter` | `max_tokens` | Solo en modo chat: `max_tokens`, `max_completion_tokens` u `omit` |
| `streamUsage` | `false` | Solicitar estadísticas de uso durante el streaming, si el servidor lo soporta |
| `contextWindow` | ninguno | Ventana de contexto opcional en tokens para el modelo configurado; tiene prioridad sobre `GET /models` |

El modo chat maneja mensajes de texto y function tool calls. El modo Responses conserva los items
opacos del proveedor, incluido el razonamiento cifrado para continuación con `store: false`. Un
proveedor compatible puede implementar solo una parte de la API de OpenAI: valide su modelo y endpoint.

Dentro de la configuración heredada del proveedor, la precedencia es archivo global → archivo de
proyecto de confianza o explícito → variables de entorno → flags de la CLI. La precedencia de
selección anterior determina cuándo se usa esa configuración en lugar del perfil activo de
`/connect`.

## `limits`

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `maxTurns` | `100` | Turnos del modelo por ejecución (1–100). Cada turno es una respuesta del modelo; una ejecución que solo llama a herramientas muchas veces puede agotarlos. El límite es un **carril de seguridad, no un tope duro**: al alcanzarlo la ejecución termina *suavemente* — todo lo producido hasta ese punto se conserva en el transcript, la ejecución se reporta como `turns-exceeded` (resultado parcial, sin fallo) y puedes simplemente volver a pedir para continuar en la misma sesión. Los topes duros reales son el presupuesto de tokens (`maxTokens`) y el tiempo de espera de ejecución. Súbelo para auditorías extensas con mucha lectura |
| `timeoutMs` | `600000` | Límite de reloj de **toda la ejecución** en milisegundos (mínimo 100; antes de 0.1.0-alpha.27 el valor por defecto era 300000). Abarca cada turno del modelo, cada llamada a herramientas (Python incluido) y las esperas de aprobación, así que una tarea larga de dashboard que funciona bien también puede alcanzarlo. No es un tiempo límite por petición ni de inactividad. Al cumplirse, la ejecución queda registrada como `failed` (no `cancelled`) con un mensaje legible que nombra el modelo y el proveedor, y `run_failed` incluye `code: "timeout"` con los detalles. Súbelo para análisis largos |
| `firstTokenTimeoutMs` | `90000` (`0` = desactivado) | Detiene una petición al modelo que permanece completamente en silencio (sin deltas de texto, razonamiento ni llamadas a herramientas) durante esos milisegundos, para que una conexión encolada o atascada falle pronto y no tras `timeoutMs`. `0` lo desactiva. Los 90 s por defecto cubren a DeepSeek, que llegó a responder tras 56 s de cola; un modelo que no emite su razonamiento en streaming puede callar más de 90 s, así que sube `firstTokenTimeoutMs` o ponlo en `0` para esos. Cuando salta y quedan reintentos (ver `firstTokenRetries`) se reenvía la misma petición; si no, el fallo es un `run_failed` con `code: "timeout"`, `kind: "first_token"` y `attempts` |
| `firstTokenRetries` | `1` (`0` = desactivado, máx. `3`) | Cuántas veces se reenvía la misma petición tras quedar en silencio durante `firstTokenTimeoutMs`. Una conexión atascada suele responder al siguiente intento (una petición a DeepSeek repetida 6 veces se atascó una vez y las otras cinco respondieron en unos 2 s). Solo se reintenta cuando no llegó nada de la petición (ni texto, ni razonamiento, ni llamadas a herramientas); no es un turno (no consume `maxTurns`), no se añade nada a la sesión y la ejecución emite un evento `request_retry` (`attempt`, `of`, `reason: "first_token_timeout"`, `afterMs`). Tras una pausa fija breve (250 ms, interrumpible con una detención) la petición se reenvía con un temporizador nuevo; un reintento que no cabe en el `timeoutMs` de toda la ejecución no se inicia. Con los valores por defecto el peor caso antes de fallar es de unos 2 × 90 s más la pausa. El reintento vive en el runner, así que vale para todos los proveedores. Se fija en el archivo de configuración; se aplica desde la siguiente ejecución |
| `truncationRecoveries` | `2` (`0` = desactivado, máx. `5`) | Cuántas veces se vuelve a pedir un turno cuando la respuesta del modelo se cortó por `maxOutputTokens` antes de ser útil: sin texto visible ni llamada a herramienta (normalmente razonamiento que gastó todo el presupuesto), o una llamada a herramienta cuyos `arguments` son un JSON incompleto (un script largo de `python_run` cortado a mitad de una cadena). Una llamada cortada **nunca se ejecuta ni se guarda** (no tendría resultado y las API de los proveedores lo rechazan); el texto visible de la respuesta cortada se conserva como un mensaje normal del asistente. La siguiente petición lleva un aviso breve y transitorio (no se persiste) que le dice al modelo que su respuesta se cortó, que no repita lo ya producido, que trabaje en pasos más pequeños y que razone poco. En la primera recuperación de una respuesta que no produjo nada, el esfuerzo de razonamiento baja un nivel solo para esa petición, siempre que el modelo anuncie sus niveles de esfuerzo. Una recuperación no es un turno (no consume `maxTurns`) y emite un evento `truncation_recovery`; `maxOutputTokens` nunca se sube por ti. Cuando se agotan las recuperaciones la ejecución falla con `code: "output_truncated"` y un mensaje que nombra el modelo y el límite. Una respuesta con texto útil y sin llamadas a herramientas no se recupera: termina con el aviso `response_truncated`, y las llamadas completas de una respuesta cortada siguen ejecutándose. Se fija en el archivo de configuración o con `/settings`; se aplica desde la siguiente ejecución |
| `maxContextChars` | `800000` | Límite de longitud del contexto en caracteres. El valor por defecto (800k caracteres ≈ 200k tokens) es una **suposición para ventanas de modelo desconocidas** — el mismo presupuesto de ~200k tokens que OpenCode asume para proveedores personalizados — para que los servidores locales que no informan su ventana (p. ej. llama.cpp) obtengan ~200k tokens en lugar de ~40k. Actúa como **disparador de compactación por defecto (fallback)** cuando la ventana del modelo es desconocida (o absurdamente grande; ver [compactación](/es/configuration#compaction)) — tokens estimados (`~caracteres/4`) que alcanzan `maxContextChars / 4` — y como **límite duro** que debe caber tras una compactación. Una ventana **conocida** anula el respaldo, y `/settings` → Presupuesto de caracteres de contexto permite bajarlo en cualquier momento |
| `maxOutputTokens` | sin definir: el límite declarado por el modelo (máx. `65536`), si no `16384` | Tokens de salida por petición. **Un valor que tú fijas siempre gana**, incluso por encima de lo que declara el modelo (si el proveedor lo rechaza, lo dice; Alisio ni lo recorta ni reintenta). Mientras no esté definido, cada petición usa el máximo de salida que declara el catálogo del modelo activo (`ModelInfo.maxOutputTokens`, leído del listado de modelos del proveedor cuando lo informa; el `/models` de DeepSeek lo hace), con tope de 65536, y 16384 cuando el catálogo no declara nada. El valor se resuelve para el modelo de cada petición, así que `/model`, el cambio de agente o el selector de modelo de la web lo cambian. Alisio muestra el valor efectivo y su origen (*fijado por ti*, *del catálogo del modelo*, *por defecto*) en el aviso de respuesta cortada, en el fallo por truncamiento y en `alisio doctor`. Los subagentes conservan su propio presupuesto (`maxOutputTokensPerChild`, 16384, que se reenvía como valor por ejecución), la compactación conserva `compaction.maxOutputTokens` y las preguntas laterales siguen este ajuste. Cuando un modelo alcanza este presupuesto a mitad de respuesta, Alisio conserva el texto producido, avisa de que la respuesta se cortó (`response cut by max output tokens`), completa la ejecución con normalidad y marca la finalización como `truncated` en `run_completed`. Las llamadas a herramientas totalmente escritas siguen ejecutándose. Aumente este presupuesto para respuestas más largas; los modelos con razonamiento pueden gastar casi todo en razonamiento antes de producir texto, así que no lo fije demasiado bajo (para modelos con mucho razonamiento como DeepSeek, y para ejecuciones que escriben un dashboard entero dentro de una sola llamada a `python_run`, se recomienda 32768 o más; las recuperaciones de `truncationRecoveries` solo mitigan un corte, no lo eliminan). Editable desde `/settings` → Tope de tokens de salida del agente |
| `maxTokens` | proporcional | Presupuesto acumulado opcional de tokens informados por ejecución. Por defecto: 8 × la ventana de contexto del modelo, acotado a 400000–8000000; 1000000 cuando la ventana es desconocida |

## `compaction`

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `auto` | `true` | Compactar automáticamente antes de una llamada al modelo |
| `threshold` | `0.85` | Fracción (0.1–0.99) de una ventana de contexto conocida que activa la compactación |
| `keepTurns` | `2` | Turnos recientes conservados sin cambios (0–20) |
| `maxOutputTokens` | `16000` | Presupuesto de tokens de salida para la llamada del resumidor. Independiente de `limits.maxOutputTokens` y nunca recurre a él. Si el presupuesto corta el resumen, el checkpoint se conserva como **parcial** (la interfaz lo indica); si no se produjo nada aprovechable, la compactación falla y pide que aumente este valor |

La compactación automática usa **un único presupuesto efectivo**. Cuando la ventana de contexto del
modelo es conocida, se dispara cuando el contexto usado alcanza `threshold` (por defecto `0.85`) de
esa ventana; el presupuesto fijo `limits.maxContextChars` queda entonces solo como límite duro
posterior a la compactación. Cuando la ventana es desconocida — o absurdamente grande (las ventanas
declaradas por encima de `2_000_000` tokens se tratan como desconocidas para que un
`ventana × threshold` gigantesco no oculte la presión real) — se recurre al presupuesto de
caracteres: la estimación de caracteres en bruto (`~caracteres / 4`, unos 4 caracteres por token)
que alcanza `maxContextChars / 4` también compacta (un informe de tokens del proveedor nunca
dispara el respaldo por sí solo). La barra de contexto de la TUI muestra la misma ventana conocida,
o un honesto `?` cuando es desconocida (ver [Interfaz de terminal](/es/tui#layout)); el respaldo de
caracteres anterior es una salvaguarda del motor, nunca un total mostrado. El valor por defecto de
`800000` caracteres (≈ `200000` tokens) es una suposición para ventanas desconocidas — el mismo
presupuesto de ~200k tokens que OpenCode asume para proveedores personalizados — para que los
servidores locales que no informan su ventana obtengan ~200k tokens en lugar de ~40k; una ventana
conocida siempre gana, y `/settings` → Presupuesto de caracteres de contexto permite bajar el
respaldo en cualquier momento.

Consulte [Compactación de contexto](/es/compaction).

## `websearch`

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `provider` | ninguno (SearXNG público) | `"searxng"`, `"duckduckgo-instant"`, `"duckduckgo-html"`, `"tavily"`, `"brave"`, `"serpapi"` o `"native"` — véase [Herramientas y permisos](/es/tools#websearch) |
| `searxngUrl` | una instancia pública | Instancia SearXNG autoalojada u otra pública; los valores que no sean loopback deben usar `https://` |
| `apiKeyEnv` | `<PROVIDER>_API_KEY` | Variable de entorno con la clave para `tavily`/`brave`/`serpapi` |
| `nativeToolType` | `web_search` | Solo para `provider: "native"`: el tipo de herramienta nativa del proveedor enviado al modelo |

La instancia pública de SearXNG por defecto se bloquea a veces como bot para solicitudes
automatizadas. `"duckduckgo-html"` es un respaldo sin clave que puede elegir en `/settings` →
Proveedor de búsqueda web (o configurando `websearch.provider` directamente); autoalojar SearXNG
(`websearch.searxngUrl`) es la opción más fiable.

## `context`

```json
{ "context": { "claudeMdFallback": false, "maxBytes": 32768 } }
```

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `claudeMdFallback` | `false` | Usar `CLAUDE.md` en directorios sin archivo `AGENTS` |
| `maxBytes` | `32768` | Bytes totales de contenido `AGENTS.md` inyectado (1024–1048576); se conservan los archivos más cercanos |

Consulte [Contexto: AGENTS.md y skills](/es/context).

## `builtinPlugins`

Opciones de los plugins integrados, indexadas por ID de plugin. Cada entrada acepta `enabled`; cada
plugin valida el resto de su sección. Las entradas se combinan entre capas de configuración por ID
de plugin — la entrada del proyecto o del archivo explícito gana por ID, de modo que
`{ "memory": { "enabled": false } }` en un proyecto desactiva el plugin de memoria allí mientras
todas las demás entradas globales se conservan. Los plugins integrados son `deepseek`, `opencode`, `opencode-go`,
`openai-compatible`, `memory` y `subagents`; las
opciones de `subagents` se detallan en [Subagentes](/es/subagents#limits). Opciones de `memory`:

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `builtinPlugins.memory.enabled` | `true` | Activa el plugin de memoria |
| `builtinPlugins.memory.dbPath` | `<state home>/memory.sqlite` | Ruta de la base de datos; las rutas relativas se resuelven desde el archivo de configuración |
| `builtinPlugins.memory.injectBudgetTokens` | `1500` | Presupuesto de tokens (100–20000) para el contexto de memoria inyectado |
| `builtinPlugins.memory.recallLimit` | `8` | Memorias recuperadas tras la compactación (0–20) |
| `builtinPlugins.memory.autoSummary` | `true` | Escribe un resumen de sesión con `/clear`, `/exit` o al salir (TUI) |
| `builtinPlugins.memory.defaultScope` | `project` | `project` o `personal` |

Consulte [Memoria persistente](/es/memory).

## `pluginHooks`

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `timeoutMs` | `15000` | Tiempo límite (100–120000 ms) de los hooks de compactación y de inicio de sesión |
| `sessionEndTimeoutMs` | `10000` | Tiempo límite (100–120000 ms) de los hooks de fin de sesión |

## `plugins`

Lista de plugins de confianza: rutas (resueltas respecto al archivo de configuración) o nombres de
paquetes npm. Las entradas `plugins` del proyecto o del archivo explícito SE SUMAN a la lista
global: las entradas globales se conservan primero (sin duplicados exactos) y después siguen las
entradas nuevas de la capa seleccionada. Un array `plugins` vacío en un proyecto nunca vacía los
plugins globales.
Consulte [Escribir plugins](/es/plugins#loading-plugins).

```json
{ "plugins": ["alisio-plugin-foo", "./plugins/local.js"] }
```

Los paquetes instalados con `alisio install` aterrizan en el directorio global de plugins
(`<config home>/plugins`, mediante `npm install --prefix`) y sus nombres npm se añaden
automáticamente al array `plugins` de la configuración GLOBAL — consulte
[Instalar plugins desde npm](/es/plugins#installing-plugins-from-npm). Nunca se escriben entradas de
ruta que apunten al paquete instalado; los nombres npm siguen siendo portables.
`pluginOverrides` de abajo puede desactivar un paquete instalado del proyecto en cada proyecto igual
que cualquier otro plugin externo.

`/plugins` guarda por separado las anulaciones externas del proyecto, indexadas por el ID estable
del plugin:

```json
{ "pluginOverrides": { "acme.hello": { "enabled": false } } }
```

Los cambios de plugins integrados usan el campo existente `builtinPlugins.<id>.enabled`. Ambas
formas se aplican tras reiniciar. No modifican los perfiles globales de proveedores ni el almacén
separado de credenciales.

## `skills`

Raíces adicionales de Agent Skills, resueltas respecto al archivo de configuración.
Las entradas `skills` del proyecto o del archivo explícito SE SUMAN a la lista global con la misma
combinación global-primero y sin duplicados; un array `skills` vacío en un proyecto nunca vacía las
raíces globales.

```json
{ "skills": ["./skills"] }
```

También se buscan las raíces de proyecto (`.agents/skills`, `.alisio/skills`, `.claude/skills`, solo
en proyectos de confianza), las raíces de usuario y las skills de plugins. Consulte
[Contexto: AGENTS.md y skills](/es/context#skills).

`/skills` escribe las decisiones de activación locales del proyecto sin cambiar las raíces:

```json
{ "skillOverrides": { "review": { "enabled": false } } }
```

Las anulaciones se aplican a la skill efectiva del proyecto actual. Las skills propiedad de plugins
están bloqueadas y siguen el ciclo de vida de su plugin.

## `additionalDirectories`

Directorios extra que la política de rutas mediada puede tocar fuera del workspace, tanto para
lecturas como para escrituras (las escrituras siguen necesitando `--allow-write` o su propia
aprobación). Las entradas del proyecto o del archivo explícito SE SUMAN a la lista global con la
misma combinación global-primero y sin duplicados; un array `additionalDirectories` vacío en un
proyecto nunca vacía las raíces globales. Cada entrada se resuelve respecto al archivo de
configuración que la definió y se canoniza al cargar.

```json
{ "additionalDirectories": ["/data/videos", "./shared"] }
```

En una sesión interactiva, una ruta externa no declarada pide aprobación acotada a su directorio
contenedor en lugar de fallar; en ejecuciones headless se deniega con la ruta resuelta y los remedios
exactos (`--add-dir` o esta clave). `--read-only` ignora tanto esta clave como `--add-dir`, así que
una sesión bloqueada nunca gana acceso externo. Véase
[Rutas fuera del workspace](/es/tools#external-directories).

## `agents`

El agente activo y el effort de razonamiento de la sesión principal. Lo escriben `/agents` y
`/effort` (también se puede configurar con el mismo escritor atómico `setConfigValue` que el resto
de ajustes de usuario).

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `active` | `"build"` | Id del agente activo (de la sesión principal): los integrados `build` o `plan`, o el id de una definición principal-capaz del sistema de [subagentes](/es/subagents) (`mode: primary`/`all`). El prompt de sistema del agente se anexa a cada prompt; un agente de solo lectura limita la ejecución a lecturas. Un id que no resuelve cae a `build` |
| `effort` | sin definir | Nivel de effort de razonamiento (`string`) para un modelo que anuncia `effort.supportedLevels`; se valida contra el modelo ACTIVO al usarse. Cuando el nivel guardado no lo soporta el modelo actual, se usa silenciosamente el `defaultLevel` del modelo con un aviso único. Los proveedores que anuncian effort lo reciben como `reasoning_effort` (chat) / `reasoning.effort` (responses); los proveedores sin ese concepto lo ignoran |

```json
{ "agents": { "active": "plan", "effort": "high" } }
```

`/agents` y `/effort` son comandos de la TUI; `alisio run`/`resume` y el modo `--no-tui` aplican el
prompt de sistema del agente activo persistido y su limitación de solo lectura en cada ejecución
(el nivel de effort es una función de la TUI: solo la envía la TUI interactiva, tras validarlo
contra el catálogo del modelo activo).

## `analysis`

[Análisis en Python y artefactos](/es/analysis). El intérprete no tiene clave de configuración: se
descubre automáticamente o se fija con `--python <path>`. `runtime`, `oci.*` y `retention.*` son
**solo globales**: se leen de `<config home>/config.json`, y una capa de proyecto o `--config` que
las defina se ignora con un aviso (`alisio doctor` lista lo ignorado), de modo que un repositorio no
puede elegir el binario que ejecuta los scripts ni acortar la retención de todos los workspaces.

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `enabled` | `true` | `false` no registra `python_run`, `artifact_create`, `artifact_list`, `data_inspect` ni `data_query` |
| `runtime` | `"managed"` | `managed` (tu Python, sin sandbox) u `oci` (un contenedor Docker o Podman; consulta [Runtime de contenedor](/es/analysis#oci)). Solo global |
| `oci.engine` | `"docker"` | `docker` o `podman`. Solo global |
| `oci.image` | sin definir | La imagen, fijada por digest (`nombre@sha256:<64 hex>`); un valor sin digest se rechaza al cargar la configuración. Solo global |
| `oci.memoryMb` | `2048` | Límite de memoria del contenedor (256–65 536) |
| `oci.cpus` | `2` | Límite de CPU del contenedor (0,5–64) |
| `retention.jobsDays` | `30` | Logs y staging de un trabajo, su script cuando ya no queda ningún artefacto listo, y datasets sin uso durante este tiempo (0–3 650; `0` no borra nunca). Solo global |
| `retention.intermediateDays` | `7` | La carpeta de temporales (`work/`) de un trabajo (0–3 650; `0` no borra nunca). Solo global |
| `retention.artifactsDays` | `0` | Los artefactos más antiguos caducan (archivos borrados, tarjeta conservada); `0` los conserva siempre (0–3 650). Solo global |
| `limits.timeoutMs` | `120000` | Tiempo de ejecución por defecto y máximo de una llamada a `python_run` (1 000–900 000) |
| `limits.maxFiles` | `200` | Archivos que puede publicar una ejecución |
| `limits.maxFileBytes` | `104857600` | Archivo publicado más grande (100 MiB) |
| `limits.maxOutputBytes` | `524288000` | Bytes totales que puede publicar una ejecución (500 MiB) |
| `limits.maxLogBytes` | `10485760` | Tamaño máximo de cada log del trabajo (`stdout.log`, `stderr.log`) |
| `data.maxUploadBytes` | `209715200` | Archivo de datos más grande que se ingiere, subido o del workspace (200 MiB) |
| `data.maxRows` | `5000000` | Filas por hoja; un archivo mayor detiene la ingesta y no deja dataset |
| `data.queryTimeoutMs` | `5000` | Tiempo máximo de una sentencia de `data_query` (100–60 000); al superarlo se mata el proceso del motor |
| `data.maxInteractiveRows` | `1000000` | Por encima, el visor de tablas web desactiva el orden y el filtro |

```json
{ "analysis": { "limits": { "timeoutMs": 300000 }, "retention": { "artifactsDays": 90 } } }
```

`analysis.enabled`, `analysis.limits.timeoutMs` y las tres claves `analysis.retention.*` también se
pueden editar en **Ajustes → Análisis de datos** de [`alisio serve`](/es/web) y con `/settings` en
la [TUI](/es/tui); se escriben en el archivo global con el mismo escritor validado que el resto de
ajustes (una clave de tres niveles, como `analysis.retention.jobsDays`, conserva sus hermanas). El
tiempo máximo y la retención se aplican desde la siguiente llamada o barrido; `analysis.enabled` se
aplica al reiniciar Alisio (la web recarga las herramientas del workspace cuando terminan sus
ejecuciones). `runtime` y `oci.*` no se editan desde la interfaz: edita el archivo.

## `tasks` {#tasks}

[Tareas en segundo plano](/es/tools#background-tasks): las herramientas `bg_run`, `bg_list`,
`bg_output` y `bg_stop`. `retentionDays` es **solo global**: se lee de `<config home>/config.json` y una
capa de proyecto o `--config` que lo defina se ignora con un aviso (`alisio doctor` lista lo ignorado),
porque una sola barrida borra los datos de todos los workspaces.

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `enabled` | `true` | `false` no registra ninguna de las cuatro herramientas. Se aplica la próxima vez que arranque Alisio |
| `maxPerSession` | `4` | Tareas vivas (en cola, en ejecución o deteniéndose) por sesión raíz (1–32). También hay un límite fijo de 16 por proceso de Alisio |
| `maxRunMs` | `3600000` | Watchdog: una tarea que sigue corriendo pasado este tiempo (y el tope del `timeoutMs` de `bg_run`) se detiene y termina `failed` con el código `timeout` (1 000–86 400 000) |
| `maxOutputBytes` | `2097152` | Tamaño del log de una tarea: se conservan los primeros bytes, una línea de aviso, y los últimos 32 KiB se añaden cuando la tarea termina (65 536–104 857 600) |
| `retentionDays` | `7` | Las tareas terminadas y sus logs se borran pasados estos días; `0` las conserva. Se barre como mucho una vez al día en segundo plano (0–3 650). Solo global |

```json
{ "tasks": { "maxPerSession": 2, "maxRunMs": 600000 } }
```

Las cinco claves se pueden ajustar desde **Ajustes → General** en [`alisio serve`](/es/web) (con
etiquetas en inglés y español) y las principales desde `/settings` en la [TUI](/es/tui), con el mismo
escritor validado que los demás ajustes. `maxPerSession`, `maxRunMs` y `maxOutputBytes` se aplican a la
siguiente tarea y `retentionDays` a la siguiente barrida; `enabled` se aplica al reiniciar Alisio (la
web recarga las herramientas del workspace cuando no tiene ejecuciones ni tareas). Las tareas no están
aisladas y terminan cuando Alisio termina.

## `goal` {#goal}

[Objetivos de sesión](/es/tui#goals) (`/goal`): el agente sigue trabajando en un objetivo con límites
duros. A propósito **no** hay un ajuste de presupuesto de tokens: un objetivo no lo tiene salvo que se
lo des con `/goal <objetivo> budget=50k`. **Sin presupuesto de tokens, solo los límites de turnos y de
tiempo de abajo detienen un objetivo**, así que fija uno cuando el objetivo pueda ser largo o caro.

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `enabled` | `true` | `false` rechaza objetivos nuevos y deja de continuar el actual (las herramientas siguen registradas; solo se ofrecen a una sesión con un objetivo activo) |
| `maxTurns` | `50` | Un objetivo se pausa (`max_turns`) tras esta cantidad de turnos; un turno es una ejecución: el arranque, una continuación o un mensaje tuyo mientras el objetivo está activo (1–1 000) |
| `maxMinutes` | `120` | Un objetivo se pausa (`max_wall`) tras este tiempo gastado **dentro de ejecuciones**; el tiempo de espera por ti o por tareas en segundo plano no cuenta (1–1 440) |
| `repeatedReplyLimit` | `3` | Pausa (`no_progress`) tras esta cantidad de repeticiones consecutivas de la misma respuesta final; la primera se registra y la segunda añade un aviso a la siguiente continuación (2–20) |
| `noToolTurnsLimit` | `3` | Pausa (`no_progress`) tras esta cantidad de turnos consecutivos en los que el agente no llamó a ninguna herramienta, con los mismos pasos de registro y aviso (2–20) |
| `blockedRepeats` | `2` | Turnos consecutivos en los que el agente debe informar del mismo bloqueo, con evidencia, antes de que el objetivo se detenga como bloqueado (1–10); una denegación de permiso bloquea de inmediato |

```json
{ "goal": { "maxTurns": 30, "maxMinutes": 60 } }
```

Las seis claves se pueden cambiar desde **Ajustes → General** en [`alisio serve`](/es/web) (etiquetas en
inglés y español) y desde `/settings` en la [TUI](/es/tui), con el mismo escritor validado que el resto
de ajustes. Se leen en caliente: la siguiente continuación (o el siguiente `/goal`) usa el valor
nuevo, pero los topes de turnos y de tiempo de un objetivo que ya existe se fijaron al crearlo.

## `plan` {#plan}

[Diagramas del plan](/es/tools#exit-plan): el agente de plan puede añadir pequeños diagramas Mermaid a
un plan, que el [visor del plan en la web](/es/plan#plan-viewer) dibuja y la [terminal](/es/plan#terminal)
muestra como código fuente. Véanse los [ajustes del plan](/es/plan#settings) para saber dónde cambiarlos.

| Campo | Valor por defecto | Descripción |
| --- | --- | --- |
| `diagrams` | `true` | `false` quita el argumento `diagrams` de `exit_plan` y la guía de estilo de diagramas de las instrucciones del agente de plan; una llamada que aun así envíe diagramas recibe una nota y no se publican |
| `maxDiagrams` | `5` | Máximo de diagramas que conserva un plan (0–8); el resto se descarta y el resultado de la herramienta lo dice. `0` equivale a `diagrams: false` |

El tamaño de un diagrama (8 KB) y su número estimado de nodos (40) son límites fijos, no ajustes.

```json
{ "plan": { "maxDiagrams": 3 } }
```

Las dos claves se pueden cambiar desde **Ajustes → General** en [`alisio serve`](/es/web) (etiquetas en
inglés y español) y desde `/settings` en la [TUI](/es/tui), y se leen en caliente: la siguiente
petición del plan ofrece (u oculta) los diagramas y usa el nuevo máximo.

## Cambios hechos desde la interfaz web

Las páginas de **Ajustes** de [`alisio serve`](/es/web) escriben en los mismos archivos que la
terminal:

| Cambio | Dónde se escribe |
| --- | --- |
| Ajustes del agente (página General) | `<config home>/config.json`, con el mismo escritor validado que `/settings`; solo se aceptan las claves configurables |
| Perfiles de proveedor (página Modelos) | `<config home>/providers.json` (solo valores no secretos, `0600`) |
| Credenciales (página Modelos) | `<config home>/credentials.json` (`0600`, escrituras atómicas); la web puede guardarlas o borrarlas pero nunca las vuelve a leer |
| Interruptores de plugins y skills | El `.alisio/config.json` del proyecto (solo workspaces de confianza) |
| Interruptores de servidores MCP | La capa de configuración que define el servidor |
| Consentimiento MCP con **Recordar para este usuario** | `mcp.allow` en `<config home>/config.json` |

**Abrir archivo de configuración** en Ajustes muestra estas rutas con botones de copiar; el servidor
no abre editores. Activar un perfil desde la web también lo convierte en el perfil predeterminado
(`active` en `providers.json`), igual que `/connect` en la terminal.

## Plantillas de prompts

No hay una clave de configuración para las plantillas. Se leen de `<config home>/prompts/` y, en
proyectos de confianza, de `.alisio/prompts/`. Consulte [Plantillas de prompts](/es/prompt-templates).

## Servidores MCP

Alisio siempre lee `<ALISIO_CONFIG_HOME>/config.json` (por defecto
`~/.config/alisio/config.json`). La configuración de un proyecto de confianza se superpone desde
`<workspace>/.alisio/config.json`. Un `--config <archivo>` explícito y de confianza se superpone a la
configuración global y reemplaza la capa del proyecto. Un archivo de proyecto sin confianza nunca se
lee. Los ajustes superiores de la capa seleccionada reemplazan los globales, con excepciones
aditivas: los servidores MCP se combinan por nombre, y las claves `plugins`, `skills`,
`additionalDirectories`, `pluginOverrides`, `skillOverrides` y `builtinPlugins` SE SUMAN a la capa
global en lugar de reemplazarla. Las listas aditivas conservan las entradas globales primero (sin
duplicados exactos) y añaden después las entradas nuevas de la capa seleccionada, de modo que un array
vacío en una capa inferior nunca vacía la colección global. Los registros aditivos se combinan por
clave y gana la capa seleccionada por clave. Las rutas relativas se resuelven respecto al archivo que
las definió.

La forma canónica es `mcp.servers`, indexada por nombre. `transport` puede ser explícito o inferirse
de `command`/`url`.

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `transport` | inferido | `stdio` o `http` (Streamable HTTP) |
| `enabled` | `true` | Estado configurado persistido que gestiona `/mcps`; no concede permiso de ejecución ni significa conectado |
| `command` | ninguno | stdio: ejecutable |
| `args` | `[]` | stdio: argumentos; `./` y `../` se resuelven respecto al archivo de configuración |
| `url` | ninguno | http: URL del servidor |
| `envAllow` | `[]` | Variables de entorno que se pasan al servidor stdio |
| `env` | `{}` | Valores literales que se pasan solo a este subproceso; prevalecen sobre el mismo nombre de `envAllow` |
| `bearerTokenEnv` | ninguno | Variable de entorno que contiene un token bearer HTTP |

```json
{
  "mcp": {
    "servers": {
      "my-server": {
        "transport": "stdio",
        "command": "node",
        "args": ["./mcp/server.js"],
        "envAllow": ["MY_SERVER_TOKEN"]
      },
      "local-no-secreto": {
        "command": "./bin/local-mcp",
        "env": { "LOG_LEVEL": "info" }
      },
      "remoto-publico": {
        "url": "https://example.com/public-mcp"
      },
      "remote": {
        "transport": "http",
        "url": "https://example.com/mcp",
        "bearerTokenEnv": "MY_MCP_TOKEN"
      }
    }
  }
}
```

También se acepta la forma común superior `mcpServers`. Infiere `stdio` si existe `command` y `http`
si existe `url`:

```json
{
  "mcpServers": {
    "devforge": {
      "command": "/ruta/a/devforge-mcp",
      "args": [],
      "env": { "DEV_FORGE_CONFIG": "/ruta/a/devforge/config.json" }
    }
  }
}
```

No defina el mismo nombre en `mcp.servers` y `mcpServers` dentro de un archivo. Se validan de forma
estricta nombres, transportes, URL, comandos, argumentos y valores de entorno. Los diagnósticos nunca
muestran esos valores. Los valores directos de `env` se pasan solo a ese subproceso y prevalecen
sobre una variable del mismo nombre reenviada con `envAllow`; úselos para opciones no secretas o
rutas locales protegidas. Los secretos HTTP no pueden escribirse literalmente:
`bearerTokenEnv` nombra la variable de entorno que contiene el token. Un servidor configurado
permanece desconectado hasta que se solicita. La TUI interactiva puede conceder acceso MCP de
proceso/red para la sesión actual de la aplicación tras una confirmación clara; ese permiso no se
guarda en la configuración. Los modos no TUI y los consumidores programáticos aún requieren
`--allow-mcp` o `allowMcp`; `--read-only` siempre prohíbe MCP. Un servidor stdio es un
subproceso con sus privilegios de usuario, **no un sandbox**. Confíe únicamente en la configuración y
el ejecutable que use. Consulte [Herramientas y permisos](/es/tools#mcp).

### Consentimiento global (`mcp.allow`)

Defina `"mcp": { "allow": true }` en **su configuración de usuario**
(`<config home>/config.json`, por defecto `~/.config/alisio/config.json`) para conceder
consentimiento de proceso/red MCP **entre sesiones para este usuario**: cada inicio de Alisio (TUI
interactiva y headless) comienza con el permiso de ejecución MCP ya concedido, la cabecera muestra
`mcp:on`, y cada servidor marcado como `enabled` se conecta automáticamente, igual que pulsar
**Conectar** en cada uno. Esto evita la pregunta por sesión en cada reinicio.

```json
{
  "mcp": {
    "allow": true,
    "servers": {
      "devforge": { "command": "/ruta/a/devforge-mcp" }
    }
  }
}
```

- `mcp.allow` se **lee solo de la capa global/de usuario**; un valor en `.alisio/config.json` de un
  proyecto se ignora deliberadamente, para que un proyecto no pueda concederse consentimiento de red.
- Ausente o `false` mantiene el comportamiento actual: el permiso no está concedido al iniciar, la TUI
  puede concederlo por sesión, y los usos headless/programáticos siguen exigiendo `--allow-mcp`
  (que continúa funcionando como concesión explícita por ejecución, equivalente a `mcp.allow: true`
  en esa ejecución).
- `--read-only` siempre bloquea MCP por completo, independientemente de `mcp.allow`; ni siquiera se
  ofrece.
- Concederlo persiste entre sesiones y auto-conecta los servidores activados. Los servidores MCP
  se ejecutan sin sandbox con sus privilegios de usuario: active el consentimiento global solo si
  confía en cada servidor que configure.
- El gestor `/mcps` de la TUI puede definirlo (Conceder y recordar) y revocarlo; consulte
  [Interfaz de terminal](/es/tui#mcp). En la interfaz web, **Ajustes → Servidores MCP → Conceder
  acceso MCP** pide una confirmación explícita y puede recordar la concesión del mismo modo; consulte
  [Interfaz web](/es/web).

## Variables de entorno

| Variable | Función |
| --- | --- |
| `OPENAI_API_KEY` (o el nombre indicado en `provider.apiKeyEnv`) | Clave de API |
| `OPENAI_BASE_URL` | Reemplaza `provider.baseURL` |
| `ALISIO_MODEL` | Reemplaza `provider.model` |
| `ALISIO_API_MODE` | Reemplaza `provider.apiMode` |
| `ALISIO_CONFIG_HOME` | Directorio de configuración global (por defecto `$XDG_CONFIG_HOME/alisio` o `~/.config/alisio`) |
| `ALISIO_STATE_HOME` | Directorio de estado para `sessions.sqlite`, `memory.sqlite` y `trust.json` (por defecto `$XDG_STATE_HOME/alisio` o `~/.local/state/alisio`) |
| `ALISIO_LOG_LEVEL` | Nivel de las líneas de log JSON de `alisio serve` en stderr: `debug`, `info` (por defecto), `warn`, `error`, `silent` |
| `XDG_CONFIG_HOME`, `XDG_STATE_HOME` | Directorios base XDG estándar, usados cuando las variables `ALISIO_*` no están definidas |
| `CI` | Si está definida (y no vale `false` ni `0`), no se muestra la pantalla de inicio |
| `NO_COLOR` | Desactiva el color en la pantalla de inicio |
| `TERM=dumb` | Pantalla de inicio en ASCII sin color |
| `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH` | Definidas por Herdr; activan los reportes de ciclo de vida |

La base de datos de sesiones contiene conversaciones y resultados de herramientas: no la suba al
repositorio.

## Flags de la CLI

Flags globales (válidos para todos los comandos):

| Flag | Descripción |
| --- | --- |
| `--cwd <path>` | Directorio de trabajo |
| `--config <path>` | Archivo de configuración de confianza explícita |
| `--trust-project` | Carga la configuración y los plugins ejecutables del proyecto (todos los privilegios del proceso) |
| `--plugin <path...>` | Carga plugins de confianza explícita (rutas o nombres de paquete) |
| `--model <id>` | ID del modelo del proveedor |
| `--base-url <url>` | URL base de la API compatible con OpenAI, incluyendo `/v1` si hace falta |
| `--api-mode <mode>` | `chat` o `responses` |
| `--allow-write` | Permite escribir archivos |
| `--allow-process` | Permite subprocesos arbitrarios; sin sandbox |
| `--allow-analysis` | Permite el análisis en Python (`python_run`) sin preguntar; sin sandbox, nunca permite `shell` |
| `--python <path>` | Intérprete Python 3.10+ para `python_run` (por defecto: se descubre) |
| `--allow-external` | Permite herramientas de red: `webfetch`, `websearch` y la búsqueda nativa del proveedor |
| `--allow-mcp` | Permite los servidores MCP configurados y las llamadas a herramientas remotas |
| `--allow-agents` | Permite enviar mensajes a agentes vecinos mediante Herdr |
| `--add-dir <paths...>` | Directorios adicionales que las herramientas pueden tocar fuera del workspace (repetible, solo esta ejecución) |
| `--no-herdr` | Desactiva los reportes automáticos de ciclo de vida a Herdr |
| `--read-only` | Desactiva escrituras, procesos arbitrarios, herramientas de red, plugins ejecutables, MCP y toda ruta externa |
| `--db <path>` | Base de datos de sesiones |
| `--json` | Emite eventos JSONL versionados |
| `--no-tui` | Usa el modo interactivo readline sencillo en lugar de la TUI |
| `--disable-plugin <ids...>` | Desactiva plugins integrados (`memory`, `subagents`) |
| `--agents <json>` | Definiciones adicionales de subagentes en JSON: `{"name":{"description":"...","prompt":"..."}}` |
| `--no-banner` | No muestra la pantalla de inicio |
| `--quiet` | Suprime la salida no esencial (pantalla de inicio, sugerencias) |
| `-V`, `--version` | Muestra la versión |
| `-h`, `--help` | Muestra la ayuda |

Comandos:

| Comando | Descripción |
| --- | --- |
| `alisio` | TUI interactiva (o readline con `--no-tui`) |
| `alisio run <prompt>` | Ejecución headless; `/name args` ejecuta una [plantilla de prompt](/es/prompt-templates) |
| `alisio resume <session> [prompt]` | Reanuda una sesión (TUI sin prompt, headless con prompt) |
| `alisio setup` | Escribe un `.alisio/config.json` de ejemplo sin secretos (para `AGENTS.md`, use `/init`) |
| `alisio doctor` | Diagnóstico del entorno y del proveedor; avisa cuando no hay modelo configurado; muestra el Python de `python_run` (o cómo instalarlo) |
| `alisio analysis status` | Modo, el intérprete Python descubierto, los extras instalados, el motor e imagen de contenedor, límites y retención, y la guía de instalación si falta Python |
| `alisio analysis setup --extras analysis\|science` | Opcional: instala extras con hashes fijados (pandas…) en un entorno virtual privado; necesita red y falla limpiamente sin ella |
| `alisio analysis setup --oci [--image <nombre>]` | Opcional: descarga una vez la imagen de contenedor y verifica su digest (Docker o Podman) |
| `alisio analysis sweep [--force]` | Ejecuta ahora el barrido de retención (también se ejecuta solo, como máximo una vez al día) |
| `alisio trust list` | Lista los directorios con una decisión de confianza guardada |
| `alisio trust revoke <path>` | Olvida la decisión de confianza de un directorio (vuelve a preguntar la próxima vez) |
| `alisio sessions list` | Lista las sesiones |
| `alisio sessions recover <session> --acknowledge` | Reconoce efectos inciertos de herramientas tras una caída |
| `alisio context explain <path>` | Muestra qué archivos `AGENTS.md` se aplican a una ruta |
| `alisio skills list [path]` | Lista las skills descubiertas |
| `alisio skills validate [path]` | Valida skills (código de salida distinto de cero si hay diagnósticos) |
| `alisio plugins list` | Lista los plugins globales, de proyecto y explícitos |
| `alisio plugins doctor` | Carga los plugins y muestra sus herramientas y comandos |
| `alisio mcp list` | Lista los servidores MCP configurados |
| `alisio mcp doctor <server>` | Se conecta a un servidor (requiere `--allow-mcp`) |
| `alisio serve` | Arranca el [servidor de la interfaz web](/es/web) local |

Flags de `alisio serve` (los flags globales de permisos son el techo de toda sesión web):

| Flag | Descripción |
| --- | --- |
| `--port <port>` | Puerto de escucha (por defecto `4317`; `0` elige uno libre) |
| `--host <address>` | Dirección de enlace (por defecto `127.0.0.1`); si no es loopback exige `--allow-remote` |
| `--allow-remote` | Permite un `--host` que no sea loopback (sin TLS; mejor un túnel SSH) |
| `--no-open` | No abre el navegador |
| `--max-workspaces <n>` | Workspaces con una aplicación abierta a la vez (por defecto `4`) |
| `--max-runs <n>` | Ejecuciones simultáneas entre todas las sesiones (por defecto `4`) |

## `AGENTS.md`

Los archivos de instrucciones (`AGENTS.override.md`, `AGENTS.md`, el heredado `AGENT.md` y,
opcionalmente, `CLAUDE.md`) se describen en [Contexto: AGENTS.md y skills](/es/context#agents-md).
