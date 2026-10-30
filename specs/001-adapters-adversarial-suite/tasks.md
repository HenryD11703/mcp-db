---

description: "Task list for Base Arquitectónica de Adaptadores y Suite Adversaria de Seguridad"
---

# Tasks: Base Arquitectónica de Adaptadores y Suite Adversaria de Seguridad

**Input**: Design documents from `/specs/001-adapters-adversarial-suite/`

**Prerequisites**: [plan.md](./plan.md) (required), [spec.md](./spec.md) (required for user stories), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: Included as mandatory deliverables required by `spec.md` (`FR-009` a `FR-013`) and Project Constitution Principle VI (Desarrollo Guiado por Pruebas Adversarias).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., `US1`, `US2`, `US3`)
- Includes exact file paths and verbatim data-model constraints in descriptions

## Path Conventions

- **Single modular project**: `src/contracts/`, `src/core/`, `src/adapters/`, `corpus/`, `tests/` at repository root

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Inicialización del proyecto Node.js + TypeScript en modo estricto y configuración de ejecución automatizada en CI.

- [X] T001 Initialize Node.js TypeScript project with `@modelcontextprotocol/sdk`, `node-sql-parser`, `pg`, `mssql`, `zod`, `vitest`, and npm scripts (`build`, `typecheck`, `test`, `test:adversarial`, `test:contract`) in `package.json`
- [X] T002 [P] Configure TypeScript compiler with strict mode enabled (`"strict": true`, `"noUncheckedIndexedAccess": true`, `"target": "ES2022"`, `"module": "NodeNext"`) in `tsconfig.json`
- [X] T003 [P] Configure Vitest test runner for unit, adversarial, and contract test suites in `vitest.config.ts`
- [X] T004 [P] Create GitHub Actions CI workflow running `npm run typecheck`, `npm run test:adversarial`, and `npm test` on every push and pull request in `.github/workflows/ci.yml`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Contratos formales en TypeScript estricto, errores tipados del dominio y esquema de validación del corpus adversario que bloquean todas las historias de usuario.

**⚠️ CRITICAL**: Ninguna historia de usuario puede comenzar hasta completar esta fase.

- [X] T005 Define `DatabaseAdapter` contract and domain entities (`EngineDialect` as `'tsql' | 'postgres'`, `CorpusDialect` as `'tsql' | 'postgres' | 'common'`, `AttackVectorId` covering `V01_STACKED_QUERIES` to `V10_SESSION_OR_INTERNAL_CMD`, `ReadOnlyVerificationResult` where `isReadOnly` is `true` únicamente si `violations.length === 0` and `checkedAt` is ISO-8601, `NormalizedRiskProfile` with boolean `hasFullScan`, boolean `hasUnconditionalJoin`, `estimatedRows >= 0`, and native `estimatedCost >= 0`, `QueryParameter` with `type: 'string' | 'number' | 'boolean' | 'date' | 'null'`, `ParameterizedQuery` with non-empty `sql`, `params`, optional `signal?: AbortSignal`, and optional `maxRows > 0`, `QueryExecutionResult` with `rowCount >= 0` and `durationMs >= 0`, `SchemaCatalog` with `TableMetadata.kind: 'TABLE' | 'VIEW'`, and `SqlParserCandidate`) in `src/contracts/database-adapter.ts`
- [X] T006 [P] Implement domain error hierarchy (`ReadOnlyPrivilegeError`, `SqlSecurityRejectionError`, `QueryPlanAnalysisError`, `QueryCancelledError`) without exposing credentials or sensitive infrastructure details in `src/core/errors.ts`
- [X] T007 [P] Create JSON Schema and runtime Zod validator for the adversarial corpus enforcing `minimumVectorsRequired: 10`, `minItems: 30`, `id` matching `^(ADV-V(0[1-9]|10)-\d{3}|CTL-SEL-\d{3})$`, `dialect` in `'tsql' | 'postgres' | 'common'`, `expectedOutcome` in `'REJECT' | 'ALLOW'`, and mandatory `expectedReasonCode` when `expectedOutcome === 'REJECT'` in `corpus/adversarial-corpus.schema.json` and `src/core/validation/corpus-schema.ts`

**Checkpoint**: Contratos base, errores y validador de esquema del corpus listos — comienza la implementación de historias de usuario.

---

## Phase 3: User Story 1 - Validación Continua contra el Corpus Adversario de Seguridad (Priority: P1) 🎯 MVP

**Goal**: Disponer de un corpus estructurado con los 10 vectores de ataque obligatorios y un validador léxico + AST en TypeScript que bloquee el 100% de los ataques en CI sin falsos positivos en consultas `SELECT` legítimas, permitiendo comparar objetivamente parsers candidatos.

