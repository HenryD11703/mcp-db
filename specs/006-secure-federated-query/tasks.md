---
description: "Task list for feature 006-secure-federated-query implementation"
---

# Tasks: Orquestador de Consulta Federada Segura entre Servidores Heterogéneos

**Input**: Design documents from `/specs/006-secure-federated-query/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md
**Tests**: Unit, integration, and adversarial tests are included per Constitution Principle VI (NON-NEGOTIABLE).
**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., [US1], [US2], [US3], [US4], [US5])
- Exact file paths included in all task descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization, types, contracts and shared error definitions

- [X] T001 Copy and register federated query contract in src/contracts/federated-query.contract.ts
- [X] T002 Extend AuditQueryOutcome with federated query events in src/contracts/audit.contract.ts
- [X] T003 [P] Define FederatedQueryError and FederatedKeyLimitExceededError in src/core/errors.ts

---

## Phase 2: Foundational (Core Modules & Engines)

**Purpose**: Core engines and utilities required by all federated query user stories

- [X] T004 [P] Implement SessionPseudonymContext with HMAC-SHA256 and ephemeral 32-byte salt in src/core/security/session-pseudonym.ts
- [X] T005 [P] Implement KeyExtractor with deduplication, null filtering, and 500-key limit in src/core/federation/key-extractor.ts
- [X] T006 [P] Implement ParameterBinder for replacing :keys with engine dialect parameter markers in src/core/federation/parameter-binder.ts
- [X] T007 [P] Implement InMemoryHashJoin for LEFT and INNER joins with target_<col> collision renaming in src/core/federation/memory-join.ts

**Checkpoint**: Core foundational utilities ready - user story implementations can begin

---

## Phase 3: User Story 1 - Consulta Federada Cruzada Segura entre Motores Heterogéneos (Priority: P1) 🎯 MVP

**Goal**: Coordinate and execute a cross-database query between PostgreSQL and SQL Server in memory without linked servers, joining results with in-memory hash join.

**Independent Test**: Execute a federated query between mock/live PostgreSQL (BD A) and SQL Server (BD B) using execute_federated_query tool, verifying successful execution, parameter injection, and consolidated tabular results.

### Tests for User Story 1
- [X] T008 [P] [US1] Unit test for InMemoryHashJoin covering LEFT and INNER join and column collision renaming in tests/unit/memory-join.test.ts
- [X] T009 [P] [US1] Unit test for base federated query execution flow across adapters in tests/unit/federated-orchestrator.test.ts

### Implementation for User Story 1
- [X] T010 [US1] Implement core FederatedQueryOrchestrator coordinating DatabaseAdapter instances in src/core/federation/federated-orchestrator.ts
- [X] T011 [US1] Implement empty source optimization (skip BD B when BD A has 0 rows) in src/core/federation/federated-orchestrator.ts
- [X] T012 [US1] Register and expose execute_federated_query tool with argument schema in src/core/tools/federated-tools.ts and src/bin/db-mcp.ts

**Checkpoint**: User Story 1 (MVP) is fully functional and testable independently.

---

## Phase 4: User Story 2 - Defensas Independientes de Solo Lectura, Guard AST y Control de Costo (Priority: P1)

**Goal**: Enforce independent AST guard checks, execution plan risk analysis, and read-only preflight verification on both source and target queries.

**Independent Test**: Submit federated queries where BD A or BD B contains mutating SQL, inline comments, or exceeds cost limits; verify immediate rejection before query execution.

### Tests for User Story 2
- [X] T013 [P] [US2] Unit test for independent AST guard validation on source and expanded target queries in tests/unit/federated-guard.test.ts
- [X] T014 [P] [US2] Integration test for plan-risk analysis and cost limits on federated queries in tests/integration/federated-cost-limits.test.ts

### Implementation for User Story 2
- [X] T015 [US2] Integrate independent SqlSecurityGuard validation for BD A and expanded BD B queries in src/core/federation/federated-orchestrator.ts
- [X] T016 [US2] Integrate QueryPlanRiskEvaluator and QueryExecutionSupervisor for cost analysis and real cancellation in src/core/federation/federated-orchestrator.ts
- [X] T017 [US2] Verify read-only status of both adapters via AdapterRegistry before query execution in src/core/federation/federated-orchestrator.ts

**Checkpoint**: User Stories 1 AND 2 are functional and enforce strict defense-in-depth security.

---

## Phase 5: User Story 3 - Mitigación contra Inyección SQL de Segundo Orden y Tope Estricto de Parámetros (Priority: P1)

**Goal**: Treat extracted keys as untrusted data, injecting them strictly as typed parameters, enforcing 500-key limit and configurable overflow handling.

**Independent Test**: Pass second-order SQL injection payloads in BD A key values and verify they are evaluated as literal parameters; test with >500 keys verifying truncation warning or rejection.

### Tests for User Story 3
- [X] T018 [P] [US3] Unit test for ParameterBinder parameter translation ($1... and @p1...) in tests/unit/parameter-binder.test.ts
- [X] T019 [P] [US3] Unit test for KeyExtractor deduplication, null filtering, truncation and overflowAction in tests/unit/key-extractor.test.ts
- [X] T020 [P] [US3] Adversarial test suite for second-order SQL injection prevention in tests/adversarial/second-order-sqli.test.ts

### Implementation for User Story 3
- [X] T021 [US3] Enforce typed parameter injection and zero-trust parameter binding in src/core/federation/federated-orchestrator.ts
- [X] T022 [US3] Implement truncation metadata warning and overflowAction: 'fail' rejection handling in src/core/federation/federated-orchestrator.ts

**Checkpoint**: User Stories 1, 2, and 3 provide full immunity against second-order SQL injection and parameter overflows.

---

## Phase 6: User Story 4 - Privacidad en Memoria y Pseudonimización Determinista por Sesión (Priority: P2)

**Goal**: Perform in-memory join with raw values, then apply session-deterministic pseudonymization (pseudo_<16_hex>) to sensitive join columns before client serialization.

**Independent Test**: Execute federated query with sensitive join keys; verify identical pseudo_<16_hex> values for matching keys, different pseudonyms in new sessions, and zero raw PII in output.

### Tests for User Story 4
- [X] T023 [P] [US4] Unit test for SessionPseudonymContext HMAC-SHA256, format validation, and cache in tests/unit/session-pseudonym.test.ts
- [X] T024 [P] [US4] Integration test for end-to-end dataset masking with deterministic join key pseudonymization in tests/integration/federated-masking.test.ts

### Implementation for User Story 4
- [X] T025 [US4] Integrate SessionPseudonymContext and DataMaskingEngine to pseudonymize join columns in src/core/federation/federated-orchestrator.ts

**Checkpoint**: User Story 4 ensures full memory privacy and prevents PII leakage to the LLM client.

---

## Phase 7: User Story 5 - Trazabilidad y Auditoría Estructurada Inmutable Vinculada (Priority: P2)

**Goal**: Emit immutable structured audit log entries for every federated step, linked by a unified federation_id (correlationId) without exposing raw sensitive keys.

**Independent Test**: Execute a federated query and inspect audit.jsonl, verifying all steps share the same correlationId and maintain a valid Merkle hash chain.

### Tests for User Story 5
- [X] T026 [P] [US5] Unit test for federated audit event creation and correlationId linking in tests/unit/federated-audit.test.ts
- [X] T027 [P] [US5] Integration test for audit hash chain verification with AuditVerifier in tests/integration/federated-audit-chain.test.ts

### Implementation for User Story 5
- [X] T028 [US5] Implement structured audit logging for all federated milestones with federation_id in src/core/federation/federated-orchestrator.ts

**Checkpoint**: User Story 5 provides full forensic traceability across heterogeneous servers.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: System integration, validation against quickstart scenarios, and release readiness

- [X] T029 [P] Validate all end-to-end scenarios against specs/006-secure-federated-query/quickstart.md
- [X] T030 [P] Export federated orchestrator, contracts, and schema from src/index.ts
- [X] T031 Run type checking and complete test suite verifying zero compiler errors and 100% passing tests in vitest.config.ts

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 completion - BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Phase 2 - MVP core functionality
- **User Story 2 (Phase 4)**: Depends on Phase 3 (extends orchestrator with security checks)
- **User Story 3 (Phase 5)**: Depends on Phase 3 & Phase 4 (parameter binder and key limits)
- **User Story 4 (Phase 6)**: Depends on Phase 3 (in-memory join output masking)
- **User Story 5 (Phase 7)**: Depends on Phase 3, 4, 5 (audit logging across all steps)
- **Polish (Phase 8)**: Depends on all user stories (Phases 3-7) being completed

### Parallel Opportunities

- Within Phase 1: T003 can run in parallel with T001 and T002.
- Within Phase 2: T004, T005, T006, T007 operate on completely separate files and can execute in parallel.
- Within each Story phase: All test tasks marked `[P]` can be implemented in parallel before story implementation tasks.
- Polish phase: T029 and T030 can run in parallel.

---

## Implementation Strategy

### MVP First (User Story 1 Only)
1. Complete Phase 1 (Setup) and Phase 2 (Foundational).
2. Complete Phase 3 (User Story 1).
3. Validate independent execution: PostgreSQL ↔ SQL Server base in-memory join works.

### Incremental Security & Hardening Delivery
1. Add User Story 2: AST Guard and Cost Limits independent protection.
2. Add User Story 3: Second-Order SQLi immunity and 500-key overflow handling.
3. Add User Story 4: Memory Privacy and HMAC-SHA256 `pseudo_<16_hex>` pseudonymization.
4. Add User Story 5: Immutable Audit trail linked by `federation_id`.
5. Execute Phase 8 (Polish & quickstart validation).
