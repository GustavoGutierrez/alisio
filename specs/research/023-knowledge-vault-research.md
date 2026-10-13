# Especificación: **Knowledge Vault for Alisio**

**Versión:** 1.0-draft\
**Fecha:** 2026-10-12\
**Producto:** Plugin de conocimiento local para Alisio\
**Motor de persistencia:** libSQL / Turso local\
**Tipo de documento:** Especificación técnica y de producto

## 1. Propósito

**Knowledge Vault** es un plugin local para Alisio que permite crear espacios de conocimiento privados a partir de documentos, URLs, notas, transcripciones y archivos técnicos. El usuario puede hacer preguntas, obtener respuestas fundamentadas con citas, generar resúmenes, mapas conceptuales, briefings y material de estudio sin depender de un servicio vectorial externo.

El plugin replica el patrón de producto de un asistente de investigación basado en fuentes: ingesta de documentos, fragmentación, generación de embeddings, recuperación híbrida, síntesis con LLM y trazabilidad de citas. La base de datos libSQL/Turso almacenará documentos, fragmentos, metadatos, embeddings, índices vectoriales y estado del plugin en un único archivo local.[^1][^2]

## 2. Alcance

### 2.1 In scope

- Crear, listar, renombrar, archivar y eliminar **workspaces** de conocimiento.
- Ingestar fuentes locales y remotas: PDF, Markdown, texto, CSV, imágenes con OCR, URLs, YouTube mediante transcripción y archivos exportados desde otras herramientas.
- Fragmentar documentos con metadatos de procedencia.
- Generar embeddings locales o mediante proveedor configurable.
- Búsqueda semántica, búsqueda léxica y búsqueda híbrida.
- Respuestas con citas verificables hacia fuente y fragmento.
- Generación de artefactos: resúmenes, notas, FAQs, flashcards, quizzes, mapas conceptuales, timelines y briefings.
- Ejecución opcional de código para análisis de CSV y datos tabulares.
- Exportación de notebooks, fuentes, índices y artefactos.
- Integración como plugin de Alisio mediante MCP, skills o API interna.


### 2.2 Out of scope

- Reemplazar el agente de codificación de Alisio.
- Ejecutar cambios sobre un repositorio de código.
- Sincronización multiusuario en tiempo real.
- Entrenamiento o fine-tuning de modelos.
- Búsqueda web autónoma por defecto; se habilitará solo como fuente explícita.
- Compartir datos con servicios externos sin consentimiento explícito del usuario.


## 3. Usuarios y casos de uso

### 3.1 Casos de uso principales

| ID | Caso de uso | Actor | Resultado esperado |
| :-- | :-- | :-- | :-- |
| UC-01 | Crear un workspace | Usuario | Se crea un espacio aislado con configuración, fuentes y artefactos propios. |
| UC-02 | Ingestar una fuente | Usuario | El sistema extrae texto, genera metadatos, fragmenta y crea embeddings. |
| UC-03 | Consultar el conocimiento | Usuario | Recibe una respuesta fundamentada con citas a fragmentos específicos. |
| UC-04 | Comparar fuentes | Usuario | Identifica coincidencias, contradicciones y vacíos entre documentos. |
| UC-05 | Generar un resumen | Usuario | Obtiene un resumen estructurado basado solo en fuentes seleccionadas. |
| UC-06 | Generar material de estudio | Usuario | Crea flashcards, preguntas, quizzes o guías de estudio. |
| UC-07 | Generar un mapa conceptual | Usuario | Obtiene un grafo navegable de conceptos y relaciones. |
| UC-08 | Consultar desde Alisio | Agente Alisio | Recupera contexto citado para responder o planificar una tarea. |
| UC-09 | Analizar un CSV | Usuario | Ejecuta consultas o código sobre datos tabulares dentro del workspace. |
| UC-10 | Actualizar una fuente | Usuario | Reemplaza, versiona o reindexa un documento sin perder trazabilidad. |
| UC-11 | Exportar conocimiento | Usuario | Exporta notebook, fuentes, citas o artefactos en Markdown/JSON. |

