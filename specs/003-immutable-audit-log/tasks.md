# Tasks: Sistema de Auditoría Estructurada e Inmutable

**Input**: Design documents from `specs/003-immutable-audit-log/` (`spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`)  
**Prerequisites**: `plan.md` (completed), `spec.md` (completed with US1, US2, US3), `data-model.md`, `contracts/audit.contract.ts`

**Tests**: Included as part of adversarial testing (Constitution Principle VI) and independent story verification.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure for the audit subsystem.

- [X] T001 Setup audit contract interfaces and type definitions in `src/contracts/audit.contract.ts` copying and adapting definitions from `specs/003-immutable-audit-log/contracts/audit.contract.ts`
- [X] T002 Add `AuditPersistenceError` and `AuditIntegrityViolationError` error classes with code and details in `src/core/errors.ts`
- [X] T003 [P] Add test script entries (`test:audit`, `audit:verify`) and binary shortcut in `package.json`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core cryptographic hashing, canonical serialization and error handling required by all stories.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T004 Implement canonical deterministic JSON serialization with lexicographical key sorting in `src/core/audit/audit-canonicalizer.ts`
- [X] T005 [P] Implement chained SHA-256 integrity hash calculation `SHA-256(previousHash + canonicalJson)` and genesis block initialization in `src/core/audit/audit-hasher.ts`
- [X] T006 Unit tests for canonical serialization and SHA-256 hash chaining in `tests/unit/audit-hasher.spec.ts`

**Checkpoint**: Foundation ready - user story implementation can now begin.

---

## Phase 3: User Story 1 - Registro Estructurado de Todo el Ciclo de Vida de Consultas (Priority: P1) 🎯 MVP

**Goal**: Capturar cada petición de consulta recibida por el MCP en un registro JSON estructurado que registre correlación, identidad, tiempo ISO, motor/BD, SQL evaluado, estado final (`EXECUTED`, `REJECTED_BY_GUARD`, `BLOCKED_BY_COST`, `PENDING_APPROVAL`, `CANCELLED_BY_TIMEOUT`), motivo de rechazo, tiempo de ejecución y cantidad de filas devueltas.

**Independent Test**: Simular 5 peticiones que representen cada uno de los 5 estados finales posibles y verificar que se generen exactamente 5 entradas JSON válidas con todos los campos obligatorios completos y precisos.

### Tests for User Story 1

- [X] T007 [P] [US1] Unit and contract tests for structured log generation across all 5 outcomes in `tests/unit/audit-logger.spec.ts`

### Implementation for User Story 1

- [X] T008 [US1] Implement append-only sequential file writer and mutex queue in `src/core/audit/audit-logger.ts` supporting `logEvent(event)` and monotonic `sequenceNumber`
- [X] T009 [US1] Implement fail-closed error handling in `src/core/audit/audit-logger.ts` that throws `AuditPersistenceError` when file writing fails
- [X] T010 [US1] Integrate audit logging lifecycle into MCP tool dispatchers (`query_database`, `explain_query`, `introspect_schema`) in `src/index.ts` capturing execution timing, requester session ID, correlation UUID and outcome

**Checkpoint**: At this point, User Story 1 is fully functional and delivers the core audit logging capability (MVP).

---

## Phase 4: User Story 2 - Protección Estricta contra Filtración de Parámetros y Resultados en Logs (Priority: P1)

**Goal**: Garantizar que los valores reales de los parámetros de consulta y los datos de las filas jamás se escriban en crudo dentro del log, y sanitizar exhaustivamente literales numéricos y de cadena incrustados en sentencias SQL.

**Independent Test**: Ejecutar consultas parametrizadas con datos confidenciales (DPI, salarios, correos) y consultas con literales incrustados en cláusulas `WHERE`, comprobando que 0% de los datos crudos aparezcan en el log de auditoría.

### Tests for User Story 2

- [X] T011 [P] [US2] Adversarial unit tests for SQL literal redaction and parameter exclusion in `tests/unit/sql-sanitizer-for-audit.spec.ts`

### Implementation for User Story 2

- [X] T012 [US2] Implement `SqlSanitizerForAudit` in `src/core/audit/sql-sanitizer.ts` replacing string literals with `'[REDACTED_LITERAL]'`, numeric constants in predicates with `[REDACTED_NUM]`, parameter values with `[REDACTED_PARAM]`, and enforcing 16 KB truncation limit with `[TRUNCATED]`
- [X] T013 [US2] Integrate `SqlSanitizerForAudit` into `AuditLogger` and `src/index.ts` so `evaluatedSql` is always sanitized before hashing and writing to disk
- [X] T014 [US2] Verify that raw result rows and column values are discarded from audit payloads, writing only the numeric `rowCount` to `src/core/audit/audit-logger.ts`

