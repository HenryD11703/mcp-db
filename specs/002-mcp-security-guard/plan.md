# Implementation Plan: Seguridad del Servidor MCP: Guardián de Consultas SQL, Verificación Preflight, Enmascaramiento de Datos y Defensa Zero-Trust

**Branch**: `002-mcp-security-guard` | **Date**: 2026-10-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-mcp-security-guard/spec.md`

## Summary

Implementar la capa integral de seguridad y defensa en profundidad del servidor MCP `db-mcp-node`, garantizando que ninguna consulta que no sea exclusivamente de solo lectura (`SELECT`) alcance la base de datos, que el servidor se niegue a iniciar si detecta credenciales con permisos de escritura (*fail-closed preflight check*), que los datos sensibles (correos, teléfonos, DPI de Guatemala y montos monetarios) se enmascaren en memoria volátil sin salir del proceso, y que el contenido de las filas se trate estrictamente como datos no confiables mediante encapsulamiento estructural semántico y neutralización contra inyección indirecta de prompts validada con un corpus de filas maliciosas.

## Technical Context

**Language/Version**: TypeScript 5.x (`strict: true`, `noUncheckedIndexedAccess: true`) sobre Node.js 20+ LTS

**Primary Dependencies**: `@modelcontextprotocol/sdk` (SDK oficial de MCP), `node-sql-parser` (análisis AST de dialectos TransactSQL y Postgresql), `zod` (validación de esquemas de configuración y corpus), drivers relacionales desacoplados (`mssql`, `pg` detrás de `DatabaseAdapter`)

**Storage**: Bases de datos relacionales consultadas exclusivamente en modo solo lectura + corpus de filas adversarias estructurado en JSON (`corpus/adversarial-rows.json`) + perfiles declarativos de enmascaramiento

**Testing**: Vitest (`vitest`) ejecutando pruebas unitarias de seguridad, suites de filas maliciosas adversarias, pruebas de compuerta preflight y pruebas de contrato end-to-end de herramientas MCP

**Target Platform**: Servidor Node.js multiplataforma (Linux / Windows / macOS) operando a través del protocolo MCP (stdio y SSE)

**Project Type**: Servidor MCP empresarial para bases de datos relacionales (`mcp-server`)

**Performance Goals**:
- Validación léxica y AST en `< 10ms` por consulta entrante (`SC-006`).
- Verificación preflight en el arranque completada en `< 2s` (`SC-003`).
- Enmascaramiento y encapsulamiento en memoria para conjuntos de hasta 500 filas en `< 15ms`.
- Tasa de rechazo del 100% sobre consultas no-SELECT y 0 falsos positivos en consultas de lectura válidas (`SC-001`, `SC-002`).

**Constraints**:
- Modo TypeScript estricto obligatorio.
- Prohibición absoluta de enviar datos sensibles no enmascarados fuera del proceso (`FR-019`, Principio IV).
- Bloqueo fail-closed en el arranque ante permisos de escritura (`FR-012`, Principio I).
- Tratamiento zero-trust de todo dato de filas frente a modelos de IA (`FR-021`, Principio III).

**Scale/Scope**:
- 4 módulos de seguridad interconectados: `SqlSecurityGuard`, `StartupPreflightGate`, `DataMaskingEngine`, `ZeroTrustSanitizer`.
- 1 nueva herramienta MCP expuesta de forma segura: `query_database` (incorporando guardián, ejecución, enmascaramiento y delimitación).
- 1 corpus de datos adversarios estructurado (`corpus/adversarial-rows.json`) con 5 categorías de inyección indirecta.

## Constitution Check

*GATE: Evaluado antes de Fase 0 (Pre-Diseño) y reevaluado tras Fase 1 (Post-Diseño).*

| Principio de la Constitución | Pre-Diseño | Post-Diseño | Evidencia y Cumplimiento en Artefactos |
| --- | --- | --- | --- |
| **I. Solo Lectura Inquebrantable** | PASS | PASS | `SqlSecurityGuard` rechaza en 2 etapas sentencias no-`SELECT`, comentarios `--`/`/* */`, CTEs con escritura, `SELECT INTO` y `EXEC`. `StartupPreflightGate` aborta el arranque (`process.exit(1)`) si detecta permisos de modificación. Ver [`security.contract.ts`](./contracts/security.contract.ts). |
| **II. Defensa en Profundidad** | PASS | PASS | Se solapan cuatro barreras independientes: validación léxica previa, validación AST, verificación preflight de permisos mínimos en motor y modo de sesión read-only. Ver [`research.md`](./research.md). |
| **III. Cero Confianza en los Datos** | PASS | PASS | Las filas se tratan como datos no confiables; `ZeroTrustSanitizer` encapsula resultados en delimitadores estructurales semánticos y neutraliza directivas de IA. Ver [`data-model.md`](./data-model.md). |
| **IV. Privacidad en Memoria** | PASS | PASS | `DataMaskingEngine` ofusca en memoria correos, teléfonos, DPI y montos antes de serializar hacia el cliente MCP. El dato crudo se destruye al salir del alcance de memoria del proceso. Ver [`masking-profile.schema.json`](./contracts/masking-profile.schema.json). |
| **V. Auditoría Estructurada Inmutable** | PASS | PASS | Toda consulta rechazada genera un `SecurityViolation` estructurado con códigos tipados (`V01_STACKED_QUERIES` a `V10_SESSION_COMMAND`) sin exponer esquemas ni credenciales. |
| **VI. Pruebas Adversarias (NON-NEGOTIABLE)** | PASS | PASS | Se especifica el corpus `corpus/adversarial-rows.json` y su esquema [`adversarial-rows.schema.json`](./contracts/adversarial-rows.schema.json), con pruebas automatizadas en CI para inyección indirecta de prompts. |
| **VII. Desacoplamiento por Contrato** | PASS | PASS | La capa de seguridad interactúa únicamente con interfaces de contrato (`DatabaseAdapter`, `ISqlSecurityGuard`, `IDataMaskingEngine`), agnóstica de bases de datos específicas. |

## Project Structure

### Documentation (this feature)

```text
specs/002-mcp-security-guard/
├── plan.md              # Este plan de implementación
├── research.md          # Decisiones de investigación y arquitectura Fase 0
├── data-model.md        # Modelo de entidades, estados y contratos de datos Fase 1
├── quickstart.md        # Guía de validación y escenarios ejecutables Fase 1
├── checklists/
│   └── requirements.md  # Lista de verificación de calidad
└── contracts/           # Contratos formales y esquemas JSON Fase 1
    ├── security.contract.ts
    ├── adversarial-rows.schema.json
    └── masking-profile.schema.json