### 3.2 Ejemplo de flujo

```text
Usuario: “¿Qué restricciones de seguridad aplican a la exportación de inventario?”

1. Alisio invoca Knowledge Vault.
2. El plugin genera el embedding de la consulta.
3. Recupera fragmentos de PRD, ADRs, políticas y tickets.
4. Ejecuta búsqueda semántica + FTS + filtros por tipo de fuente.
5. Fusiona resultados con RRF y opcionalmente rerankea.
6. Envía el contexto seleccionado al LLM.
7. Devuelve respuesta con citas:
   - PRD Inventario v2, sección 4.2
   - ADR-014, decisión de auditoría
   - Política de datos personales, página 8
```


## 4. Requisitos funcionales

### 4.1 Gestión de workspaces

| ID | Requisito | Prioridad |
| :-- | :-- | :-- |
| RF-01 | El sistema debe permitir crear workspaces con nombre, descripción, etiquetas y configuración de modelo. | Alta |
| RF-02 | Cada workspace debe aislar sus fuentes, fragmentos, embeddings, conversaciones y artefactos. | Alta |
| RF-03 | El sistema debe permitir duplicar, archivar, restaurar y eliminar workspaces. | Media |
| RF-04 | El sistema debe permitir exportar un workspace completo a un archivo portable. | Media |
| RF-05 | El sistema debe mostrar estadísticas: número de fuentes, fragmentos, tokens, tamaño y última actualización. | Media |

### 4.2 Ingesta de fuentes

| ID | Requisito | Prioridad |
| :-- | :-- | :-- |
| RF-06 | El sistema debe aceptar PDF, Markdown, TXT, CSV, JSON, DOCX, HTML, imágenes y URLs. | Alta |
| RF-07 | El sistema debe extraer texto, título, autor, fecha, tipo MIME, hash de contenido y metadatos disponibles. | Alta |
| RF-08 | El sistema debe detectar cambios por hash de contenido y evitar reindexación innecesaria. | Alta |
| RF-09 | El sistema debe permitir reemplazar una fuente conservando versiones anteriores. | Media |
| RF-10 | El sistema debe permitir activar o desactivar fuentes por consulta. | Alta |
| RF-11 | El sistema debe procesar fuentes en segundo plano sin bloquear la interfaz. | Alta |
| RF-12 | El sistema debe reportar errores de extracción, OCR, descarga o embedding con detalle accionable. | Alta |
| RF-13 | El sistema debe soportar ingesta por lotes. | Media |

### 4.3 Fragmentación e indexación

| ID | Requisito | Prioridad |
| :-- | :-- | :-- |
| RF-14 | El sistema debe dividir documentos en fragmentos con tamaño configurable. | Alta |
| RF-15 | El sistema debe conservar superposición entre fragmentos para preservar continuidad semántica. | Alta |
| RF-16 | El sistema debe almacenar para cada fragmento: texto, orden, página, sección, encabezados, hash y referencia a fuente. | Alta |
| RF-17 | El sistema debe generar un embedding por fragmento usando el modelo configurado. | Alta |
| RF-18 | El sistema debe almacenar embeddings en columnas vectoriales nativas de libSQL. | Alta |
| RF-19 | El sistema debe soportar reindexación incremental. | Alta |
| RF-20 | El sistema debe permitir eliminar un fragmento y su embedding de forma atómica. | Alta |

### 4.4 Recuperación y consulta

