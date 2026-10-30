# Implementation Plan: Control de Costo, Límites Operativos y Flujo de Aprobación Humana

**Branch**: `004-cost-limits-human-approval` | **Date**: 2026-10-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-cost-limits-human-approval/spec.md`

## Summary

Implementar el sistema integral de control de costos, límites operativos y compuerta de aprobación humana para el servidor MCP `db-mcp-node`. El sistema analiza preventivamente el plan de ejecución de toda consulta `SELECT` (`EXPLAIN JSON` en PostgreSQL y `SHOWPLAN` en SQL Server) mediante umbrales por motor para bloquear de inmediato escaneos completos en tablas grandes y productos cartesianos (`BLOCKED_BY_COST`). Impone límites operativos estrictos (tope de filas devueltas con bandera `truncated: true`, *rate limiting* híbrido de dos niveles en memoria en $O(1)$ y tiempo máximo de ejecución con cancelación activa nativa en el motor: `request.cancel` en SQL Server y `pg_cancel_backend` en PostgreSQL). Finalmente, implementa un flujo de aprobación humana asíncrona sin bloqueo de cliente (`PENDING_APPROVAL` con persistencia local por TTL), con comando CLI de operador administrativo fuera de banda (`db-mcp approve`) y una herramienta pasiva de solo lectura (`get_query_result`) para recuperación segura de resultados, imposibilitando por diseño la auto-aprobación por parte de agentes de IA.

## Technical Context

**Language/Version**: TypeScript 5.x (`strict: true`, `noUncheckedIndexedAccess: true`) sobre Node.js 20+ LTS

**Primary Dependencies**: `@modelcontextprotocol/sdk` (SDK oficial de MCP), drivers relacionales (`pg`, `mssql`/`tedious` desacoplados bajo `DatabaseAdapter`), `zod` (validación de políticas y esquemas de persistencia)

**Storage**: Almacén local estructurado en JSON con escrituras atómicas y purga por TTL para tickets pendientes (`PENDING_APPROVAL_STORE_PATH`, ej. `.db-mcp/pending_approvals.json`) + registros de auditoría estructurada (`audit.jsonl`)

**Testing**: Vitest (`vitest`) ejecutando suites de pruebas unitarias de cálculo de riesgo, pruebas de estrés y ráfaga para rate limiting, pruebas de cancelación real con timeouts simulados y pruebas de integración del flujo CLI de aprobación humana

**Target Platform**: Servidor Node.js multiplataforma (Linux / Windows / macOS) operando como servidor MCP (stdio y SSE) y CLI administrativa

**Project Type**: Servidor MCP empresarial y herramienta de línea de comandos complementaria para gobernanza de bases de datos

**Performance Goals**:
- Evaluación de perfiles de riesgo del plan en `< 15ms` tras la respuesta del motor.
- Temporizador fail-safe para obtención del plan de ejecución limitado a `2000ms`.
- Verificación y corte de cuota de rate limiting en memoria en `< 1ms` ($O(1)$).
- Tiempo de respuesta al catalogar una consulta en `PENDING_APPROVAL` en `< 500ms` sin bloquear el transporte.
- Cancelación real en el motor disparada en `< 50ms` tras expirar el temporizador de ejecución.

**Constraints**:
- Modo TypeScript estricto no negociable.
- Aislamiento total de privilegios: exclusión de cualquier método de auto-aprobación en los tools MCP expuestos a la IA (cumplimiento constitucional).
- Cancelación real y efectiva en el motor de base de datos (`pg_cancel_backend` / `request.cancel`), prohibiendo el cierre pasivo de socket como único mecanismo.
- Política fail-safe ante planes no verificables: elevar a `PENDING_APPROVAL` en lugar de ejecutar a ciegas.
- Truncamiento seguro con bandera explícita `truncated: true` al alcanzar `maxRowsLimit`.

**Scale/Scope**:
- 4 componentes centrales: `QueryPlanRiskEvaluator`, `OperationalLimitsSupervisor`, `TwoTierRateLimiter`, `PendingApprovalStore`.
- 1 nuevo comando CLI administrativo de operador: `db-mcp` con subcomandos `list-pending`, `approve`, `reject`.
- 1 nueva herramienta MCP expuesta al cliente: `get_query_result` (de solo lectura pasiva).
- Soporte completo y uniforme para PostgreSQL y SQL Server detrás de `DatabaseAdapter`.

## Constitution Check

*GATE: Evaluado antes de Fase 0 (Pre-Diseño) y reevaluado tras Fase 1 (Post-Diseño).*

| Principio de la Constitución | Pre-Diseño | Post-Diseño | Evidencia y Cumplimiento en Artefactos |
| --- | --- | --- | --- |
| **I. Solo Lectura Inquebrantable** | PASS | PASS | Solo consultas que hayan superado el guardián de solo lectura son sometidas al análisis de plan y ejecución. El comando de aprobación humana ejecuta consultas acotadas bajo el mismo perfil read-only. |
| **II. Defensa en Profundidad** | PASS | PASS | Se solapan la estimación previa del plan, límites operativos en tiempo real (timeout, filas, rate limiting) y compuerta humana explícita. Ver [`research.md`](./research.md). |
| **III. Cero Confianza en los Datos** | PASS | PASS | Los resultados de consultas aprobadas recuperados mediante `get_query_result` viajan encapsulados en delimitadores estructurales y neutralizados contra prompt injection. |
| **IV. Privacidad en Memoria** | PASS | PASS | Los datos resultantes de consultas aprobadas se enmascaran en memoria antes de persistirse temporalmente o entregarse al cliente MCP. |
| **V. Auditoría Estructurada Inmutable** | PASS | PASS | Estados finales tipados y auditados de forma inmutable: `BLOCKED_BY_COST`, `CANCELLED_BY_TIMEOUT`, `PENDING_APPROVAL` y `EXECUTED` bajo el mismo `correlationId`. |
| **VI. Pruebas Adversarias (NON-NEGOTIABLE)** | PASS | PASS | Batería de pruebas de DoS con productos cartesianos, escaneos masivos, ráfagas de rate limiting y timeouts extremos en CI. |
| **VII. Desacoplamiento por Contrato** | PASS | PASS | `IQueryPlanRiskEvaluator`, `IRateLimiter` y `IPendingApprovalStore` interactúan únicamente mediante contratos TypeScript desacoplados de los motores específicos. Ver [`cost-limits.contract.ts`](./contracts/cost-limits.contract.ts). |

## Project Structure

### Documentation (this feature)

```text
specs/004-cost-limits-human-approval/
├── plan.md              # Este plan de implementación
├── research.md          # Decisiones de investigación y arquitectura Fase 0
├── data-model.md        # Modelo de datos, entidades y estados Fase 1
├── quickstart.md        # Guía de validación y escenarios ejecutables Fase 1
├── checklists/
│   └── requirements.md  # Lista de verificación de calidad (16/16 criterios)
└── contracts/           # Contratos formales y esquemas JSON Fase 1
    ├── cost-limits.contract.ts
    ├── operational-limits.schema.json
    └── pending-approvals.schema.json