```

### Source Code (repository root)

```text
corpus/
├── adversarial-attacks.json           # Corpus de ataques SQL (Fase 001)
└── adversarial-rows.json              # Corpus de pruebas de filas maliciosas (Fase 002)

src/
├── contracts/
│   ├── database-adapter.ts            # Contrato base DatabaseAdapter (Fase 001)
│   └── security.contract.ts           # Contratos de seguridad, preflight, masking y zero-trust (Fase 002)
├── core/
│   ├── engine-registry.ts             # Orquestador desacoplado de adaptadores
│   ├── errors.ts                      # Tipos de errores y violaciones de seguridad
│   ├── security/
│   │   ├── sql-security-guard.ts      # Guardián sintáctico AST de 2 etapas (Fase 002)
│   │   ├── startup-preflight-gate.ts  # Compuerta de arranque y aborto fail-closed (Fase 002)
│   │   ├── data-masking-engine.ts     # Motor de enmascaramiento en memoria (Fase 002)
│   │   ├── masking-rules.ts           # Reglas declarativas y formateadores de PII (Fase 002)
│   │   ├── default-masking-profile.ts # Perfil predeterminado (Email, Tel, DPI, Monto) (Fase 002)
│   │   └── zero-trust-sanitizer.ts    # Encapsulamiento y neutralizador estructural (Fase 002)
│   └── validation/
│       ├── lexical-scanner.ts         # Escáner léxico consciente de cadenas
│       ├── ast-validator.ts           # Validador de AST multi-dialecto
│       ├── corpus-schema.ts           # Esquemas Zod para corpus
│       └── parser-benchmark.ts        # Benchmarking de parsers
├── adapters/
│   ├── postgres/                      # Adaptador PostgreSQL
│   └── sqlserver/                     # Adaptador SQL Server
└── index.ts                           # Servidor MCP exponiendo explain_query, introspect_schema y query_database

tests/
├── adversarial/
│   ├── corpus-runner.spec.ts          # Pruebas del corpus de ataques SQL
│   ├── parser-candidates.spec.ts      # Benchmark comparativo de parsers
│   └── malicious-rows.spec.ts         # Pruebas automatizadas de filas maliciosas (Fase 002)
├── contract/
│   ├── database-adapter.shared.ts
│   ├── postgres-adapter.contract.spec.ts
│   ├── sqlserver-adapter.contract.spec.ts
│   └── mcp-query-database.spec.ts     # Validación end-to-end de tool query_database protegida (Fase 002)
└── unit/
    ├── lexical-scanner.spec.ts
    ├── plan-normalizers.spec.ts
    ├── sql-security-guard.spec.ts      # Pruebas unitarias del guardián AST (Fase 002)
    ├── startup-preflight-gate.spec.ts  # Pruebas unitarias de compuerta preflight (Fase 002)
    ├── data-masking-engine.spec.ts     # Pruebas unitarias de enmascaramiento (Fase 002)
    └── zero-trust-sanitizer.spec.ts   # Pruebas unitarias de defensa zero-trust (Fase 002)
```

**Structure Decision**: Se agrupan todos los módulos de seguridad bajo `src/core/security/` desacoplados de los adaptadores de base de datos concretos. Cada componente (`sql-security-guard`, `startup-preflight-gate`, `data-masking-engine`, `zero-trust-sanitizer`) posee una responsabilidad única y una suite de pruebas aislada en `tests/unit/`, completando la tubería en `src/index.ts` con la herramienta MCP `query_database`.

## Complexity Tracking

> **Sin violaciones ni complejidades no justificadas.** Todos los componentes responden estrictamente a los Principios I, II, III, IV y VI de la Constitución del proyecto.