| ID | Requisito | Prioridad |
| :-- | :-- | :-- |
| RF-21 | El sistema debe permitir búsqueda semántica por similitud coseno. | Alta |
| RF-22 | El sistema debe permitir búsqueda léxica sobre títulos, contenido y metadatos. | Alta |
| RF-23 | El sistema debe combinar resultados semánticos y léxicos mediante Reciprocal Rank Fusion. | Alta |
| RF-24 | El sistema debe permitir filtros por fuente, tipo, etiqueta, fecha, idioma y estado. | Alta |
| RF-25 | El sistema debe devolver el fragmento original, la fuente, la puntuación y la posición en el documento. | Alta |
| RF-26 | El sistema debe permitir un reranker opcional para mejorar precisión. | Media |
| RF-27 | El sistema debe permitir definir `top_k`, umbral de similitud y presupuesto de contexto. | Alta |
| RF-28 | El sistema debe indicar cuando no encuentra evidencia suficiente en las fuentes. | Alta |
| RF-29 | El sistema debe evitar responder desde conocimiento general cuando el modo estricto esté activo. | Alta |

### 4.5 Generación con LLM

| ID | Requisito | Prioridad |
| :-- | :-- | :-- |
| RF-30 | El sistema debe generar respuestas exclusivamente a partir del contexto recuperado en modo grounded. | Alta |
| RF-31 | Cada afirmación relevante debe estar asociada a una o varias citas. | Alta |
| RF-32 | El usuario debe poder abrir la cita y ver el fragmento original. | Alta |
| RF-33 | El sistema debe permitir elegir proveedor LLM: local vía OpenAI-compatible, Ollama, LM Studio o API remota. | Alta |
| RF-34 | El sistema debe permitir guardar conversaciones y respuestas como notas. | Media |
| RF-35 | El sistema debe permitir convertir una respuesta en fuente reutilizable. | Media |
| RF-36 | El sistema debe soportar streaming de respuestas. | Media |

### 4.6 Artefactos derivados

| ID | Requisito | Prioridad |
| :-- | :-- | :-- |
| RF-37 | Generar resúmenes ejecutivos, técnicos y por sección. | Alta |
| RF-38 | Generar FAQs, flashcards, quizzes y guías de estudio. | Media |
| RF-39 | Generar mapas conceptuales con nodos, relaciones y evidencia. | Media |
| RF-40 | Generar timelines y tablas comparativas. | Media |
| RF-41 | Generar briefings, PRD drafts, ADR drafts y documentos técnicos en Markdown. | Alta |
| RF-42 | Permitir regenerar, editar y versionar artefactos. | Media |
| RF-43 | Exportar artefactos a Markdown, JSON, PDF y HTML. | Media |

### 4.7 Integración con Alisio

| ID | Requisito | Prioridad |
| :-- | :-- | :-- |
| RF-44 | Exponer herramientas MCP: `create_workspace`, `add_source`, `query`, `search`, `generate_artifact`, `list_sources`, `export`. | Alta |
| RF-45 | Permitir que un skill de Alisio consulte el vault antes de generar una especificación o plan. | Alta |
| RF-46 | Permitir que un subagente realice recuperación y devuelva un resumen con fuentes. | Alta |
| RF-47 | Permitir restringir el acceso por workspace y por tipo de fuente. | Alta |
| RF-48 | Registrar auditoría de consultas, fuentes usadas y artefactos generados. | Media |

## 5. Requisitos no funcionales

| ID | Categoría | Requisito |
| :-- | :-- | :-- |
| RNF-01 | Privacidad | Todo el corpus, embeddings, conversaciones y metadatos deben permanecer locales por defecto. |
| RNF-02 | Portabilidad | La base debe ser un archivo libSQL/SQLite portable y respaldable. |
| RNF-03 | Rendimiento | Una consulta semántica sobre 100.000 fragmentos debe responder en menos de 500 ms, excluyendo generación LLM. |
| RNF-04 | Latencia de ingesta | La ingesta debe ser asíncrona; la UI debe permanecer usable durante el proceso. |
| RNF-05 | Escalabilidad | El sistema debe operar con al menos 500 fuentes y 250.000 fragmentos por workspace. |
| RNF-06 | Trazabilidad | Toda respuesta debe poder rastrearse hasta fuente, versión, fragmento y modelo usado. |
| RNF-07 | Seguridad | Las claves API deben almacenarse cifradas; nunca en texto plano ni en logs. |
| RNF-08 | Aislamiento | Un workspace no debe poder consultar datos de otro workspace sin autorización explícita. |
| RNF-09 | Observabilidad | El sistema debe emitir logs estructurados con `request_id`, duración, fuentes y errores. |
| RNF-10 | Resiliencia | Una falla de embedding o LLM no debe corromper la base ni perder fuentes ya indexadas. |
| RNF-11 | Mantenibilidad | Esquema versionado mediante migraciones idempotentes. |
| RNF-12 | Accesibilidad | La interfaz debe cumplir WCAG 2.2 AA. |
| RNF-13 | Multiplataforma | Debe funcionar en Windows, macOS y Linux desde Alisio. |
| RNF-14 | Offline-first | La búsqueda, recuperación y generación local deben funcionar sin conexión. |

