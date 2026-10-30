# Implementation Plan: Base Arquitectónica de Adaptadores y Suite Adversaria de Seguridad

**Branch**: `001-adapters-adversarial-suite` | **Date**: 2026-10-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-adapters-adversarial-suite/spec.md`

## Summary

Establecer la base arquitectónica del servidor MCP para bases de datos relacionales desacoplando el núcleo de los motores específicos mediante la interfaz estricta `DatabaseAdapter` en TypeScript (`strict: true`) e implementando primero el corpus adversario de seguridad en CI. El contrato `DatabaseAdapter` abstrae cuatro operaciones: verificación de permisos efectivos de solo lectura en el arranque (*preflight check*), análisis de plan de ejecución normalizado a `NormalizedRiskProfile`, ejecución de consultas parametrizadas con cancelación nativa en el motor vía `AbortSignal`, e introspección de esquema. Incluye los dos adaptadores iniciales para **SQL Server (T-SQL)** y **PostgreSQL** validados bajo una única suite compartida de contrato y un evaluador de parsers de SQL candidatos contra los 10 vectores de ataque obligatorios.

## Technical Context

**Language/Version**: TypeScript 5.x (`strict: true`) sobre Node.js 20+ LTS

**Primary Dependencies**: `@modelcontextprotocol/sdk` (SDK oficial de MCP), `node-sql-parser` (con dialectos `transactsql` y `postgresql` + escáner léxico estricto), `mssql` (driver SQL Server / TDS con cancelación nativa), `pg` (driver PostgreSQL con cancelación nativa), `zod` (validación del corpus estructurado y esquemas)

**Storage**: Motores relacionales externos consultados en modo solo lectura (SQL Server y PostgreSQL) + corpus adversario estructurado en archivo JSON versionado (`corpus/adversarial-attacks.json`)

**Testing**: Vitest (`vitest`) ejecutando suite adversaria, benchmark de parsers candidatos y suite compartida de contrato en CI (GitHub Actions)

**Target Platform**: Servidor Node.js multiplataforma (Windows / Linux / macOS) comunicándose vía protocolo MCP (stdio/SSE)

**Project Type**: Servidor MCP modular y librería de adaptadores de bases de datos (`mcp-server` / `library`)

**Performance Goals**: Cancelación nativa en el motor de base de datos en `< 1s` tras activarse `AbortSignal` (`SC-003`); validación sintáctica y léxica AST en `< 10ms` por consulta; ejecución completa del corpus adversario en CI en `< 5s`

**Constraints**: TypeScript estricto (`strict: true`, `noUncheckedIndexedAccess: true`); prohibición absoluta de interpolación de valores en SQL; rechazo estricto de comentarios `--` y `/* */` fuera de literales; cero dependencias de motores concretos dentro de `src/core/`

**Scale/Scope**: 2 adaptadores iniciales (`SqlServerAdapter`, `PostgresAdapter`), 4 operaciones de contrato por adaptador, corpus adversario inicial con 10 vectores obligatorios (mínimo 30 casos de ataque + casos de control `SELECT`)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio de la Constitución | Evaluación Pre-Diseño | Evaluación Post-Diseño | Evidencia en Artefactos |
| --- | --- | --- | --- |
| **I. Solo Lectura Inquebrantable** | PASS | PASS | Validador en 2 etapas (escáner léxico que rechaza comentarios `--`/`/* */` + AST `SELECT` puro) respaldado por `verifyReadOnly()` en `DatabaseAdapter`. |
| **II. Defensa en Profundidad** | PASS | PASS | Combina rechazo léxico/AST, *preflight check* de permisos efectivos en catálogo + sesión `READ ONLY`, `analyzeQueryPlan()` y cancelación nativa por `AbortSignal`. |
| **III. Cero Confianza en los Datos** | PASS | PASS | `ParameterizedQuery` exige `params: ReadonlyArray<QueryParameter>` tipados y separados del texto SQL. |
| **IV. Privacidad en Memoria** | PASS | PASS | `QueryExecutionResult` entrega filas tipadas al pipeline en memoria del núcleo para su enmascaramiento antes de serializar hacia el cliente MCP. |
| **V. Auditoría Estructurada Inmutable** | PASS | PASS | `SqlValidationResult` y `ReadOnlyVerificationResult` devuelven códigos de razón estructurados sin exponer datos de filas. |
| **VI. Desarrollo Guiado por Pruebas Adversarias** | PASS | PASS | `corpus/adversarial-attacks.json` (10 vectores) y su corredor en CI se construyen y validan antes de dar por bueno cualquier parser o adaptador. |
| **VII. Desacoplamiento por Contrato (`DatabaseAdapter`)** | PASS | PASS | `src/core/` depende exclusivamente de `src/contracts/database-adapter.ts` bajo TypeScript `strict: true`. |

## Project Structure

### Documentation (this feature)

```text
specs/001-adapters-adversarial-suite/
├── plan.md              # Este archivo (salida de /speckit-plan)
├── research.md          # Decisiones de investigación Fase 0
├── data-model.md        # Modelo de datos y estados Fase 1
├── quickstart.md        # Guía de validación ejecutable Fase 1
├── contracts/           # Contratos formales Fase 1
│   ├── database-adapter.contract.ts
│   └── adversarial-corpus.schema.json
└── tasks.md             # Lista de tareas Fase 2 (se generará con /speckit-tasks)
```

### Source Code (repository root)

```text
corpus/
└── adversarial-attacks.json           # Corpus estructurado con los 10 vectores + casos de control

