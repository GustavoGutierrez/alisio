---
name: alisio-specs
description: "Write, number, place, review, execute and archive Alisio technical specs under specs/ (folder semantics, NNN-slug-vN naming, model assignment, spec skeleton, acceptance matrix, test strategy, ready-to-execute checklist). Trigger: write a spec, new spec, execute spec, implement spec, archive spec, specs/ folder, test strategy for a spec."
---

# Alisio specs workflow

Methodology for `specs/`. Specs are executed by coding agents: write them so an agent with
no prior context can implement them without guessing. **Do not commit** unless the owner asks.

## 1. Folder semantics (`specs/`)

| Location | Meaning | Executable? |
|---|---|---|
| `specs/` (top level) | Active or approved specs to execute | Yes, when Estado says approved |
| `specs/backlog/` | Valid but not scheduled yet | No, until the owner moves it up |
| `specs/research/` | Research that feeds spec writing | Never |
| `specs/archive/` | Implemented or completed specs | No (history) |

When a spec is fully implemented: (1) set `Estado` to `**Implementada (fases X-Y)**. Ver
`docs/implementation-status.md``, (2) make sure that file records limitations and verification
scope, (3) move the spec to `specs/archive/`, (4) fix every reference to the old path
(`grep -rn "specs/<name>" specs docs AGENTS.md README.md`). Moving a spec between folders never
changes its number.

## 2. File naming and numbering

- New files: `NNN-<kebab-slug>-v<major>.md`, e.g. `001-model-routing-v1.md`. Research:
  `NNN-<kebab-slug>-research.md`.
- `NNN` is three digits, consecutive across ALL of `specs/`, including `archive/`, `backlog/`
  and `research/`. Next = highest existing `NNN` + 1, scanning the four locations. Never reuse a
  number, even if the file was deleted or moved.
- Legacy files were bulk-renamed to this scheme on 2026-10-13 (owner-approved), and their
  references were fixed in the same change. Numbering continues from the highest `NNN` in
  `specs/` (currently `023`). Do not reintroduce unnumbered names.
- Compute with: `ls specs specs/*/ | grep -oE '^[0-9]{3}' | sort -n | tail -1`
  (no match = next is `001`).
- Bump `v<major>` only for a breaking rewrite of the spec's scope; otherwise edit the Versión
  field in the header table.

## 3. Model assignment (Agent tool `model`)

Opus only for deep reasoning; Sonnet for execution work; Haiku for mechanical bookkeeping.

| `model` | Use for |
|---|---|
| `opus` | Complex analysis, architecture and trade-off decisions, adversarial review of a high-risk spec, phase gates the spec marks as "Opus review" |
| `sonnet` | Drafting the spec, implementation, tests, docs, screenshots (default for execution) |
| `haiku` | Changing `Estado`, moving files between `specs/` folders, computing the next number, fixing references, listing related backlog/research docs |

Minimize Opus invocations; name each one in the spec (section "Asignación de modelos").

## 4. Workflow: "write a spec for X"

1. `haiku`: compute next `NNN`; list related docs in `backlog/` and `research/`; return paths only.
2. `opus`: analysis, options with trade-offs, decisions, open questions. Ask the owner **one
   question at a time** and stop for the answer. Record answers as owner decisions (`O1..On`).
3. `sonnet`: draft following the skeleton in section 6. Verify every claim about current code by
   reading the repo; label it (section 5).
4. Optional `opus`: adversarial review, only for high-risk specs (security, persistence,
   permissions, public contracts). Findings become decisions or risks, not silent edits.
5. `haiku`: place the file (top level if approved, `backlog/` if not scheduled) and fix references.

## 5. Writing standards

- **RFC 2119 keywords** (MUST, MUST NOT, SHOULD, SHOULD NOT, MAY) in capitals, used sparingly
  and only where the behavior matters for interoperation, safety or tests. State the convention
  once in section 0. SHOULD requires a stated exception condition.
- **EARS shape for behavior** (trigger/state in a fixed place): `WHEN <trigger>, the <system>
  MUST <response>`; `WHILE <state>, ...`; `IF <unwanted condition>, THEN ...`; `WHERE <feature>`.
  One system, one trigger, one response per requirement. No "fast", "robust", "appropriate"
  without a number (limit, timeout, size, percentile).