## 6. Arquitectura

### 6.1 Vista general

```text
┌─────────────────────────────────────────────────────────────┐
│                         Alisio                              │
│  UI / Skills / Subagentes / MCP Client                      │
└───────────────────────────┬─────────────────────────────────┘
                            │ MCP / Plugin API
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                  Knowledge Vault Plugin                     │
│                                                             │
│  ┌───────────────┐  ┌───────────────┐  ┌────────────────┐  │
│  │ Source        │  │ Ingestion     │  │ Retrieval      │  │
│  │ Manager       │→ │ Pipeline      │→ │ Engine         │  │
│  └───────────────┘  └───────────────┘  └────────────────┘  │
│         │                   │                   │           │
│         │           ┌───────▼───────┐   ┌───────▼────────┐  │
│         │           │ Embedding     │   │ Hybrid Ranker  │  │
│         │           │ Service       │   │ + Reranker     │  │
│         │           └───────────────┘   └────────────────┘  │
│         │                                                 │
│  ┌──────▼────────┐  ┌───────────────┐  ┌────────────────┐  │
│  │ Artifact      │  │ LLM Gateway   │  │ Audit / Telemetry│ │
│  │ Studio        │← │               │← │                │  │
│  └───────────────┘  └───────────────┘  └────────────────┘  │
└───────────────────────────┬─────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              libSQL / Turso local database                  │
│  workspaces · sources · chunks · embeddings · FTS           │
│  conversations · artifacts · jobs · audit                   │
└─────────────────────────────────────────────────────────────┘
```


### 6.2 Módulos

| Módulo | Responsabilidad |
| :-- | :-- |
| **Source Manager** | Registro, validación, versionado, activación y eliminación de fuentes. |
| **Extraction Service** | Conversión de PDF, DOCX, HTML, imágenes, audio y URLs a texto normalizado. |
| **Chunker** | Segmentación semántica y estructural del texto. |
| **Embedding Service** | Generación de vectores, batching, caché y validación de dimensiones. |
| **Retrieval Engine** | Búsqueda vectorial, FTS, filtros, fusión RRF y reranking. |
| **Grounding Service** | Construcción del contexto, control de presupuesto y asociación de citas. |
| **LLM Gateway** | Abstracción de proveedores locales y remotos. |
| **Artifact Studio** | Generación de resúmenes, mapas, quizzes, briefings y documentos. |
| **Job Queue** | Ingesta, OCR, embedding y reindexación en segundo plano. |
| **Audit Service** | Registro de accesos, fuentes usadas, modelos y operaciones sensibles. |

## 7. Modelo de datos

### 7.1 Decisiones de almacenamiento

- Los vectores se almacenan como `F32_BLOB(n)` en libSQL.
- La dimensión debe coincidir exactamente con la salida del modelo de embeddings.
- La métrica por defecto será **cosine distance**, adecuada para similitud semántica textual.[^2][^3]
- Para corpus grandes se usará `libsql_vector_idx` y `vector_top_k`; para corpus pequeños puede usarse escaneo exacto con `vector_distance_cos`.[^3][^1]
- El límite documentado de dimensiones en libSQL/Turso es 65.536.[^1][^3]