src/
├── contracts/
│   └── database-adapter.ts            # Interfaz DatabaseAdapter, NormalizedRiskProfile, SchemaCatalog
├── core/
│   ├── engine-registry.ts             # Registro agnóstico de adaptadores + preflight gate
│   └── validation/
│       ├── lexical-scanner.ts         # Escáner léxico consciente de literales (rechaza -- y /* */)
│       ├── ast-validator.ts           # Validador AST multi-dialecto (10 vectores)
│       └── parser-benchmark.ts        # Evaluador comparativo de parsers candidatos contra el corpus
├── adapters/
│   ├── postgres/
│   │   ├── postgres-adapter.ts        # Implementación PostgreSQL de DatabaseAdapter
│   │   └── postgres-plan-parser.ts    # Normalizador EXPLAIN (FORMAT JSON) -> NormalizedRiskProfile
│   └── sqlserver/
│       ├── sqlserver-adapter.ts       # Implementación SQL Server (T-SQL) de DatabaseAdapter
│       └── sqlserver-plan-parser.ts   # Normalizador SHOWPLAN_XML -> NormalizedRiskProfile
└── index.ts                           # Punto de entrada del servidor MCP y exportación pública

tests/
├── adversarial/
│   ├── corpus-runner.spec.ts          # Ejecución en CI de los 10 vectores en tsql y postgres
│   └── parser-candidates.spec.ts      # Comparativa objetiva de parsers candidatos
├── contract/
│   ├── database-adapter.shared.ts     # Suite compartida de contrato para cualquier DatabaseAdapter
│   ├── postgres-adapter.contract.spec.ts
│   ├── sqlserver-adapter.contract.spec.ts
│   └── extensibility.contract.spec.ts # Prueba de 3er adaptador con 0 cambios en src/core/
└── unit/
    ├── lexical-scanner.spec.ts
    └── plan-normalizers.spec.ts
```

**Structure Decision**: Se selecciona la estructura de proyecto único modular en TypeScript (`src/contracts`, `src/core`, `src/adapters`, `corpus/`, `tests/`) porque mantiene una frontera física estricta entre el núcleo (`src/core/`), los contratos (`src/contracts/`) y las implementaciones de motores (`src/adapters/postgres` y `src/adapters/sqlserver`), permitiendo verificar estáticamente que `src/core/` jamás importe drivers de motores específicos.

## Complexity Tracking

> No existen violaciones a la Constitución; no se requiere justificación de complejidad adicional.
