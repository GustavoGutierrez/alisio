# Especificación Técnica: Semantic Ports — contrato de embeddings y almacén vectorial en `@alisio/sdk` con servicio en el host

| Campo | Valor |
|---|---|
| Versión | 0.1 |
| Origen | Análisis de arquitectura del 2026-11-10 (núcleo frente a plugin) con referencias externas: Continue.dev (rol de modelo `embed` en la configuración del núcleo), Obsidian Smart Connections (`smart-embed-model` y `smart-env` como infraestructura compartida entre plugins) y el coste medido de `onnxruntime-node` (~210 MB con binarios de todas las plataformas, issues plur-ai #1193 y #1194) **(no verificado: fuentes externas)** |
| Proyecto | Alisio |
| Estado | **Aprobada por el propietario (2026-11-10).** Fases 1-2 implementadas, sin commit ni publicar; ver `apps/website/implementation-status.md`. Sin preguntas abiertas (Q1 cerrada por O3) |
| Fecha | 2026-11-10 |
| Paquetes afectados | `@alisio/sdk` (tipos aditivos opcionales: `EmbeddingProvider`, `VectorStoreProvider`, `SemanticApi`, `ToolSemantic`, `SemanticError`, `SemanticErrorCode`, `PluginAPI.semantic?`, `ToolContext.semantic?`) · `@alisio/core` (nuevo `packages/core/src/semantic/{registry,service,validate,namespace,index}.ts`; cambios en `config.ts`, `plugins/host.ts`, `application.ts`, `commands/builtins.ts`) · **repositorio externo `alisio-plugins`**: `packages/plugin-semantic` (Anexo A, entregable separado, NO se ejecuta en este repo; spec completa en `alisio-plugins/specs/alisio-plugin-semantic-v1.md`) |
| Paquetes nuevos | Ninguno en este repo. **Ninguna dependencia nueva de producción en el host**: LanceDB, `onnxruntime-node`, `@huggingface/transformers` y los modelos viven solo en el plugin externo (D2) |
| Relación con otras especificaciones | Sigue el patrón de puertos y registro de `specs/archive/006-decision-intelligence-v1.md` (registrar no activa; la configuración elige). Futuro consumidor: `specs/research/023-knowledge-vault-research.md` (esa investigación proponía libSQL con vectores propios; con esta spec un vault usaría `api.semantic` en lugar de un almacén privado). Independiente de `specs/015-project-memory-v1.md` (que MAY adoptar `api.semantic` más adelante) y de `specs/backlog/021-workspace-sources-v1.md` |
| Superficies | Plugins (consumidores y proveedores vía `PluginAPI`), herramientas (`ToolContext.semantic`), TUI y Web (comando `/semantic` de estado), headless (mismo servicio, sin preguntas interactivas). Sin rutas HTTP nuevas en `alisio serve` |
| Política de versión | Cambio aditivo y opcional del contrato de `@alisio/sdk`: **parche dentro de 0.11.x** para los 7 paquetes (línea 0.11.x del propietario; los plugins no necesitan subir su peer). `RunEvent.schemaVersion`, `apiVersion` de plugins y `protocolVersion` no cambian |

## 0. Cómo usar este documento (para agentes de código)

1. Lee primero `AGENTS.md` y `CONTRIBUTING.md`; prevalecen sobre este documento. Carga `alisio-architecture`, `alisio-coding-standards`, `alisio-specs`, `alisio-pkg-sdk`, `alisio-pkg-core` y `alisio-plugins`; `alisio-pkg-cli-tui` y `alisio-pkg-web` solo para el comando `/semantic`; `alisio-publish` para la entrega.
2. Etiquetas: **(verificado 2026-11-10)** = leído en el repositorio (rama `develop`, commit `cf49cde`, árbol limpio); **(no verificado)** = deducido o externo; **(nuevo)** = no existe.
3. Palabras clave **MUST, MUST NOT, SHOULD, SHOULD NOT, MAY** según RFC 2119 (aclarado por RFC 8174), solo donde importan para interoperabilidad, seguridad o pruebas; todo SHOULD indica su excepción. Comportamiento en forma EARS (`WHEN <disparador>, el <sistema> MUST <respuesta>`).
4. **TDD estricto Rojo → Verde → Refactor** (§7). Pruebas en `tests/*.test.ts` de cada paquete, sobre comportamiento en límites de módulo; sin instantáneas.
5. **Orden obligatorio**: Fases 1 → 2 en este repo (§9). El Anexo A se ejecuta en el repo `alisio-plugins` con sus propias reglas y **no forma parte de la definición de terminado de esta spec**. Cada fase deja el repo verde con `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:cli`, `pnpm test:compiled`, `pnpm pack:check`, `pnpm website:check` y `pnpm website:build`. **No hagas commit hasta que el propietario lo pida.**
6. **Asignación de modelos**: §8.
7. Reglas que no se rompen: solo pnpm; Node >=22.16 y Bun; solo APIs portables de Node; **ningún binario nativo, runtime de inferencia, base vectorial ni modelo en `@alisio/sdk`, `@alisio/core`, `@alisio/server`, `@alisio/web` ni `@alisio/alisio-code`** (D2); los plugins dependen solo de `@alisio/sdk`; un manifiesto o un subproceso no es un sandbox.
8. Idioma: identificadores, claves de configuración y códigos de error en inglés; textos de UI en EN y ES; esta spec en español; documentación EN/ES en paridad.

---

## 1. Objetivo, alcance y principio rector

### 1.1 Objetivo

Dar a Alisio una **capacidad semántica compartida** (embeddings + almacén vectorial + búsqueda por similitud) definida como **puertos en `@alisio/sdk`** y **orquestada por el host**, de modo que:

- **Proveedores** (plugins) implementen el motor: el primero será `plugin-semantic` (LanceDB + ONNX + `multilingual-e5-small` intercambiable, Anexo A).
- **Consumidores** (plugins y herramientas) usen búsqueda semántica sin conocer el motor: RAG, recuerdo de memoria, búsqueda de archivos, deduplicación, clasificación.
- Sin el plugin proveedor instalado, Alisio se instala y funciona igual que hoy, con el mismo tamaño.

### 1.2 Principio rector

> **El contrato es común; el motor es opcional.** El host define y media la capacidad semántica (validación, espacios de nombres, compatibilidad de modelo, tiempos límite, degradación), pero nunca incluye el motor pesado.

### 1.3 Alcance

- Tipos aditivos en `@alisio/sdk` (§5).
- Registro, servicio, validación y espacios de nombres en `packages/core/src/semantic/` (§4, §5).
- Clave de configuración global `semantic` (§6).
- Comando `/semantic` de estado (solo lectura).
- Doble de prueba en memoria (solo en `tests/`) que implementa ambos puertos.
- Documentación EN/ES y `apps/website/implementation-status.md`.

### 1.4 Fuera de alcance

| Excluido | Motivo |
|---|---|
| LanceDB, `onnxruntime-node`, transformers.js o cualquier modelo dentro del host | Peso (~210 MB solo de ONNX sin podar) y binarios nativos por plataforma; rompe la instalación de un clic y complica el binario de Bun (D2). Va en el Anexo A |
| Implementar `plugin-semantic` en este repo | Decisión del propietario O1: se hace en `alisio-plugins` |
| Un almacén vectorial de referencia en producción (por ejemplo, fuerza bruta sobre SQLite) | Dos motores que mantener; el doble en memoria vive solo en `tests/` |
| Herramienta de modelo `semantic_search` en el núcleo | Cada consumidor decide sus herramientas; el núcleo no impone un RAG |
| Fragmentación (chunking), extracción de texto, reranking, búsqueda híbrida con FTS5 | Responsabilidad del consumidor; MAY estandarizarse en una versión posterior |
| Rutas HTTP nuevas o panel Web de gestión de colecciones | Sin consumidor que lo requiera hoy |
| Reindexación automática al cambiar de modelo | El host detecta la incompatibilidad (D5); reindexar requiere el texto fuente, que solo el consumidor posee |
| Aislamiento de seguridad entre plugins | Los espacios de nombres evitan colisiones accidentales, no ataques: todos los plugins son código de confianza (`specs/014-trust-boundaries-v1.md`) |

---

## 2. Decisiones

### 2.1 Decisiones del propietario (confirmadas, se aplican tal cual)

| ID | Decisión |
|---|---|
| O1 | (2026-11-10) Arquitectura híbrida: contrato y servicio en el SDK/núcleo; motor (LanceDB + embeddings ONNX) en un plugin separado del monorepo `alisio-plugins`. La parte del plugin queda separada de esta spec (Anexo A) |
| O2 | (2026-11-10) Motor elegido para el primer proveedor: LanceDB como almacén y `multilingual-e5-small` como modelo por defecto, intercambiable, probablemente vía ONNX |
| O3 | (2026-11-10) Cierra Q1: `@alisio/plugin-openai-compatible` **no** registra un proveedor de embeddings; ese plugin está pensado para conectar modelos de chat locales y no cambia en esta spec |

### 2.2 Decisiones de diseño (vinculantes)

| ID | Contexto | Decisión | Consecuencia |
|---|---|---|---|
| D1 | Embeddings y almacén cambian por razones distintas (modelo local frente a remoto; LanceDB frente a otro motor) | **Dos puertos independientes**: `EmbeddingProvider` y `VectorStoreProvider`, registrados por separado, compuestos por el host en `SemanticApi` | Se puede combinar embeddings remotos con LanceDB local, o probar otro almacén sin tocar el modelo. Un mismo plugin MAY registrar ambos |
| D2 | El host debe seguir siendo liviano y portable | El host MUST NOT añadir dependencias nativas, runtimes de inferencia ni modelos. `pack:check` MUST fallar si `@lancedb/*`, `onnxruntime-*` o `@huggingface/transformers` aparecen en `dependencies` de un paquete publicado del host | La capacidad semántica existe solo cuando el usuario instala un proveedor |
| D3 | Patrón probado en Decision Intelligence (`specs/archive/006-decision-intelligence-v1.md`) | Registrar no activa: `semantic.embedding` y `semantic.store` en la configuración global eligen el proveedor activo. Un repositorio MUST NOT poder elegirlos | Instalar un plugin nunca cambia el comportamiento sin consentimiento; MAY ofrecerse `activate()` mediado por el host como en `DecisionsApi.activate` |
| D4 | Varios consumidores comparten un almacén | El host antepone el id del plugin consumidor al nombre de la colección (`<pluginId>/<collection>`) antes de llamar al almacén. Un consumidor MUST NOT poder nombrar una colección de otro plugin | Evita colisiones accidentales. No es aislamiento de seguridad (§1.4) |
| D5 | Vectores de modelos distintos no son comparables | Cada colección guarda `modelId` y `dimensions` al crearse. WHEN un consumidor escribe o busca en una colección con un `modelId` o `dimensions` distinto del proveedor activo, el host MUST rechazar la operación con `model_mismatch` o `dimension_mismatch` sin llamar al almacén | Cambiar de modelo exige que el consumidor reindexe (`dropCollection` + reinsertar); nunca hay resultados silenciosamente basura |
| D6 | Modelos como e5 requieren prefijos distintos para consultas y pasajes | `embed()` recibe `kind: "query" \| "document"`; el proveedor aplica los prefijos propios de su modelo. Los consumidores MUST NOT añadir prefijos de modelo | Cambiar de modelo no rompe a los consumidores |
| D7 | Los consumidores deben degradarse sin el motor | `available()` indica si hay proveedores activos y registrados. Las operaciones fallan con `SemanticError` tipado (código `unavailable`), nunca con errores del motor sin envolver. `trySearch()` resuelve `null` ante problemas de infraestructura (como `tryDecide`) | Un consumidor de RAG MAY recurrir a FTS5 (`api.storage.sqlite`) cuando `available()` es falso |
| D8 | Proteger al host de un proveedor lento o roto | Toda llamada a un proveedor lleva un `AbortSignal` y un tiempo límite del host (§6). Los errores del proveedor se envuelven como `provider_error` con un mensaje sin rutas ni contenido del usuario | Un fallo del motor nunca tumba el run ni filtra datos en los logs |
| D9 | Límites medibles evitan abusos accidentales | Límites del host (validados antes de llamar al proveedor): 1..256 textos por `embed`, ≤ 32 768 caracteres por texto, `dimensions` 1..4096, `topK` 1..100, ≤ 1000 registros por `upsert`, `id` de registro `^[A-Za-z0-9._:-]{1,128}$`, colección `^[a-z0-9][a-z0-9_-]{0,63}$`, `metadata` JSON ≤ 8 KiB por registro. Fuera de límites → `invalid_request` | Contrato predecible para cualquier proveedor |
| D10 | Filtros portables entre motores | `filter` es un objeto de igualdad sobre claves de `metadata` de primer nivel (`{ key: string \| number \| boolean }`, Y lógico, ≤ 16 claves). Nada de SQL ni expresiones del motor | Cualquier almacén puede implementarlo; filtros más ricos quedan para una versión posterior |
| D11 | El texto fuente pertenece al consumidor | El registro MAY incluir `text` (≤ 32 768 caracteres) que el almacén devuelve en los resultados; el host no lo interpreta ni lo registra en logs | Un RAG puede citar fragmentos sin una segunda base de datos |

### 2.3 Decisiones posteriores

Ninguna aún.

### 2.4 Preguntas abiertas

Ninguna. Q1 (embeddings remotos en `plugin-openai-compatible`) quedó cerrada con «no» por O3.

---

## 3. Estado actual del código (verificado 2026-11-10)

| Área | Realidad |
|---|---|
| Almacenamiento para plugins | `PluginAPI.storage.sqlite(path): SqlDatabase` (`packages/sdk/src/index.ts`), síncrono, FTS5 disponible, archivo privado 0600. Sin vectores |
| Categorías de plugin | `PluginCategory` ya incluye `"search"` («web or vector search providers») y `"storage"` («durable storage backends beyond the default SQLite state») (`packages/sdk/src/index.ts`). No hay ningún contrato detrás |
| Patrón de proveedor intercambiable | Decision Intelligence: `DecisionsApi` con `registerProvider`, `available`, `activeProvider`, `activate?` y `tryDecide`; `ToolDecisions` es el lado consumidor en `ToolContext.decisions?`. Implementación en `packages/core/src/decisions/` (`registry.ts`, `service.ts`, `activation.ts`, `breaker.ts`, `validate.ts`; ~1250 líneas) y enlace en `packages/core/src/plugins/host.ts` (`setDecisions`) |
| Configuración | `decisions` en `packages/core/src/config.ts` con `provider` validado por `^[a-z0-9][a-z0-9.-]{0,63}$` y documentado como solo global. No existe clave `semantic` |
| Embeddings y vectores | No existe ningún código de embeddings, vectores ni similitud en `packages/` **(verificado 2026-11-10, búsqueda de `embedding`/`vector`)** |
| Proveedor OpenAI compatible | `packages/plugin-openai-compatible/src/{index,provider}.ts` registra solo un proveedor de modelos de chat |
| Directorios por plugin | `PluginAPI.paths?: { state, config, cache }` (0700), útil para que el proveedor guarde la base LanceDB y la caché del modelo |

---

## 4. Arquitectura

```
 consumidores (plugins, herramientas)          proveedores (plugins)
 ┌──────────────┐ ┌──────────────┐        ┌───────────────────────────┐
 │ knowledge    │ │ memory       │        │ plugin-semantic (Anexo A) │
 │ vault (RAG)  │ │ (recuerdo)   │        │  EmbeddingProvider (ONNX) │
 └──────┬───────┘ └──────┬───────┘        │  VectorStoreProvider      │
        │ api.semantic   │ ctx.semantic   │  (LanceDB)                │
        ▼                ▼                └─────────────┬─────────────┘
 ┌────────────────────────────────────────┐             │ registerEmbedding /
 │ @alisio/core  semantic/                │◄────────────┘ registerStore
 │  registry  → catálogo, registrar ≠ activar
 │  validate  → límites D9, filtros D10
 │  namespace → <pluginId>/<collection> (D4)
 │  service   → compone embed + store, D5 modelo, D7 degradación, D8 timeouts
 └────────────────────────────────────────┘
        ▲ config global: semantic.embedding / semantic.store (D3)
```

| Patrón | Dónde | Por qué |
|---|---|---|
| Puertos y adaptadores (hexagonal) | `EmbeddingProvider`, `VectorStoreProvider` en el SDK | El host no conoce LanceDB ni ONNX (D2) |
| Registro + selección por configuración | `semantic/registry.ts` | Igual que Decisions: instalar no activa (D3) |
| Fachada | `SemanticApi` | Los consumidores piden «indexa / busca» y no orquestan embed + store a mano |

Módulos nuevos (todos **(nuevo)**):

- `packages/core/src/semantic/registry.ts`: dos catálogos (embedding, store), `onChange`, ids `^[a-z0-9][a-z0-9.-]{0,63}$` únicos.
- `packages/core/src/semantic/validate.ts`: límites D9, forma de `filter` D10, `SemanticError`.
- `packages/core/src/semantic/namespace.ts`: compone y descompone `<pluginId>/<collection>`.
- `packages/core/src/semantic/service.ts`: `SemanticService` que produce un `SemanticApi` por plugin consumidor.
- `packages/core/src/semantic/index.ts`: reexportaciones.

---

## 5. Contrato (`@alisio/sdk`, aditivo y opcional)

```ts
export type SemanticErrorCode =
  | "unavailable"        // disabled, no active provider, or active id not registered
  | "invalid_request"    // D9/D10 limits or shape
  | "model_mismatch"     // D5
  | "dimension_mismatch" // D5 or provider returned wrong vector length
  | "timeout"            // D8
  | "provider_error";    // provider threw or returned malformed data
export class SemanticError extends Error {
  readonly code: SemanticErrorCode;
}

export type EmbeddingKind = "query" | "document";

/** Port 1: turns text into vectors. Registered by a plugin; activated by `semantic.embedding`. */
export interface EmbeddingProvider {
  id: string;            // ^[a-z0-9][a-z0-9.-]{0,63}$
  name: string;
  /** Stable model identity, e.g. "intfloat/multilingual-e5-small@onnx-q8". Changes ⇒ reindex. */
  modelId(): string;
  dimensions(): number;  // 1..4096
  /** Applies model-specific prefixes for `kind` (D6). Returns one vector per input, same order. */
  embed(
    texts: string[],
    options: { kind: EmbeddingKind; signal: AbortSignal },
  ): Promise<Float32Array[]>;
  /** Only for `/semantic` (own 1 s timeout). "starting" covers model download/first load. */
  health?(signal?: AbortSignal): Promise<{ status: "ready" | "starting" | "unavailable"; detail?: string }>;
}

export interface VectorRecord {
  id: string;
  vector: Float32Array;
  text?: string;                                   // D11
  metadata?: Record<string, string | number | boolean>;
}
export interface VectorMatch {
  id: string;
  score: number;                                   // cosine similarity, higher is closer, in [-1, 1]
  text?: string;
  metadata?: Record<string, string | number | boolean>;
}
export interface CollectionInfo { name: string; modelId: string; dimensions: number; count: number }

/** Port 2: stores and searches vectors. The host passes already-namespaced collection names (D4). */
export interface VectorStoreProvider {
  id: string;
  name: string;
  ensureCollection(name: string, spec: { modelId: string; dimensions: number }, signal: AbortSignal): Promise<CollectionInfo>;
  getCollection(name: string, signal: AbortSignal): Promise<CollectionInfo | null>;
  listCollections(prefix: string, signal: AbortSignal): Promise<CollectionInfo[]>;
  dropCollection(name: string, signal: AbortSignal): Promise<void>;
  upsert(name: string, records: VectorRecord[], signal: AbortSignal): Promise<void>;
  delete(name: string, ids: string[], signal: AbortSignal): Promise<void>;
  query(
    name: string,
    vector: Float32Array,
    options: { topK: number; filter?: Record<string, string | number | boolean>; signal: AbortSignal },
  ): Promise<VectorMatch[]>;
  health?(signal?: AbortSignal): Promise<{ status: "ready" | "starting" | "unavailable"; detail?: string }>;
}

export interface SemanticDocument {
  id: string;
  text: string;
  metadata?: Record<string, string | number | boolean>;
  /** Store the text so `search` returns it (D11). Default true. */
  keepText?: boolean;
}
export interface SemanticSearchOptions {
  topK?: number;                                   // default 8
  filter?: Record<string, string | number | boolean>;
  minScore?: number;                               // results below are dropped
  signal?: AbortSignal;
}

/** Consumer side, bound by the host to the calling plugin (collections are namespaced, D4). */
export interface ToolSemantic {
  available(): boolean;
  active(): { embedding: { id: string; modelId: string; dimensions: number } | null; store: { id: string } | null };
  embed(texts: string[], options: { kind: EmbeddingKind; signal?: AbortSignal }): Promise<Float32Array[]>;
  /** Embeds `kind: "document"` and upserts; creates the collection bound to the active model. */
  index(collection: string, documents: SemanticDocument[], options?: { signal?: AbortSignal }): Promise<void>;
  /** Embeds `kind: "query"` and queries. */
  search(collection: string, query: string, options?: SemanticSearchOptions): Promise<VectorMatch[]>;
  /** Like `search` but resolves null for infrastructure problems (D7); still throws `invalid_request`. */
  trySearch(collection: string, query: string, options?: SemanticSearchOptions): Promise<VectorMatch[] | null>;
  remove(collection: string, ids: string[], options?: { signal?: AbortSignal }): Promise<void>;
  collections(options?: { signal?: AbortSignal }): Promise<CollectionInfo[]>;   // names without the prefix
  drop(collection: string, options?: { signal?: AbortSignal }): Promise<void>;
}

export interface SemanticApi extends ToolSemantic {
  registerEmbedding(provider: EmbeddingProvider): () => void;
  registerStore(provider: VectorStoreProvider): () => void;
  /** Host-mediated, consent-gated, global-only; mirrors `DecisionsApi.activate` (D3). */
  activate?(ids: { embedding?: string; store?: string }, options?: { recommend?: boolean }): Promise<SemanticActivationResult>;
}

// PluginAPI:   semantic?: SemanticApi;      feature-detect `api.semantic?.registerStore(...)`
// ToolContext: semantic?: ToolSemantic;     bound to the plugin that owns the tool
```

`SemanticActivationResult` reutiliza los estados de `DecisionActivationStatus` (`activated`, `already_active`, `other_provider_active`, `declined`, `needs_confirmation`, `disabled`, `unavailable`) con `active?: { embedding?: string; store?: string }`.

### 5.1 Comportamiento (EARS)

- **SE-R1** WHEN un plugin registra un proveedor, el host MUST NOT activarlo; solo `semantic.embedding` / `semantic.store` lo hacen (D3).
- **SE-R2** WHEN un id ya está registrado o no cumple el patrón, el host MUST rechazar el registro con un `TypeError` y conservar el registro previo.
- **SE-R3** WHILE `semantic.enabled` es falso, o falta un proveedor activo y registrado, `available()` MUST devolver `false` y toda operación salvo `trySearch` MUST rechazar con `unavailable`; `trySearch` MUST resolver `null`.
- **SE-R4** WHEN un consumidor llama a cualquier operación con nombre de colección, el host MUST pasar al almacén `<pluginId>/<collection>`, y `collections()` MUST devolver solo las del plugin, sin prefijo (D4).
- **SE-R5** WHEN la colección existe con `modelId` o `dimensions` distintos del proveedor activo, `index` y `search` MUST rechazar con `model_mismatch` / `dimension_mismatch` sin llamar a `embed` ni al almacén (D5).
- **SE-R6** WHEN el proveedor devuelve un número de vectores distinto del de textos, o un vector de longitud distinta de `dimensions()`, o algún valor no finito, el host MUST rechazar con `dimension_mismatch` / `provider_error` y MUST NOT llamar a `upsert`.
- **SE-R7** WHEN una entrada viola D9 o D10, el host MUST rechazar con `invalid_request` antes de llamar a cualquier proveedor.
- **SE-R8** WHEN una llamada al proveedor supera el tiempo límite de §6, el host MUST abortar su `AbortSignal` y rechazar con `timeout`. WHEN el llamador aborta, el host MUST propagar el aborto (no se convierte en `timeout`).
- **SE-R9** WHEN un proveedor lanza un error, el host MUST envolverlo en `provider_error` con un mensaje sin rutas absolutas ni texto del usuario; la causa original MUST NOT llegar a los `RunEvent`.
- **SE-R10** WHEN `search` recibe `minScore`, el host MUST descartar los resultados con `score < minScore` y devolverlos ordenados por `score` descendente.
- **SE-R11** WHEN se desregistra el proveedor activo (recarga de plugins), `available()` MUST pasar a `false` sin reiniciar el host.

---

## 6. Configuración

Clave nueva en `packages/core/src/config.ts`, **solo global** (como `decisions.provider`):

```ts
semantic: {
  enabled: boolean;              // default true
  embedding: string | null;      // provider id, default null
  store: string | null;          // provider id, default null
  embedTimeoutMs: number;        // 1_000..300_000, default 60_000 (el primer embed local puede cargar el modelo)
  queryTimeoutMs: number;        // 100..60_000, default 5_000
}
```

WHEN un archivo de configuración de repositorio define `semantic.embedding` o `semantic.store`, el host MUST ignorarlos y registrar una advertencia (igual que `decisions.provider`).

### 6.1 Comando `/semantic`

Solo lectura, en TUI y Web: muestra `enabled`, proveedores registrados (id, nombre, plugin propietario), los activos, `modelId`/`dimensions` y `health()` con tiempo límite de 1 s por proveedor. Sin proveedor activo, sugiere instalar un proveedor (texto EN/ES, sin nombrar un paquete externo concreto en el núcleo).

---

## 7. Pruebas

Reglas: Rojo → Verde → Refactor; pruebas de comportamiento a través de `SemanticApi` y `PluginHost`, con un doble en memoria (`tests/helpers/memory-semantic.ts`) que implementa ambos puertos con similitud coseno por fuerza bruta. Sin pruebas de LanceDB ni ONNX en este repo.

### 7.1 Matriz de aceptación

| ID | Caso | Resultado requerido | Decisión / Req. | Archivo |
|---|---|---|---|---|
| SE-AC-01 | Plugin registra embedding y store, sin configuración | `available()` falso; `search` rechaza `unavailable`; `trySearch` resuelve `null` | D3, D7, SE-R1, SE-R3 | `packages/core/tests/semantic-service.test.ts` |
| SE-AC-02 | Config global activa ambos ids registrados | `available()` verdadero; `index` + `search` devuelve el documento más cercano primero | D1, SE-R10 | ídem |
| SE-AC-03 | Id duplicado o inválido | `TypeError`; el registro previo sigue activo | SE-R2 | `semantic-registry.test.ts` |
| SE-AC-04 | Plugin A y B indexan la colección `notes` | El almacén recibe `a/notes` y `b/notes`; `collections()` de A no lista las de B | D4, SE-R4 | `semantic-service.test.ts` |
| SE-AC-05 | Colección creada con modelo X; se activa modelo Y | `index` y `search` rechazan `model_mismatch`; el doble registra cero llamadas a `embed` y `query` | D5, SE-R5 | ídem |
| SE-AC-06 | Proveedor devuelve vector de longitud errónea, menos vectores o `NaN` | Rechazo `dimension_mismatch` / `provider_error`; cero llamadas a `upsert` | SE-R6 | ídem |
| SE-AC-07 | 257 textos, texto de 32 769 caracteres, `topK` 0 y 101, id con espacio, filtro anidado, metadata de 9 KiB | `invalid_request` en cada caso, cero llamadas al proveedor | D9, D10, SE-R7 | `semantic-validate.test.ts` |
| SE-AC-08 | `embed` del proveedor no resuelve | Rechazo `timeout` tras `embedTimeoutMs`; el `signal` recibido por el proveedor queda abortado | D8, SE-R8 | `semantic-service.test.ts` |
| SE-AC-09 | El llamador aborta | Se propaga el aborto, no `timeout` | SE-R8 | ídem |
| SE-AC-10 | Proveedor lanza `Error("/home/u/x.lance: corrupt")` | `provider_error`; el mensaje no contiene `/home/`; ningún `RunEvent` contiene la causa | D8, SE-R9 | ídem |
| SE-AC-11 | `kind` llega al proveedor | `index` llama con `"document"`, `search` con `"query"` | D6 | ídem |
| SE-AC-12 | Configuración de repositorio define `semantic.store` | Se ignora y se advierte; el valor global prevalece | D3, §6 | `packages/core/tests/config.test.ts` |
| SE-AC-13 | Se desregistra el proveedor activo | `available()` pasa a falso sin reiniciar | SE-R11 | `semantic-service.test.ts` |
| SE-AC-14 | Herramienta de un plugin usa `ctx.semantic` | Opera en el espacio de nombres de su plugin | D4 | `packages/core/tests/plugin-host-semantic.test.ts` |
| SE-AC-15 | `activate()` sin superficie interactiva | `needs_confirmation`; la configuración no cambia | D3 | ídem |
| SE-AC-16 | Paquete publicado del host con `onnxruntime-node` en `dependencies` | `pnpm pack:check` falla con un mensaje que nombra el paquete | D2 | prueba del script de `pack:check` |
| SE-AC-17 | `/semantic` con un proveedor cuyo `health` no responde | Muestra `unavailable` tras 1 s; el comando termina | §6.1 | `packages/core/tests/semantic-command.test.ts` |

### 7.2 Mutation testing lite

Stryker con `mutate` acotado a `packages/core/src/semantic/validate.ts` y `namespace.ts` (lógica pura), `testRunner: "command"`, fuera de CI, presupuesto de 10 minutos. Solo se añaden pruebas para supervivientes que revelen un hueco de comportamiento real.

### 7.3 Pruebas que NO se escriben

Getters triviales, reexportaciones, la forma del esquema de configuración repetida en la prueba y el comportamiento de LanceDB/ONNX (pertenece al Anexo A).

---

## 8. Asignación de modelos

- **Sonnet**: implementación, pruebas y documentación de las Fases 1-2.
- **Haiku**: trámites (estado de la spec, archivado, referencias).
- **Opus**: ninguna invocación prevista. MAY usarse una revisión adversarial del contrato público tras la Fase 1 solo si el propietario la pide.

---

## 9. Fases

### Fase 1: contrato y servicio del núcleo

- Archivos: `packages/sdk/src/index.ts` (tipos §5), `packages/core/src/semantic/*` (nuevo), `packages/core/src/config.ts` (§6), `packages/core/src/plugins/host.ts` (`setSemantic`, `api.semantic`, `ToolContext.semantic`), `packages/core/src/application.ts` (enlace), `tests/helpers/memory-semantic.ts`.
- Cierra: SE-AC-01..15.
- Termina verde.

### Fase 2: superficie, guardia de paquete y documentación

- Archivos: `packages/core/src/commands/builtins.ts` (`/semantic`), i18n EN/ES de la Web si el comando muestra texto en la Web, guardia D2 en el script de `pack:check`, `apps/website/plugins.md` + `apps/website/es/plugins.md` (sección «Semantic search providers and consumers» con un ejemplo mínimo de consumidor y de proveedor), `apps/website/configuration.md` + `apps/website/es/configuration.md` (clave `semantic`), `apps/website/implementation-status.md` (límites: sin motor incluido; espacios de nombres no son aislamiento; reindexar es tarea del consumidor).
- Cierra: SE-AC-16, SE-AC-17.
- Captura de pantalla de la Web: solo si `/semantic` cambia la Web visiblemente (ver `alisio-docs-screenshots`).
- Termina verde.

---

## 10. Definición de terminado

- SE-AC-01..17 verdes, con el repo verde en los 9 comandos de §0.
- Ninguna dependencia nueva de producción en paquetes publicados del host (D2, SE-AC-16).
- Documentación EN/ES en paridad (`plugins`, `configuration`) y `apps/website/implementation-status.md` actualizado con límites y alcance verificado.
- Versión de parche 0.11.x preparada según `alisio-publish`; **sin publicar ni hacer commit hasta que el propietario lo pida**.
- El Anexo A NO forma parte de esta definición de terminado.

---

## 11. Riesgos y límites conocidos

| Riesgo | Decisión |
|---|---|
| Sin `plugin-semantic`, la capacidad no existe y los consumidores la pierden | Aceptado (principio rector). `available()` + `trySearch` permiten degradar a FTS5 (D7) |
| Contrato prematuro antes de un proveedor real | El Anexo A se desarrolla contra la Fase 1; cambios necesarios se hacen de forma aditiva en 0.11.x antes de que exista un segundo consumidor |
| Un plugin malicioso puede leer colecciones ajenas llamando al almacén directamente | Aceptado: los plugins son código de confianza; los espacios de nombres son solo higiene (§1.4) |
| Cambiar de modelo invalida índices | Detectado por D5; el consumidor reindexa. Documentado en `implementation-status.md` |
| El primer `embed` local puede tardar por descarga o carga del modelo | `embedTimeoutMs` de 60 s por defecto y `health: "starting"`; la descarga es responsabilidad del proveedor (Anexo A) |
| `score` coseno no es comparable entre modelos | `minScore` se documenta como dependiente del modelo |

---

## Anexo A — Entregable externo: `plugin-semantic` (repo `alisio-plugins`)

> **No se ejecuta en este repositorio.** La spec completa (incluida la app Notebook) es `alisio-plugins/specs/alisio-plugin-semantic-v1.md`; esta sección fija lo que el proveedor debe cumplir para encajar con el contrato de §5; su spec, pruebas y publicación siguen el `AGENTS.md` de `alisio-plugins`. Depende de que la Fase 1 esté publicada en una versión 0.11.x.

### A.1 Alcance

- Paquete `packages/plugin-semantic`, categorías `["search", "storage"]`, peer `@alisio/sdk` dentro de 0.11.x; solo importa `@alisio/sdk`.
- Registra un `VectorStoreProvider` sobre **LanceDB** (`@lancedb/lancedb`) con la base en `api.paths.state` y un `EmbeddingProvider` local por defecto con **`intfloat/multilingual-e5-small`** (384 dimensiones) sobre ONNX (O2).
- Registro con detección de capacidades: `api.semantic?.registerStore(...)`; en un host sin `semantic`, el plugin se carga sin registrar nada y lo explica en un comando de estado.

### A.2 Requisitos para el proveedor

| ID | Requisito |
|---|---|
| A-R1 | El modelo MUST descargarse en el primer uso (o con un comando de preparación explícito) a `api.paths.cache`, nunca dentro del tarball npm; mientras tanto `health()` devuelve `starting` |
| A-R2 | Los binarios ONNX SHOULD limitarse a la plataforma del usuario (por ejemplo, poda tras la instalación o dependencias opcionales por plataforma); excepción: si la poda rompe Bun o el binario de escritorio, se documenta el tamaño real |
| A-R3 | El modelo MUST poder cambiarse por opción (`pluginOverrides["semantic"].options.model`, por ejemplo otro e5, BGE-M3, MiniLM); `modelId()` MUST incluir modelo y variante de cuantización para que D5 detecte el cambio |
| A-R4 | `embed` MUST aplicar `query: ` / `passage: ` para la familia e5 según `kind` (D6), normalizar L2 y usar *mean pooling* según la tarjeta del modelo |
| A-R5 | `query` MUST devolver similitud coseno en `[-1, 1]` (convertir desde la distancia de LanceDB) ordenada de mayor a menor |
| A-R6 | La inferencia SHOULD ejecutarse fuera del hilo principal (worker) para no bloquear la TUI ni el servidor; excepción: lotes de ≤ 8 textos MAY ejecutarse en línea si se mide que tardan < 50 ms |
| A-R7 | Debe verificarse en Node >=22.16, Bun y Alisio Desktop (Electron) en Linux, macOS y Windows antes de declararlo estable; los fallos de carga nativa se informan como `health: unavailable` con un detalle sin rutas |
| A-R8 | Activación solo por acción del usuario (`api.semantic.activate?.(...)` desde un comando de configuración del plugin), nunca al instalar (D3) |

### A.3 Fuera de alcance del Anexo

RAG, fragmentación, extracción de documentos e interfaz de usuario: son consumidores (por ejemplo, un futuro Knowledge Vault basado en `specs/research/023-knowledge-vault-research.md`), no parte del proveedor.