### 7.2 Esquema SQL

```sql
PRAGMA journal_mode = WAL;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  embedding_provider TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL,
  llm_provider TEXT NOT NULL,
  llm_model TEXT NOT NULL,
  strict_grounding INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  uri TEXT,
  content_hash TEXT NOT NULL,
  mime_type TEXT,
  language TEXT,
  word_count INTEGER,
  page_count INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  version INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_sources_workspace
ON sources(workspace_id, enabled, status);

CREATE UNIQUE INDEX idx_sources_hash
ON sources(workspace_id, content_hash, version);

CREATE TABLE source_versions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  extracted_text_path TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  page INTEGER,
  section_path TEXT,
  heading TEXT,
  token_count INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_chunks_source
ON chunks(source_id, chunk_index);

CREATE INDEX idx_chunks_workspace
ON chunks(workspace_id, source_id);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  title,
  section_path,
  content='chunks',
  content_rowid='rowid'
);

CREATE TABLE chunk_embeddings (
  chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL,
  embedding F32_BLOB(768) NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX chunk_embeddings_vec_idx
ON chunk_embeddings (
  libsql_vector_idx(embedding, 'metric=cosine')
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  citations_json TEXT NOT NULL DEFAULT '[]',
  context_json TEXT NOT NULL DEFAULT '{}',
  model TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content_markdown TEXT NOT NULL,
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  citations_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_id TEXT,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  sources_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
```


### 7.3 Relaciones

```text
workspace 1 ─── n source
source    1 ─── n source_version
source    1 ─── n chunk
chunk     1 ─── 1 chunk_embedding
workspace 1 ─── n conversation
conversation 1 ─ n message
workspace 1 ─── n artifact
workspace 1 ─── n job
workspace 1 ─── n audit_event
```


## 8. Especificación de embeddings

### 8.1 Modelo recomendado

| Perfil | Modelo | Dimensión | Tipo en libSQL | Uso recomendado |
| :-- | :-- | --: | :-- | :-- |
| Local por defecto | `bge-m3` vía Ollama o ONNX | 1024 | `F32_BLOB(1024)` | Multilingüe, RAG general, español e inglés. |
| Local liviano | `all-MiniLM-L6-v2` | 384 | `F32_BLOB(384)` | Equipos limitados, prototipos, búsqueda rápida. |
| Local equilibrado | `bge-small-en-v1.5` o equivalente multilingüe | 384–512 | `F32_BLOB(384)` | Corpus personales pequeños. |
| Remoto opcional | Modelo de embeddings comercial | 1024–3072 | `F32_BLOB(n)` | Máxima calidad cuando se acepta nube. |

La configuración inicial recomendada es **`bge-m3`, 1024 dimensiones, `F32_BLOB(1024)` y distancia coseno**, porque ofrece buen equilibrio entre calidad multilingüe, tamaño y compatibilidad con libSQL. Turso documenta `vector32` como formato de 32 bits con 4 bytes por dimensión y recomienda `F32_BLOB` como punto de partida.[^2][^1]

### 8.2 Reglas de dimensión

```text
embedding_dimensions = output_dimension(model)
F32_BLOB(n).n        = embedding_dimensions
query_vector.n       = embedding_dimensions
stored_vector.n      = embedding_dimensions
```

- Cambiar el modelo exige crear una nueva colección de embeddings o reindexar.
- No se permiten mezclar vectores de modelos distintos en la misma columna.
- Cada fuente debe registrar el modelo y la dimensión usados.
- La validación debe ocurrir antes de insertar en la base.


### 8.3 Configuración por workspace