```

### Source Code (repository root)

```text
src/
├── bin/
│   ├── audit-verify.ts                # CLI de verificación de auditoría (Fase 003)
│   └── db-mcp.ts                      # CLI de administración y aprobación humana (Fase 004)
├── contracts/
│   ├── database-adapter.ts            # Contrato base DatabaseAdapter (Fase 001)
│   ├── security.contract.ts           # Contratos de seguridad y guard (Fase 002)
│   ├── audit.contract.ts              # Contrato de auditoría inmutable (Fase 003)
│   └── cost-limits.contract.ts        # Contratos de límites, riesgo y aprobación (Fase 004)
├── core/
│   ├── engine-registry.ts             # Registro y ciclo de vida de adaptadores
│   ├── errors.ts                      # Excepciones tipadas (CostLimitError, RateLimitError, etc.)
│   ├── security/                      # Guardián sintáctico y enmascaramiento (Fase 002)
│   ├── audit/                         # Logger estructurado e integridad SHA-256 (Fase 003)
│   └── limits/                        # Módulo de control de costo y límites (Fase 004)
│       ├── risk-evaluator.ts          # Evaluador normalizado de severidad de planes
│       ├── rate-limiter.ts            # Limitador de tasa híbrido en memoria O(1)
│       ├── execution-supervisor.ts    # Supervisor de timeouts, filas y cancelación en motor
│       ├── pending-approval-store.ts  # Almacén atómico local de tickets con TTL
│       └── default-limits-policy.ts   # Configuración y umbrales por defecto
├── adapters/
│   ├── postgres/                      # Adaptador PostgreSQL con cancelación pg_cancel_backend
│   └── sqlserver/                     # Adaptador SQL Server con cancelación request.cancel
└── index.ts                           # Servidor MCP exponiendo query_database y get_query_result

tests/
├── unit/
│   ├── limits/
│   │   ├── risk-evaluator.test.ts     # Pruebas de detección de escaneos y cartesianos
│   │   ├── rate-limiter.test.ts       # Pruebas de ventanas de tasa cliente y global
│   │   └── pending-store.test.ts      # Pruebas de persistencia atómica y purga por TTL
├── adversarial/
│   └── cost-dos.test.ts               # Pruebas adversarias de saturación y timeout
└── contract/
    └── approval-flow.test.ts          # Prueba end-to-end del ciclo de aprobación y recuperación
```

**Structure Decision**: Se mantiene la arquitectura modular de `src/core/limits/` integrando los evaluadores de riesgo, limitadores de tasa y almacén de tickets. Se introduce el ejecutable CLI de operador `src/bin/db-mcp.ts` para la administración y aprobación humana fuera de banda, y se actualiza `src/index.ts` para registrar el nuevo tool MCP pasivo `get_query_result`.

## Complexity Tracking

> Ninguna violación a los principios arquitectónicos ni excepciones a la Constitución requeridas. Todas las compuertas y estándares de diseño fueron validados y satisfechos.
