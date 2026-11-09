# Technical Specification: Document Visual QA — a vision-model review of the rendered pages (Phase 3 of the document engine, deferred)

| Campo | Valor |
|---|---|
| Versión | 0.1 |
| Origen | Phase 3 of `specs/026-document-engine-v1.md`, moved here on 2026-11-09 (content unchanged except for the references that pointed back into 026) |
| Proyecto | Alisio |
| Estado | **Deferred (backlog) by the owner on 2026-11-09: Phase 2 already produces professional, customizable PDFs; the three known defects were fixed deterministically instead.** Approved design, NOT implemented. It lives in `specs/backlog/` (approved but unscheduled): it is not executed until the owner moves it to `specs/`. Decisions O6 (visual part), D-26, Q3 and Q6 were confirmed in 026 on 2026-11-08 (D-26 approved by the owner the same day) and carry over unchanged |
| Fecha | 2026-11-09 |
| Paquetes afectados | `@alisio/core` (`src/documents/raster.ts`, `src/documents/visual-qa.ts`, `assets/documents/vendor/pdfjs`, completion path, config keys `documents.qa.visual` and `documents.qa.visualModel`); `@alisio/sdk` (additive optional `attachments?` on `CompletionRequest`); `@alisio/plugin-openai-compatible` (attachment mapping to vision parts) |
| Paquetes nuevos | None. pdf.js is vendored, not a dependency (D-26) |
| Relación con otras especificaciones | Extends `specs/026-document-engine-v1.md` (the document engine, tools `document_create` and `document_themes`, technical QA and the bounded repair of its §5.8). Requires 026 Phases 1-2 (shipped in 0.11.3). Independent of 026 Phases 4-5 |
| Superficies | Headless, TUI, web and Alisio Desktop through the `document_create` tool. HTTP: no new route |
| Política de versión | Additive only. `schemaVersion` and `protocolVersion` unchanged; the `attachments?` field is optional, so providers that ignore it keep working. Ships in the next minor after it is scheduled |

---

## 0. How to use this document (for coding agents)

1. Read `AGENTS.md` and `CONTRIBUTING.md`; load `alisio-architecture`, `alisio-coding-standards`, `alisio-pkg-core`, `alisio-pkg-sdk` and `alisio-plugins`. Also read `specs/026-document-engine-v1.md` §5.8, §12 and §13 first.
2. Labels: **(verificado)** = read in the repo or measured; **(nuevo)** = introduced here. RFC 2119 keywords in capitals only where behavior matters. Strict TDD. Language: English prose (as 026); identifiers, codes and generated strings in English; UI text EN and ES.
3. Green command list at the end of the phase: `pnpm typecheck`, `lint`, `test`, `build`, `test:cli`, `test:compiled`, `pack:check`, `docs:check`, `docs:build`.
4. Do not commit or publish until the owner asks. Never revert files you did not create.
5. On resume, re-verify every "(verificado 2026-11-08)" claim against the repo: 026 shipped and the code moved since.

---

## 1. Objective, status and scope

### 1.1 Objective

After the deterministic technical QA of 026 §5.8, let a vision-capable model look at thumbnails of the rendered pages and report layout defects the technical checks cannot see (alignment, overlaps, clipped text, empty areas, broken tables, legibility), within the bounded repair budget of 026.

### 1.2 Status and when to resume

- **Status:** Deferred (backlog) by the owner on 2026-11-09: Phase 2 already produces professional, customizable PDFs; the three known defects were fixed deterministically instead (026 §14).
- **When to resume:** when users report visual defects that deterministic QA does not catch.
- **Cost/benefit:** one extra vision model call per document and a few seconds of latency; it needs a model with image input (otherwise it is skipped); the vendored pdf.js adds about 0.5 MB. The side benefit is that `attachments` would let plugins send images through `api.model.complete`.

### 1.3 Scope

- Rasterization of the PDF to thumbnails (§3.1), the internal reviewer call (§3.2), additive `attachments?` on `CompletionRequest` (§3.3), configuration (§3.4), the bounded repair budget (§3.5).

### 1.4 Out of scope (non-goals)

| Excluded | Reason |
|---|---|
| Re-invoking the main agent loop inside the tool | 026 D18: repair is deterministic; unknown findings are returned as text |
| Visual QA for `quality: "fast"` | `fast` is technical QA only (026 §5.1) |
| Pixel-diff or golden-image comparison | Fragile across engines and fonts (026 §6.6) |
| Sending the PDF or thumbnails anywhere other than the configured model provider | The reviewer uses the user's own model configuration |

## 2. Decisions

### 2.1 Owner decisions carried over (confirmed 2026-11-08, applied exactly)

| ID | Decision |
|---|---|
| O6 (026) | Pipeline: render → technical QA → visual QA (rasterized pages the model can inspect) → bounded repair, at most 2 attempts |
| O10 (026), visual part | Visual QA was ordered before the WeasyPrint editorial phase; the owner deferred it on 2026-11-09, so 026 Phase 4 is now the next phase |

### 2.2 Design decisions