**Independent Test**: Cargar `corpus/adversarial-attacks.json` y ejecutar `npm run test:adversarial` para comprobar que el 100% de los casos de los 10 vectores sean rechazados con su código de razón y el 100% de los casos `CONTROL_VALID_SELECT` sean permitidos tanto en `tsql` como en `postgres`.

### Tests for User Story 1 (TDD Adversario — escribir y verificar fallo antes de implementar) ⚠️

- [X] T008 [P] [US1] Create structured adversarial attack corpus with at least 3 variants for each of the 10 mandatory vectors (`V01_STACKED_QUERIES`, `V02_SELECT_INTO`, `V03_COMMENT_OBFUSCATION`, `V04_MUTATING_CTE`, `V05_DANGEROUS_FUNCTIONS`, `V06_EXPLICIT_LOCKING`, `V07_REMOTE_LINKED_ACCESS`, `V08_TSQL_IMPLICIT_EXEC`, `V09_DELAY_DOS`, `V10_SESSION_OR_INTERNAL_CMD`, minimum 30 attack cases with `expectedOutcome: "REJECT"`) plus legitimate `CONTROL_VALID_SELECT` queries (`expectedOutcome: "ALLOW"`, including string literals containing `--` and `SELECT INTO`) in `corpus/adversarial-attacks.json`
- [X] T009 [P] [US1] Write unit tests for the string-aware lexical scanner verifying strict rejection of `--` and `/* */` outside literals while preserving valid string literals (`'Texto con -- guiones y SELECT INTO'`) in `tests/unit/lexical-scanner.spec.ts`
- [X] T010 [P] [US1] Write CI adversarial corpus runner test asserting schema compliance, coverage of all 10 mandatory vectors, 100% rejection of attack cases (`SC-001`), and 100% acceptance of `CONTROL_VALID_SELECT` cases (`SC-002`) in `tests/adversarial/corpus-runner.spec.ts`
- [X] T011 [P] [US1] Write parser candidate evaluation test comparing baseline `node-sql-parser` (unhardened) vs `HardenedAstValidator` across the 10 attack vectors in `tests/adversarial/parser-candidates.spec.ts`

### Implementation for User Story 1

- [X] T012 [US1] Implement string-aware lexical scanner detecting and strictly rejecting inline/block comments outside string literals (`V03_COMMENT_OBFUSCATION`), stacked queries with `;` (`V01_STACKED_QUERIES`), T-SQL implicit execution without semicolons (`V08_TSQL_IMPLICIT_EXEC`), delay DoS commands `WAITFOR DELAY`/`WAITFOR TIME` (`V09_DELAY_DOS`), and session/internal commands `SET`/`DBCC` (`V10_SESSION_OR_INTERNAL_CMD`) in `src/core/validation/lexical-scanner.ts`
- [X] T013 [US1] Implement `HardenedAstValidator` (`SqlParserCandidate`) combining `lexical-scanner.ts` with `node-sql-parser` (`transactsql` and `postgresql` dialects) to enforce root `SELECT` AST only, reject `SELECT INTO` (`V02_SELECT_INTO`), mutating CTEs `WITH ... INSERT/UPDATE/DELETE RETURNING` (`V04_MUTATING_CTE`), dangerous functions like `pg_terminate_backend`, `pg_cancel_backend`, `pg_read_file`, `pg_ls_dir`, `lo_import`, `lo_export`, `pg_sleep` (`V05_DANGEROUS_FUNCTIONS`, `V09_DELAY_DOS`), explicit row/table locking `FOR UPDATE`/`FOR SHARE`/locking hints (`V06_EXPLICIT_LOCKING`), and `OPENQUERY`/`OPENROWSET`/`OPENDATASOURCE`/4-part object names (`V07_REMOTE_LINKED_ACCESS`) in `src/core/validation/ast-validator.ts`
- [X] T014 [US1] Implement parser candidate benchmark runner (`evaluateParserCandidates`) producing per-vector pass/fail metrics and markdown summary table in `src/core/validation/parser-benchmark.ts`

**Checkpoint**: User Story 1 completa y verificable de forma autónoma mediante `npm run test:adversarial`.

---

## Phase 4: User Story 2 - Operación Unificada en SQL Server y PostgreSQL mediante Contrato de Adaptador (Priority: P1)

**Goal**: Implementar los adaptadores iniciales para PostgreSQL y SQL Server (T-SQL) cumpliendo las 4 operaciones del contrato `DatabaseAdapter` y superando exactamente la misma suite compartida de pruebas de contrato y seguridad.

**Independent Test**: Ejecutar `npm run test:contract` para validar que `PostgresAdapter` y `SqlServerAdapter` superen idénticamente las pruebas de *preflight check* de solo lectura, normalización de plan de ejecución (`NormalizedRiskProfile`), ejecución parametrizada con cancelación nativa `< 1s` por `AbortSignal`, e introspección de esquema.