**Checkpoint**: At this point, User Stories 1 AND 2 work together, guaranteeing zero sensitive data leaks in audit logs.

---

## Phase 5: User Story 3 - Inmutabilidad, Rotación y Verificación de Integridad (Priority: P2)

**Goal**: Proveer persistencia inmutable en modo append-only con rotación diaria (`audit-YYYY-MM-DD.jsonl`) y por tamaño (100 MB) preservando el encadenamiento de hash, acompañado de un comando CLI forense `audit-verify` para validar la integridad del archivo.

**Independent Test**: Ejecutar el comando `audit-verify` sobre un log intacto y verificar que reporte éxito; luego alterar deliberadamente un campo o eliminar una línea intermedia y comprobar que detecte la violación y el número de línea exacto.

### Tests for User Story 3

- [X] T015 [P] [US3] Unit tests for integrity chain verification and tamper detection in `tests/unit/audit-verifier.spec.ts`
- [X] T016 [P] [US3] Unit tests for log rotation by date and size limit in `tests/unit/audit-rotation.spec.ts`

### Implementation for User Story 3

- [X] T017 [US3] Implement file rotation logic (by date and 100 MB threshold) in `src/core/audit/audit-rotator.ts` ensuring the first entry of the new file inherits `previousHash` from the previous file
- [X] T018 [US3] Implement `AuditVerifier` in `src/core/audit/audit-verifier.ts` to parse NDJSON lines, check monotonic sequence continuity, and re-compute chained SHA-256 hashes
- [X] T019 [US3] Create CLI executable script `src/bin/audit-verify.ts` with process exit codes (0 for OK, 1 for tampered) and human-readable diagnostic output

**Checkpoint**: All user stories are independently functional and verifiable.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Export clean contracts, build verification, and end-to-end documentation validation.

- [X] T020 [P] Export all audit interfaces, classes and types in `src/index.ts`
- [X] T021 Run `npm run typecheck` and verify TypeScript compilation in strict mode without errors
- [X] T022 Execute quickstart validation guide scenarios per `specs/003-immutable-audit-log/quickstart.md`
- [X] T023 Update README.md documenting the audit logging subsystem, environment variables (`AUDIT_LOG_PATH`), and `audit-verify` CLI usage

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately.
- **Foundational (Phase 2)**: Depends on Setup (T001-T003) - BLOCKS all user stories.
- **User Story 1 (Phase 3)**: Depends on Phase 2 completion.
- **User Story 2 (Phase 4)**: Depends on Phase 2 completion; integrates with Phase 3 logger.
- **User Story 3 (Phase 5)**: Depends on Phase 2 completion; integrates with Phase 3 & 4.
- **Polish (Phase 6)**: Depends on all user stories (US1, US2, US3) being complete.

### User Story Dependencies

- **US1 (P1)**: Foundational logging lifecycle (MVP).
- **US2 (P1)**: Sanitization of SQL & redaction (can proceed immediately after Foundational & US1 logger core).
- **US3 (P2)**: Verifier CLI and log rotation (consumes output generated by US1 & US2).

### Parallel Opportunities

- Within Phase 1: `T003` can run in parallel with `T001` and `T002`.
- Within Phase 2: `T004` and `T005` can run in parallel.
- Within Phase 3 (US1): Test `T007` can be written before/parallel to logger implementation `T008`.
- Within Phase 4 (US2): Test `T011` can run in parallel with `T012`.
- Within Phase 5 (US3): `T015` and `T016` can run in parallel; `T017` and `T018` can be developed in parallel.
- Within Phase 6: `T020` and `T023` can run in parallel.

---

## Implementation Strategy

### MVP First (User Story 1 Only)
1. Complete Phase 1: Setup (`T001` - `T003`)
2. Complete Phase 2: Foundational (`T004` - `T006`)
3. Complete Phase 3: User Story 1 (`T007` - `T010`)
4. **STOP and VALIDATE**: Verify that every MCP query produces an immutable structured JSON entry with all mandatory fields and accurate timing/row count.

### Incremental Delivery
1. Foundation & Setup -> Core cryptographic primitives and interfaces ready.
2. User Story 1 -> Full query lifecycle logged with 5 outcomes (MVP).
3. User Story 2 -> Total redaction of literals, parameters, and zero sensitive data leakage.
4. User Story 3 -> Daily/size rotation and CLI tool `audit-verify` for tamper detection.
5. Polish -> Typecheck, Quickstart verification and documentation.