- **IDs everywhere**: owner decisions `O1..`, design decisions `D1..`, later-phase decisions
  `D-20..`, acceptance rows `<PREFIX>-AC-01..`, risks by row. Reference by ID, never by prose.
- **Verified vs unverified**: tag facts as **(verificado YYYY-MM-DD)**, **(no verificado)** or
  **(nuevo)**. Verified means read in the repo or measured by a test run that day.
- **Non-goals are mandatory** (table: excluded item, reason). Say what the spec will NOT do.
- **Open questions** live in the spec until closed; an approved spec has none open.
- **Acceptance criteria are measurable**: observable result at a module boundary, in a matrix
  (ID, case, required result). Given/When/Then is allowed inside "Caso" when setup matters.
- **Traceability**: each decision maps to at least one acceptance row; each phase lists the AC
  IDs it closes; each AC maps to a test file.
- **Phases leave the repo green**: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`,
  `pnpm test:cli`, `pnpm test:compiled`, `pnpm pack:check`, `pnpm docs:check`, `pnpm docs:build`.
- Language: specs follow the repo precedent (Spanish prose); identifiers, error codes and
  generated strings in English; UI text in EN and ES.
- Architecture claims name patterns and their reason (hexagonal ports, strategy, etc.) only when
  they carry a decision. Prefer an ADR-style row (context, decision, consequence) in the decision tables.

## 6. Spec skeleton (derived from `specs/archive/009-forja-v1.md`)

1. **Title**: `# Especificación Técnica: <Name> — <one-line scope>`.
2. **Header table** (`| Campo | Valor |`): Versión, Origen (if from research), Proyecto, Estado
   (`Borrador` / `Aprobada por el propietario (fecha)` / `NO implementada` /
   `Implementada (fases X-Y)`), Fecha, Paquetes afectados (with new files/types), Paquetes nuevos,
   Relación con otras especificaciones (depends / complements / independent, by path),
   Superficies (web, TUI, headless, HTTP), Política de versión.
3. **0. Cómo usar este documento (para agentes de código)**: read `AGENTS.md` and
   `CONTRIBUTING.md` first; label legend; strict TDD; mandatory phase order and gates; the green
   command list; repo rules that never break; no commit until the owner asks; model assignment
   pointer; language rules.
4. **1. Objetivo, alcance y principio rector** (goal, guiding principle, scope, **fuera de
   alcance** table).