### Tests for User Story 2 ⚠️

- [X] T015 [P] [US2] Create shared parameterized contract test suite `runDatabaseAdapterContractSuite` verifying `verifyReadOnly`, `analyzeQueryPlan`, `executeQuery` (typed params + `< 1s` native `AbortSignal` cancellation + pre/post abort race conditions), and `introspectSchema` in `tests/contract/database-adapter.shared.ts`
- [X] T016 [P] [US2] Write unit tests for PostgreSQL `EXPLAIN (FORMAT JSON)` and SQL Server `SHOWPLAN_XML` plan parsers verifying `hasFullScan`, `hasUnconditionalJoin`, `estimatedRows >= 0`, and native `estimatedCost >= 0` in `tests/unit/plan-normalizers.spec.ts`

### Implementation for User Story 2

- [X] T017 [P] [US2] Implement PostgreSQL execution plan normalizer transforming `EXPLAIN (FORMAT JSON)` output into `NormalizedRiskProfile` (`Seq Scan` -> `hasFullScan: true`, join without condition -> `hasUnconditionalJoin: true`, `Plan Rows` -> `estimatedRows`, native `Total Cost` -> `estimatedCost`) in `src/adapters/postgres/postgres-plan-parser.ts`
- [X] T018 [P] [US2] Implement SQL Server execution plan normalizer transforming `SHOWPLAN_XML` `<RelOp>` nodes into `NormalizedRiskProfile` (`Table Scan`/`Clustered Index Scan` without seek predicate -> `hasFullScan: true`, `NoJoinPredicate` -> `hasUnconditionalJoin: true`, `EstimateRows` -> `estimatedRows`, native `EstimatedTotalSubtreeCost` -> `estimatedCost`) in `src/adapters/sqlserver/sqlserver-plan-parser.ts`
- [X] T019 [US2] Implement `PostgresAdapter` (`verifyReadOnly` inspecting effective privileges across roles, `public` schema, and user tables plus enforcing `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`; `analyzeQueryPlan` using `EXPLAIN (FORMAT JSON)`; `executeQuery` with typed parameters and native backend cancellation on `AbortSignal`; `introspectSchema` querying `information_schema` and `pg_catalog` without reading user rows) in `src/adapters/postgres/postgres-adapter.ts`
- [X] T020 [US2] Implement `SqlServerAdapter` (`verifyReadOnly` inspecting `IS_SRVROLEMEMBER`, `IS_ROLEMEMBER`, and `sys.fn_my_permissions` across database/schemas/tables; `analyzeQueryPlan` using isolated `SET SHOWPLAN_XML ON/OFF`; `executeQuery` with typed parameters and native TDS `request.cancel()` bound to `AbortSignal`; `introspectSchema` querying `sys.tables`, `sys.views`, `sys.columns`, and `sys.foreign_keys` without reading user rows) in `src/adapters/sqlserver/sqlserver-adapter.ts`
- [X] T021 [P] [US2] Implement PostgreSQL contract test runner executing `runDatabaseAdapterContractSuite` against `PostgresAdapter` in `tests/contract/postgres-adapter.contract.spec.ts`
- [X] T022 [P] [US2] Implement SQL Server contract test runner executing `runDatabaseAdapterContractSuite` against `SqlServerAdapter` in `tests/contract/sqlserver-adapter.contract.spec.ts`

**Checkpoint**: User Stories 1 y 2 operativas e independientemente verificables (`PostgresAdapter` y `SqlServerAdapter` pasan la misma suite compartida).

---

## Phase 5: User Story 3 - Extensibilidad para Nuevos Motores sin Modificar el Núcleo (Priority: P2)

**Goal**: Garantizar que un contribuidor pueda registrar un nuevo motor implementando `DatabaseAdapter` y validarlo con el núcleo y la suite de pruebas con 0 líneas modificadas en `src/core/`.

**Independent Test**: Ejecutar `tests/contract/extensibility.contract.spec.ts` con un tercer adaptador conforme a `DatabaseAdapter` y verificar que `AdapterRegistry` y el flujo del núcleo operen sin modificar `src/core/` y sin que `src/core/` tenga ningún `import` hacia `src/adapters/`, `pg` o `mssql`.

### Tests for User Story 3 ⚠️

- [X] T023 [P] [US3] Write extensibility and architectural boundary contract test (registering a 3rd synthetic relational adapter via `AdapterRegistry`, running `runDatabaseAdapterContractSuite`, and statically asserting zero imports of `pg`, `mssql`, or `src/adapters/` inside `src/core/`) in `tests/contract/extensibility.contract.spec.ts`

### Implementation for User Story 3