```json
{
  "embedding": {
    "provider": "ollama",
    "endpoint": "http://127.0.0.1:11434",
    "model": "bge-m3",
    "dimensions": 1024,
    "batch_size": 32,
    "metric": "cosine",
    "storage_type": "F32_BLOB"
  },
  "chunking": {
    "strategy": "semantic_structure",
    "max_tokens": 700,
    "overlap_tokens": 100,
    "preserve_headings": true,
    "min_chunk_tokens": 120
  },
  "retrieval": {
    "vector_top_k": 30,
    "fts_top_k": 30,
    "final_top_k": 8,
    "rrf_k": 60,
    "min_score": 0.35,
    "reranker": "optional"
  }
}
```


## 9. Pipeline de RAG

### 9.1 Ingesta

```text
Fuente
  → Validación y deduplicación por hash
  → Extracción de texto y metadatos
  → Normalización y limpieza
  → Detección de estructura: encabezados, páginas, tablas
  → Chunking
  → Generación de embeddings por lote
  → Persistencia en libSQL
  → Actualización de FTS e índice vectorial
  → Marcar fuente como indexed
```


### 9.2 Consulta

```text
Pregunta
  → Embedding de consulta
  → Filtros por workspace y fuentes activas
  → vector_top_k sobre índice DiskANN
  → FTS5 / búsqueda léxica
  → Fusión RRF
  → Reranking opcional
  → Selección de contexto dentro del presupuesto
  → LLM grounded
  → Respuesta + citas
```


### 9.3 Consulta SQL de recuperación

```sql
WITH vector_hits AS (
  SELECT
    e.chunk_id,
    c.content,
    c.source_id,
    c.section_path,
    vector_distance_cos(e.embedding, vector32(:query_vector)) AS distance
  FROM vector_top_k(
    'chunk_embeddings_vec_idx',
    vector32(:query_vector),
    :vector_top_k
  ) AS knn
  JOIN chunk_embeddings e ON e.chunk_id = knn.id
  JOIN chunks c ON c.id = e.chunk_id
  WHERE c.workspace_id = :workspace_id
    AND c.source_id IN (:enabled_source_ids)
)
SELECT *
FROM vector_hits
ORDER BY distance ASC
LIMIT :final_top_k;
```


### 9.4 Fusión híbrida

```text
score_rrf(item) = Σ 1 / (rrf_k + rank_i)

donde:
  rank_i = posición del ítem en cada lista de resultados
  rrf_k  = 60 por defecto
```

La fusión RRF evita comparar directamente puntuaciones BM25 y similitud coseno, que tienen escalas distintas. El resultado debe conservar la evidencia de cada canal: `vector_rank`, `fts_rank`, `final_rank` y `source_id`.[^4]

## 10. Estructura de datos en memoria

```typescript
type Workspace = {
  id: string;
  name: string;
  description?: string;
  embedding: EmbeddingConfig;
  llm: LlmConfig;
  strictGrounding: boolean;
  createdAt: number;
  updatedAt: number;
};

type Source = {
  id: string;
  workspaceId: string;
  title: string;
  type: 'pdf' | 'markdown' | 'url' | 'youtube' | 'csv' | 'image' | 'text';
  uri?: string;
  contentHash: string;
  status: 'pending' | 'processing' | 'indexed' | 'failed';
  version: number;
  enabled: boolean;
  metadata: Record<string, unknown>;
};

type Chunk = {
  id: string;
  sourceId: string;
  sourceVersionId: string;
  index: number;
  content: string;
  page?: number;
  sectionPath?: string;
  heading?: string;
  tokenCount: number;
  contentHash: string;
  metadata: Record<string, unknown>;
};

type EmbeddingRecord = {
  chunkId: string;
  model: string;
  dimensions: number;
  vector: Float32Array;
};

type RetrievedChunk = {
  chunk: Chunk;
  source: Source;
  vectorRank?: number;
  ftsRank?: number;
  finalRank: number;
  score: number;
  citationId: string;
};

type Citation = {
  citationId: string;
  sourceId: string;
  sourceTitle: string;
  chunkId: string;
  page?: number;
  sectionPath?: string;
  quote: string;
  uri?: string;
};
```


## 11. API del plugin

### 11.1 Herramientas MCP