5. **2. Decisiones**: 2.1 owner decisions (O#, confirmed, applied exactly); 2.2 design decisions
   (D#, binding); 2.3+ decisions closed by phase-0 findings or reviews.
6. **3. Estado actual del código (verificado fecha)**: table Área / Realidad with real paths,
   symbols, limits. Gaps found by auditing are stated as known defects, not hidden.
7. **4. Arquitectura**: overview diagram, patterns table (pattern, where, why), module layout.
8. **5..N. Contracts and design sections**: types (additive in `@alisio/sdk`), protocol,
   persistence (additive migrations), configuration, surfaces (web, TUI, headless, API).
9. **Pruebas**: Rojo-Verde-Refactor rules, acceptance matrix, mutation-testing scope (section 8).
10. **Asignación de modelos** (which steps use Opus; everything else Sonnet).
11. **Fases**: phase 0 (experiments and measurements, no production code) then a gate (owner
    review), then numbered phases, each: files, tests, AC IDs closed, ends green.
12. **Definición de terminado**: bullet list tied to AC IDs, docs EN/ES with screenshots when
    the Web UI changes, `docs/implementation-status.md` updated.
13. **Riesgos y límites conocidos**: table Riesgo / Decisión (mitigation or accepted limit).

Smaller specs may merge sections but MUST keep: header table, objective, non-goals, decisions
with IDs, verified current state, acceptance matrix, phases, definition of done, risks.

## 7. Workflow: "execute spec <path>"

1. `sonnet` (or inline if 1-3 files): **audit before coding**. For each phase, check the repo
   for what already exists. The spec may already be implemented or partly drifted; compare its
   section "Estado actual" against the code and report differences before any edit.
2. Confirm Estado is approved and no open question blocks the phase. If not, stop and ask the
   owner (one question).
3. Run phase 0 and its gate first if the spec has one.
4. One `sonnet` writer per phase, TDD (section 8), one phase at a time, repo green at the end.
   `opus` only where the spec names an Opus gate.
5. Update `docs/implementation-status.md` (limitations, verification scope) and the docs EN/ES.
6. When all phases close: `haiku` archives (section 1). Do not commit until the owner asks.

## 8. Test strategy (for specs and implementation)

Principle: test what adds confidence per unit of cost, through public behavior.

- Test **behavior at module boundaries** (public function, tool, route, event), not internals.
  Prefer real dependencies when cheap (real SQLite, real QuickJS); mock only slow, external or
  nondeterministic systems.
- Write tests for: core logic and state machines, contracts and schemas, security and permission
  boundaries, previously found regressions, edge cases listed in the acceptance matrix, error
  paths with defined codes.
- **Characterization tests first** when moving or refactoring legacy code: pin current behavior
  (known defects flagged as "fallo conocido"), then change.
- **Red -> Green -> Refactor**: the red test fails for the right reason (not a missing import);
  green is the minimum code; refactor adds no behavior.
- **Mutation testing lite**: Stryker with narrow `mutate` on small pure-logic modules (limits,
  state machines, protocol parsers), `testRunner: "command"`, outside CI, bounded time budget.
  Add tests only for survivors that reveal a real behavior gap, never to kill trivial mutants.
- Slow or real-dependency tests (Docker, network, Pyodide, browsers) sit behind env flags and
  are skipped by default with a clear message.
- Pyramid vs trophy is a heuristic, not a rule: pure logic gets unit tests; wiring between
  modules gets integration tests; a few end-to-end tests cover critical user journeys.

**Do NOT test**: trivial getters/setters and plain glue; third-party library behavior; private
helpers or call order (no asserts on internal calls); constants and config shape restated in the
test; snapshot or golden tests that merely restate implementation (existing dashboard goldens
stay untouched); CSS or markup details with no behavior; the same case at three layers.

**Risk rule of thumb**: score each behavior by (impact if wrong) x (likelihood of change or
bug). High (permissions, data loss, persistence, public contracts): test the happy path, every
failure mode and the boundary, plus mutation check if pure. Medium: happy path plus the main
edge case at the boundary. Low (cosmetic, thin glue): no test, rely on typecheck and lint.

## 9. Checklist: spec ready to execute

- [ ] Estado is approved by the owner (date) and no open questions remain.
- [ ] Header table complete; relations to other specs name paths that exist (archive paths fixed).
- [ ] Number and filename follow section 2 (or legacy name kept).
- [ ] Objective and non-goals stated; scope fits phases.
- [ ] Every decision has an ID; owner decisions are marked confirmed.
- [ ] "Estado actual" checked against code on a stated date; claims tagged verificado / no verificado / nuevo.
- [ ] Requirements use RFC 2119 keywords with a measurable value where quality is claimed.
- [ ] Acceptance matrix covers every decision and every non-trivial failure mode; each row observable.
- [ ] Test strategy names mutation scope (or says none) and env-flagged slow tests.
- [ ] Phase 0 / gates defined where uncertainty is high; each phase lists files, AC IDs and ends green.
- [ ] Model assignment lists Opus gates; the rest is Sonnet; bookkeeping is Haiku.
- [ ] Definition of done includes docs EN/ES parity and `docs/implementation-status.md`.
- [ ] Risks table lists accepted limits honestly (no absolute security claims).

## References

- RFC 2119, key words for requirement levels: https://www.rfc-editor.org/info/rfc2119/ (clarified by RFC 8174: https://www.rfc-editor.org/info/rfc8174)
- EARS, Easy Approach to Requirements Syntax (INCOSE intro): https://www.incose.org/docs/default-source/working-groups/requirements-wg/rwg_iw2022/mav_ears_incoserwg_jan22.pdf
- EARS plus RFC 2119 for agent-era specs: https://joshmcdonald.medium.com/ears-fifteen-years-on-the-requirements-format-built-for-the-agent-era-0f78f8ff35a0
- Given/When/Then (Martin Fowler): https://martinfowler.com/bliki/GivenWhenThen.html
- Architecture Decision Records (ADR, MADR): https://adr.github.io/
- Testing strategies (pyramid, diamond, trophy), web.dev: https://web.dev/articles/ta-strategies
- The Testing Trophy (Kent C. Dodds): https://kentcdodds.com/blog/the-testing-trophy-and-testing-classifications
- Mutation testing with Stryker: https://stryker-mutator.io/docs/