| ID | Decision | Reason |
|---|---|---|
| D-26 (026) | **pdf.js for visual QA: vendor a minimal build under `assets/documents/vendor/pdfjs` (Apache-2.0 + license file), not the `pdfjs-dist` dependency.** The full package fails Q3 (≤ 5 MB packed); the vendored subset passes. **Owner approved on 2026-11-08** (replaces the Q3 "dependency" wording) | `pdfjs-dist` 6.5.438 tarball 9.1 MB; `pdf.min.mjs` + `pdf.worker.min.mjs` 1.74 MB raw, 0.52 MB gzip (0.67 MB with the three wasm decoders, brotli of the two files 0.42 MB). Raster, 12 thumbnails (long side 1000 px): system Chrome 517 ms wall, Electron 434 ms; per page render 24/22 ms p50 + PNG encode 9/8 ms; all 40 pages 1.17 s / 1.07 s. Module worker is served through the virtual origin without extra config |
| Q3 (026) | `pdfjs-dist` for rasterization | Superseded by D-26: vendored minimal pdf.js build (0.52 MB gzip), lazily loaded; no `pdfjs-dist` dependency |
| Q6 (026) | Visual QA model | Session model when image-capable; optional `documents.qa.visualModel`; on by default only for `professional` |
| O6-visual (026 O6 and D18) | Visual findings are returned to the agent as text, which may call the tool again; known codes also trigger the deterministic repairs of 026 §5.8 | Bounded cost and time |

## 3. Design

### 3.1 Rasterization (was 026 §5.9)

- **Without Poppler** (works on Windows): render each PDF page to PNG inside the same headless Chromium (or the Electron offscreen window) with the bundled pdf.js build served from the virtual origin and captured by `Page.captureScreenshot` / `capturePage` (D-26).
- **WeasyPrint-only machines:** `pypdfium2` from the `documents` extras set.
- **Thumbnails:** long side 1 000 px, at most 12 pages (cover, TOC, then evenly sampled).

### 3.2 Reviewer call (was 026 §5.9)

- Because image tool results reach the model as text today, visual review is an **internal model call**, not a tool result with an image.
- The reviewer uses the session model WHEN its `ModelInfo.inputModalities` includes `image`, otherwise `documents.qa.visualModel` (Q6), otherwise `qa.visual.status: "skipped"` with the reason.
- The reviewer gets a fixed rubric (alignment, overlaps, clipped text, empty areas, broken tables, legibility) and returns JSON `{findings: [{page, code, note}]}` (≤ 10).
- Result shape (026 §5.1): `qa.visual?: { status: "passed" | "findings" | "skipped"; reason?: string; findings?: string[] }`.

### 3.3 Additive `attachments?` on `CompletionRequest` (nuevo)

- SDK: optional `attachments?: Attachment[]` on `CompletionRequest` messages (providers that ignore it keep working).
- Core completion path: forwards them as vision parts.
- `@alisio/plugin-openai-compatible`: maps them to vision parts, as it already does for user-message `Attachment` images.
- Known gap this closes (verificado 2026-11-08): `CompletionRequest` (`sdk/src/index.ts:1069`) carries text messages only; user-message `Attachment` images are sent as vision parts (`provider.ts:85`, `:194`); `ToolResult.content` allows `{type:"image"}` but `provider.ts:88-89` sends tool results as `JSON.stringify(m.result)`, so an image part reaches the model as base64 text.
- Side benefit: plugins could send images through `api.model.complete`.

### 3.4 Configuration

| Key | Default | Meaning |
|---|---|---|
| `documents.qa.visual` | `"auto"` | `off` \| `auto` |
| `documents.qa.visualModel` | unset | Model reference for visual QA (Q6) |

### 3.5 Bounded repair budget

Findings mapped to known codes trigger the 026 §5.8 repairs within the same 2-attempt budget; unknown codes are returned to the agent as text. Off for `quality: "fast"`; skipped with a reason when no image-capable model is available; bounded to 12 thumbnails.

## 4. Tests

Strict TDD, behavior at module boundaries, no snapshot tests of generated HTML (026 §6).

| ID | Case | Required result |
|---|---|---|
| DOC-AC-32 | Rasterization (env flag) | ≤ 12 PNG thumbnails, long side 1 000 px, on Linux and Windows CI runners without Poppler |
| DOC-AC-33 | Visual QA routing | Image-capable model → attachments sent; non-image model and no `visualModel` → `visual.status:"skipped"` with reason; provider ignoring attachments still works |
| DOC-AC-34 | Visual findings | Known codes consume the shared 2-attempt budget; unknown codes returned as text |

Traceability: O6 and D18 (visual part) map to DOC-AC-34 and DOC-AC-16 (026, `quality: fast` runs no visual QA); D-26 and Q3 map to DOC-AC-32; Q6 maps to DOC-AC-33.

## 5. Phase (when scheduled)

Files: `documents/raster.ts` (pdf.js in Chromium/Electron; pypdfium2 for WeasyPrint-only), `documents/visual-qa.ts`, additive `CompletionRequest` attachments in SDK + core completion path + `plugin-openai-compatible` mapping, vendored pdf.js under `assets/documents/vendor/pdfjs`. Closes DOC-AC-32..34. Ends green. Model assignment: Sonnet implements; no Opus gate is required beyond the owner's review of the vendored license file.

## 6. Definition of done

- DOC-AC-32..34 pass (the env-flagged row runs at least once on Linux and Windows and is recorded with its date in `docs/implementation-status.md`).
- Docs EN/ES (`docs/documents.md`, `docs/es/documents.md`, `docs/configuration.md`) describe the two config keys and the skip reasons, in parity.
- `docs/implementation-status.md` records verification scope and the vendored pdf.js version.
- Delivery checklist green; `pack:check` stays within the 026 size budget (Q1).

## 7. Risks and known limits

| Risk | Decision |
|---|---|
| Cost and provider support for image inputs | Off for `fast`; skipped with a reason when no image-capable model; bounded to 12 thumbnails |
| Vision models misjudge layout | Findings are advisory text; only known codes drive deterministic repairs |
| pdf.js upgrades and license | Vendored minimal build with its Apache-2.0 license file; re-measure size on every upgrade |
