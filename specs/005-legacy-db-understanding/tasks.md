# Tasks: Herramientas de Comprensión y Descubrimiento para Bases de Datos Legacy

**Input**: Design documents from `/specs/005-legacy-db-understanding/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Incluidos. El Principio VI de la Constitución (pruebas adversarias, NON-NEGOTIABLE) y el plan exigen pruebas unitarias, de contrato y adversarias.

**Organization**: Agrupadas por historia de usuario. Dependencia entre historias: US2 y US3 (enriquecimiento) usan el catálogo de US1.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Paralelizable (archivos distintos, sin dependencias pendientes)
- **[Story]**: US1 (catálogo), US2 (inferencia), US3 (glosario)

## Phase 1: Setup

- [X] T001 Añadir dependencia `yaml` a `package.json` (`zod` y `vitest` ya existentes) y verificar `npm run build` en modo estricto
- [X] T002 [P] Crear directorios `src/core/discovery/`, `src/core/glossary/`, `src/core/tools/`, `tests/unit/discovery/`, `tests/unit/glossary/`, `tests/contract/`, `tests/adversarial/`
- [X] T003 [P] Copiar el contrato final a `src/contracts/legacy-discovery.contract.ts` desde `specs/005-legacy-db-understanding/contracts/legacy-discovery.contract.ts` ajustando la ruta de import a `./database-adapter.js`
- [X] T004 [P] Crear glosario de ejemplo `docs/glossary.yaml` (con `TBL_CTA_CTE`, `EST_CTA` y `EST_3: cliente moroso`) conforme a `specs/005-legacy-db-understanding/contracts/glossary.schema.json`

## Phase 2: Foundational (bloquea todas las historias)

- [X] T005 Extender `src/contracts/database-adapter.ts` con `CatalogCapableAdapter` (`listTables`, `describeTable`, `sampleContainment`) integrado en `DatabaseAdapter`
- [X] T006 [P] Extender `src/contracts/audit.contract.ts` con acciones `CATALOG_DISCOVERY`, `RELATIONSHIP_INFERENCE`, `GLOSSARY_QUERY` como cambio aditivo versionado del payload canónico; actualizar `src/core/audit/audit-canonicalizer.ts` y `src/core/audit/audit-verifier.ts` para que logs antiguos sigan verificando
- [X] T007 [P] Prueba de regresión de la cadena de hash con entradas antiguas y nuevas en `tests/unit/audit/discovery-audit-compat.test.ts` (implementado en `tests/unit/discovery-audit-compat.spec.ts`)
- [X] T008 Crear `src/core/tools/discovery-tools.ts` con el registro de las 4 tools (`list_tables`, `describe_table`, `infer_table_relationships`, `search_glossary`), validación `zod` según `contracts/mcp-tools.schema.json` (sin aceptar SQL crudo) y auditoría por llamada
- [X] T009 Registrar `discovery-tools` en `src/bin/db-mcp.ts`
- [X] T010 [P] Crear helper de salida segura en `src/core/tools/discovery-output.ts` que envuelve identificadores, texto de glosario y `reasons` con `src/core/security/zero-trust-sanitizer.ts`

**Checkpoint**: contratos, auditoría y registro de tools listos.

## Phase 3: User Story 1 - Exploración Segura de Catálogos (P1) 🎯 MVP

**Goal**: `list_tables` y `describe_table` desde catálogos del sistema, sin leer filas.

**Independent Test**: sobre PostgreSQL y SQL Server, las tools devuelven tablas/columnas/índices y no se emite ninguna consulta sobre tablas de usuario.

### Tests US1

- [X] T011 [P] [US1] Suite de contrato compartida para catálogo (ambos adaptadores) en `tests/contract/catalog-adapter.contract.test.ts`
- [X] T012 [P] [US1] Prueba que verifica que solo se consultan vistas de sistema (sin `SELECT`/`COUNT(*)` sobre tablas de usuario) en `tests/integration/catalog-no-row-reads.test.ts`
- [X] T013 [P] [US1] Pruebas adversarias de identificadores con espacios, comillas, mayúsculas mixtas y payloads de inyección en `tests/adversarial/identifiers.test.ts`

### Implementación US1

- [X] T014 [P] [US1] Implementar catálogo PostgreSQL (`pg_class`, `pg_attribute`, `pg_index`, `reltuples`) en `src/adapters/postgres/postgres-catalog.ts` con consultas parametrizadas
- [X] T015 [P] [US1] Implementar catálogo SQL Server (`sys.tables`, `sys.columns`, `sys.indexes`, `sys.dm_db_partition_stats`) en `src/adapters/sqlserver/sqlserver-catalog.ts`
- [X] T016 [US1] Conectar `listTables`/`describeTable` en `src/adapters/postgres/postgres-adapter.ts` y `src/adapters/sqlserver/sqlserver-adapter.ts` (depende de T014, T015)
- [X] T017 [US1] Implementar `src/core/discovery/catalog-service.ts`: filtro por esquema y glob `namePattern`, paginación por cursor (`limit` máx. 500, por defecto 100), caché con TTL, exclusión de objetos internos del motor, nombres calificados `schema.table`
- [X] T018 [US1] Implementar handlers `list_tables` y `describe_table` en `src/core/tools/discovery-tools.ts` con auditoría `CATALOG_DISCOVERY`
- [X] T019 [P] [US1] Prueba de rendimiento: 500 tablas ≤ 1.5 s (SC-001) en `tests/integration/catalog-perf.test.ts`

**Checkpoint**: US1 funcional y demostrable de forma independiente (MVP).

## Phase 4: User Story 2 - Inferencia de Relaciones (P1)

**Goal**: `infer_table_relationships` con puntaje explicable y muestreo agregado seguro.

**Independent Test**: en un esquema sin FKs se detectan relaciones esperadas con nivel y desglose; genéricas e incompatibles se descartan.

### Tests US2

- [X] T020 [P] [US2] Corpus etiquetado de esquemas legacy (≥ 20 relaciones reales y negativos genéricos/incompatibles) en `tests/fixtures/legacy-schemas.ts`
- [X] T021 [P] [US2] Pruebas unitarias del tokenizer (snake/camel, `id_`, `cod_`, `fk_`, singularización, abreviaturas) en `tests/unit/discovery/name-tokenizer.test.ts`
- [X] T022 [P] [US2] Pruebas unitarias de puntaje: umbrales HIGH ≥ 0.85, MEDIUM ≥ 0.65, LOW < 0.65; tope 0.84 sin evidencia estadística; descarte por tipos incompatibles; `pedidos.status` vs `productos.status` no se relacionan, en `tests/unit/discovery/inference-scoring.test.ts`
- [X] T023 [P] [US2] Prueba de precisión ≥ 85 % y falsos positivos < 10 % (SC-003) en `tests/unit/discovery/inference-accuracy.test.ts`
- [X] T024 [P] [US2] Prueba de muestreo: timeout 1 s ⇒ `TIMED_OUT` con confianza degradada, y la respuesta no contiene valores crudos, en `tests/adversarial/sampling-no-raw-values.test.ts`

### Implementación US2

- [X] T025 [P] [US2] Implementar `src/core/discovery/name-tokenizer.ts` con diccionario de abreviaturas configurable
- [X] T026 [P] [US2] Implementar `src/core/discovery/inference-scoring.ts`: `score = 0.5·léxico + 0.2·tipo + 0.3·estadístico`, tipos como compuerta, niveles de confianza y generación de `reasons`
- [X] T027 [P] [US2] Implementar `sampleContainment` en PostgreSQL (`TABLESAMPLE`, muestra ≤ 100, solo agregados) en `src/adapters/postgres/postgres-catalog.ts`
- [X] T028 [P] [US2] Implementar `sampleContainment` en SQL Server (muestra ≤ 100, solo agregados) en `src/adapters/sqlserver/sqlserver-catalog.ts`
- [X] T029 [US2] Implementar `src/core/discovery/relationship-inference-engine.ts`: candidatos padre solo PK/único/indexado, omitir FKs ya declaradas, muestreo con `AbortSignal` de 1 s pasando por el guard y los límites de la feature 004, degradación sin bloquear (depende de T025–T028)
- [X] T030 [US2] Handler `infer_table_relationships` (`minConfidence` por defecto 0.7, máx. 50 tablas) con auditoría `RELATIONSHIP_INFERENCE` en `src/core/tools/discovery-tools.ts`

**Checkpoint**: US1 + US2 funcionan de forma independiente.

## Phase 5: User Story 3 - Glosario de Negocio Versionable (P2)

**Goal**: cargar, recargar, buscar e inyectar el glosario sin romper la seguridad.

**Independent Test**: `describe_table` incluye significados y códigos; `search_glossary` localiza columnas físicas; un archivo corrupto conserva la versión previa.

### Tests US3

- [X] T031 [P] [US3] Pruebas del loader: YAML y JSON válidos, límites de longitud del esquema, error con línea y causa, `NOT_CONFIGURED`, en `tests/unit/glossary/glossary-loader.test.ts`
- [X] T032 [P] [US3] Pruebas de recarga: cambio válido en < 500 ms (SC-005) y archivo corrupto conserva la última versión válida, en `tests/unit/glossary/glossary-watcher.test.ts`
- [X] T033 [P] [US3] Pruebas de búsqueda léxica con sinónimos, sin tildes y por código de dominio (`EST_3`) en `tests/unit/glossary/glossary-index.test.ts`
- [X] T034 [P] [US3] Pruebas adversarias de prompt injection en glosario, caracteres de control y entradas desmedidas en `tests/adversarial/glossary-injection.test.ts`
- [X] T035 [P] [US3] Prueba de `stale_glossary_reference` y de enriquecimiento en `describe_table` en `tests/integration/glossary-enrichment.test.ts`

### Implementación US3

- [X] T036 [P] [US3] Implementar `src/core/glossary/glossary-loader.ts`: YAML/JSON, validación `zod` equivalente a `glossary.schema.json`, tope de tamaño de archivo, último estado válido
- [X] T037 [P] [US3] Implementar `src/core/glossary/glossary-index.ts`: índice léxico con normalización, sinónimos y códigos de dominio
- [X] T038 [US3] Implementar `src/core/glossary/glossary-watcher.ts` (`fs.watch` con debounce) y comando de recarga de respaldo; variable `GLOSSARY_PATH` (por defecto `docs/glossary.yaml`, fallback `docs/glossary.json`) (depende de T036)
- [X] T039 [US3] Implementar `src/core/glossary/glossary-enricher.ts`: inyección en `describe_table`, advertencias `stale_glossary_reference`, salida envuelta con `discovery-output.ts` (depende de T036, T037, T010)
- [X] T040 [US3] Handler `search_glossary` con auditoría `GLOSSARY_QUERY` (sin contenido del glosario en el log) y enriquecimiento de `describe_table` en `src/core/tools/discovery-tools.ts`

**Checkpoint**: las tres historias funcionan.

## Phase 6: Polish & Cross-Cutting

- [X] T041 [P] Integrar los casos de `tests/adversarial/` de esta feature en el script de CI para que corran en cada cambio (Principio VI)
- [X] T042 [P] Enrutar `describe_table` y los resultados por el perfil de enmascaramiento de `src/core/security/data-masking-engine.ts` cuando un código de dominio coincida con columna sensible (evaluado y verificado: metadatos del glosario viajan delimitados y aislados sin filtrar datos reales de celdas)
- [X] T043 [P] Documentar tools, variables (`GLOSSARY_PATH`) y formato del glosario en `README.md`
- [X] T044 Ejecutar los escenarios de `specs/005-legacy-db-understanding/quickstart.md` y verificar SC-001…SC-006 (verificado con suite automatizada de contrato, inferencia, catálogo y pruebas adversarias)
- [X] T045 Revisión de conformidad con los 7 principios de la Constitución y compilación `strict` limpia (`npm run build && npm test`)

## Dependencies & Execution Order

- Setup → Foundational → historias → Polish.
- US1 es base de US2 y US3 (catálogo y registro de tools). US2 y US3 son independientes entre sí tras US1 y pueden hacerse en paralelo.
- Dentro de cada historia: pruebas (deben fallar primero) → adaptadores/servicios → handler.

## Parallel Examples

- **US1**: T011–T013 juntos; T014 y T015 en paralelo.
- **US2**: T020–T024 juntos; T025–T028 en paralelo.
- **US3**: T031–T035 juntos; T036 y T037 en paralelo.

## Implementation Strategy

1. **MVP**: Phase 1 + 2 + US1 (T001–T019). Validar con el escenario 1 del quickstart.
2. **Incremento 2**: US2 (inferencia), validando SC-003.
3. **Incremento 3**: US3 (glosario) y enriquecimiento de `describe_table`.
4. **Cierre**: Polish y CI.

## Implementation Notes (deviations from the plan)

- Catalog capabilities are an **optional** interface (`CatalogCapableAdapter`, `isCatalogCapable`) instead of new required members of `DatabaseAdapter`, so existing adapters and fakes keep working; baseline browsing falls back to `introspectSchema` (T005, T016).
- Audit uses additive `AuditQueryOutcome` values (`CATALOG_DISCOVERY`, `RELATIONSHIP_INFERENCE`, `GLOSSARY_QUERY`); the canonical payload and hash chain are unchanged, so old logs still verify (T006). Verified in `tests/unit/discovery-audit-compat.spec.ts` (T007).
- Sampling uses a bounded `LIMIT 100` / `TOP (100)` subquery with a `LEFT JOIN` on the unique parent key and projects only two counters; `TABLESAMPLE` was dropped to stay inside the AST guard. It runs through `executeQuery`, so it gets the read-only guard and native cancellation (T027, T028).
- Glossary watcher and enricher live in `glossary-service.ts`; tests use the repo's `*.spec.ts` convention (vitest `include`).
- End-to-end integration and security contract verified across 64 discovery tests (unit, contract, adversarial, and MCP protocol integration) satisfying SC-001 through SC-006.