- [X] T024 [US3] Implement engine-agnostic `AdapterRegistry` and startup preflight guard (`registerAdapter`, `initializeAllWithPreflight`, `validateAndExplain`, `validateAndExecute`) depending strictly on `DatabaseAdapter` and `SqlParserCandidate` in `src/core/engine-registry.ts`
- [X] T025 [US3] Implement MCP server entry point and public module exports wiring `AdapterRegistry`, `HardenedAstValidator`, `PostgresAdapter`, and `SqlServerAdapter` in `src/index.ts`

**Checkpoint**: Las 3 historias de usuario funcionan de forma independiente y cumplen todos los criterios de éxito (`SC-001` a `SC-005`).

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentación de resultados de evaluación de parsers en el repositorio y validación integral de `quickstart.md`.

- [X] T026 [P] Generate and save the reproducible SQL parser benchmark report across all 10 adversarial vectors in `docs/parser-evaluation-report.md`
- [X] T027 Run full validation suite (`npm run typecheck`, `npm run test:adversarial`, `npm run test:contract`, `npm test`, `npm run build`) verifying all scenarios in `specs/001-adapters-adversarial-suite/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Sin dependencias — comienza de inmediato (`T001` → `T002`, `T003`, `T004`).
- **Foundational (Phase 2)**: Depende de Phase 1 — **BLOQUEA** todas las historias de usuario (`T005`, `T006`, `T007`).
- **User Story 1 (Phase 3 - P1 MVP)**: Depende únicamente de Phase 2 (`T008`..`T014`).
- **User Story 2 (Phase 4 - P1)**: Depende de Phase 2 (`T015`..`T022`); puede ejecutarse en paralelo con US1 o inmediatamente después.
- **User Story 3 (Phase 5 - P2)**: Depende de Phase 2 y se integra con el validador de US1 y la suite compartida de US2 (`T023`..`T025`).
- **Polish (Phase 6)**: Depende de completar las fases 3, 4 y 5 (`T026`, `T027`).

### User Story Dependencies

- **User Story 1 (P1)**: Independiente de US2 y US3. Entrega el corpus adversario estructurado, el validador léxico+AST y el evaluador de parsers en CI.
- **User Story 2 (P1)**: Independiente de US3; implementa `PostgresAdapter`, `SqlServerAdapter` y la suite compartida `runDatabaseAdapterContractSuite`.
- **User Story 3 (P2)**: Valida el desacoplamiento total del núcleo (`AdapterRegistry`) frente a nuevos motores utilizando la suite de contrato.

### Parallel Opportunities

- **Phase 1**: `T002`, `T003` y `T004` pueden ejecutarse en paralelo tras `T001`.
- **Phase 2**: `T006` y `T007` pueden ejecutarse en paralelo con `T005`.
- **Phase 3 (US1)**: `T008`, `T009`, `T010` y `T011` pueden escribirse en paralelo antes de `T012`–`T014`.
- **Phase 4 (US2)**: `T015` y `T016` en paralelo; `T017` (Postgres plan parser) y `T018` (SQL Server plan parser) en paralelo; `T021` y `T022` en paralelo.

---

## Parallel Example: User Story 1 & User Story 2

```bash
# Paralelización en User Story 1 (Creación de corpus y pruebas adversarias):
Task: "T008 [P] [US1] Create structured adversarial attack corpus in corpus/adversarial-attacks.json"
Task: "T009 [P] [US1] Write unit tests for the string-aware lexical scanner in tests/unit/lexical-scanner.spec.ts"
Task: "T010 [P] [US1] Write CI adversarial corpus runner test in tests/adversarial/corpus-runner.spec.ts"

# Paralelización en User Story 2 (Normalizadores de planes y pruebas de contrato por motor):
Task: "T017 [P] [US2] Implement PostgreSQL execution plan normalizer in src/adapters/postgres/postgres-plan-parser.ts"
Task: "T018 [P] [US2] Implement SQL Server execution plan normalizer in src/adapters/sqlserver/sqlserver-plan-parser.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Completar Phase 1: Setup (`T001`–`T004`).
2. Completar Phase 2: Foundational (`T005`–`T007`).
3. Completar Phase 3: User Story 1 (`T008`–`T014`).
4. **STOP & VALIDATE**: Ejecutar `npm run test:adversarial` y verificar que los 10 vectores de ataque sean rechazados al 100% y el benchmark de parsers funcione en CI.

### Incremental Delivery

1. Setup + Foundational → Contratos estrictos listos.
2. Agregar User Story 1 → Suite adversaria y validador SQL listos en CI (MVP de seguridad).
3. Agregar User Story 2 → Adaptadores `PostgresAdapter` y `SqlServerAdapter` validados bajo la misma suite de contrato.
4. Agregar User Story 3 → `AdapterRegistry` agnóstico y prueba de extensibilidad con un 3er adaptador sin tocar `src/core/`.
5. Polish → Reporte de evaluación de parsers en `docs/parser-evaluation-report.md` y verificación completa de `quickstart.md`.