| Herramienta | Entrada | Salida |
| :-- | :-- | :-- |
| `create_workspace` | `name`, `embeddingConfig`, `llmConfig` | `workspaceId` |
| `add_source` | `workspaceId`, `path|url|text`, `metadata` | `sourceId`, `jobId` |
| `list_sources` | `workspaceId`, filtros | Lista de fuentes y estado |
| `query` | `workspaceId`, `question`, `sourceIds?`, `topK?` | Respuesta, citas y métricas |
| `search` | `workspaceId`, `query`, filtros | Fragmentos recuperados |
| `generate_artifact` | `workspaceId`, `type`, `instructions`, `sourceIds?` | Artefacto Markdown |
| `get_citation` | `workspaceId`, `citationId` | Fragmento y fuente original |
| `export_workspace` | `workspaceId`, formato | Archivo exportado |

### 11.2 Contrato de `query`

```json
{
  "workspaceId": "ws_01",
  "question": "¿Qué decisiones afectan las migraciones de SQLite?",
  "sourceIds": ["src_adr", "src_prd"],
  "topK": 8,
  "strictGrounding": true,
  "includeCitations": true
}
```

Respuesta esperada:

```json
{
  "answer": "Las migraciones aplicadas no deben modificarse...",
  "citations": [
    {
      "citationId": "cit_001",
      "sourceTitle": "ADR-014 SQLite migrations",
      "chunkId": "chk_812",
      "page": 3,
      "quote": "Una migración aplicada debe considerarse inmutable..."
    }
  ],
  "retrieval": {
    "vectorCandidates": 30,
    "ftsCandidates": 30,
    "finalCandidates": 8,
    "latencyMs": 142
  }
}
```


## 12. Estrategia de chunking

| Tipo de fuente | Estrategia | Tamaño objetivo | Superposición |
| :-- | :-- | --: | --: |
| Markdown / documentación | Por encabezados, luego por tokens | 500–800 tokens | 80–120 tokens |
| PDF técnico | Por página y sección | 500–800 tokens | 100 tokens |
| Transcripción | Por segmento temporal y tema | 400–700 tokens | 80 tokens |
| CSV | Por fila agrupada o por hoja | Variable | No aplica |
| Código / especificaciones | Por bloque estructural | 400–800 tokens | 100 tokens |

Reglas:

- Nunca dividir una tabla, bloque de código o definición crítica si cabe en el límite.
- Conservar el encabezado padre en cada fragmento.
- Añadir un prefijo contextual corto cuando el fragmento carezca de contexto propio.
- Almacenar el texto original íntegro para permitir verificación de citas.


## 13. Seguridad y privacidad

- El almacenamiento por defecto será local: `file:./knowledge-vault.db`.
- Las claves de proveedores remotos se guardarán cifradas usando el almacén seguro del sistema operativo o un vault local.
- Las consultas no enviarán el corpus completo al LLM; solo fragmentos seleccionados.
- El modo estricto impedirá respuestas sin evidencia recuperada.
- Cada operación de lectura, escritura, exportación y eliminación generará un evento de auditoría.
- Los datos sensibles detectados en ingesta podrán marcarse con etiquetas de retención y exclusión de exportación.
- La eliminación de una fuente debe eliminar en cascada fragmentos, embeddings, citas derivadas y artefactos asociados, previa confirmación.


## 14. Métricas de calidad

| Métrica | Definición | Objetivo inicial |
| :-- | :-- | --: |
| Recall@10 | Proporción de fragmentos relevantes recuperados en top 10 | ≥ 0.80 |
| Precision@5 | Proporción de fragmentos relevantes en top 5 | ≥ 0.70 |
| Citation accuracy | Citas que efectivamente soportan la afirmación | ≥ 0.90 |
| Grounded answer rate | Respuestas basadas en evidencia recuperada | ≥ 0.95 |
| Ingesta exitosa | Fuentes indexadas sin error | ≥ 0.98 |
| Latencia de recuperación p95 | Tiempo de recuperación sin LLM | ≤ 500 ms |
| Reindexación incremental | Fragmentos reembedados tras cambio menor | ≤ 10% |

## 15. Criterios de aceptación

- Un usuario puede crear un workspace, cargar un PDF y hacer una pregunta con citas verificables.
- La respuesta no incluye información externa cuando `strictGrounding` está activo.
- Al eliminar una fuente, no quedan fragmentos ni embeddings huérfanos.
- Cambiar el modelo de embeddings genera error controlado y ofrece reindexación.
- La búsqueda encuentra contenido semántico aunque no coincida literalmente con la consulta.
- La búsqueda híbrida encuentra identificadores exactos, códigos de error y términos técnicos.
- Alisio puede invocar `query` desde un skill y recibir citas estructuradas.
- La base puede copiarse a otra máquina y abrirse sin migración manual.
- El sistema funciona sin conexión usando embeddings y LLM locales.


## 16. Fases de implementación

### Fase 1 — MVP

- Workspaces, fuentes Markdown/TXT/PDF.
- Chunking básico.
- Embeddings locales.
- `F32_BLOB(1024)` + índice coseno.
- Búsqueda vectorial y respuestas citadas.
- MCP `query`, `add_source`, `list_sources`.


### Fase 2 — Recuperación híbrida

- FTS5.
- Fusión RRF.
- Filtros por metadatos.
- Reindexación incremental.
- Auditoría y observabilidad.


### Fase 3 — Studio

- Resúmenes, FAQs, flashcards y quizzes.
- Mapas conceptuales.
- Briefings y documentos técnicos.
- Exportación Markdown/JSON/PDF.


### Fase 4 — Integración avanzada

- Subagente de recuperación para Alisio.
- Conectores a Jira, Confluence, GitHub y repositorios locales.
- Reranker local.
- Ejecución segura de código para CSV.
- Multi-workspace con permisos granulares.


## 17. Referencias técnicas

- libSQL/Turso soporta búsqueda vectorial nativa con tipos como `F32_BLOB(n)`, funciones de distancia e índices ANN.[^1][^2]
- `vector_distance_cos` calcula distancia coseno, donde valores menores indican mayor similitud.[^3][^2]
- `libsql_vector_idx` crea un índice ANN basado en DiskANN y `vector_top_k` recupera los `k` vecinos más cercanos.[^5][^3]
- El límite documentado de dimensionalidad vectorial es 65.536.[^3][^1]
- La recuperación híbrida que combina búsqueda densa y léxica con fusión de rankings es un patrón adecuado para corpus técnicos y documentales.[^4]

<span style="display:none">[^10][^11][^12][^13][^14][^15][^6][^7][^8][^9]</span>

<div align="center">⁂</div>

[^1]: https://docs.turso.tech/guides/vector-search

[^2]: https://docs.turso.tech/sql-reference/functions/vector

[^3]: https://www.azion.com/en/documentation/products/store/sql-database/vector-search/

[^4]: https://github.com/7xuanlu/wenlan/blob/main/docs/technical-foundations.md

[^5]: https://www.anygen.io/showcase/libsql/index.html

[^6]: https://classic.yarnpkg.com/en/package/libsql-plugkit-client

[^7]: https://turso.tech/blog/building-a-retrieval-pipeline-with-turso-and-voyage-ai?from_theconsensus=1

[^8]: https://dev.to/volland/personal-knowledge-graphs-in-ai-rag-powered-applications-with-libsql-m3d

[^9]: https://github.com/d-o-hub/chaotic_semantic_memory

[^10]: https://mastra.ai/reference/vectors/libsql

[^11]: https://github.com/ZanzyTHEbar/dragonscale

[^12]: https://github.com/notrab/libsql-vector

[^13]: https://github.com/tursodatabase/turso/blob/main/docs/manual.md

[^14]: https://docs.turso.tech/features/ai-and-embeddings

[^15]: https://turso.tech/vector

