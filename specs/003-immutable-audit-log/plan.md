# Implementation Plan: Sistema de Auditoría Estructurada e Inmutable

**Branch**: `003-immutable-audit-log` | **Date**: 2026-10-30 | **Spec**: [specs/003-immutable-audit-log/spec.md](file:///c:/Users/hquel/Documents/db-mcp-node/specs/003-immutable-audit-log/spec.md)

**Input**: Feature specification from `specs/003-immutable-audit-log/spec.md`

## Summary

Implementar un sistema de auditoría estructurada e inmutable para el servidor MCP que capture cada consulta recibida en formato JSON Lines (`.jsonl`), registrando identificador de correlación, identidad del solicitante, marca de tiempo ISO 8601, motor y base de datos, SQL evaluado (con literales y parámetros estrictamente sanitizados), estado final (`EXECUTED`, `REJECTED_BY_GUARD`, `BLOCKED_BY_COST`, `PENDING_APPROVAL`, `CANCELLED_BY_TIMEOUT`), motivo detallado de rechazo, tiempo en milisegundos y cantidad de filas devueltas. Cada entrada está sellada criptográficamente con `SHA-256` encadenado (`previousHash + canonicalJson`), persistida en modo *append-only* con rotación configurable (por fecha y tamaño de 100 MB), respaldada por política *fail-closed* y verificable forensemente mediante un comando CLI dedicado `audit-verify`.

## Technical Context

**Language/Version**: TypeScript 5.7.2 sobre Node.js >=20.0.0 (`strict: true`, ES Modules).

**Primary Dependencies**:
- `@modelcontextprotocol/sdk` (^1.0.4) para el servidor MCP.
- `node:crypto` para generación de UUIDs y cálculo de huellas SHA-256.
- `node:fs` y `node:fs/promises` para flujos de adición continua (*append-only streams*).
- `zod` (^3.24.1) para validación de esquemas JSON en tiempo de ejecución.

**Storage**: Archivos locales en formato JSON Lines (`.jsonl`) con rotación configurable (`AUDIT_LOG_PATH`, rotación diaria `audit-YYYY-MM-DD.jsonl` o por tope de 100 MB).

**Testing**: `vitest` (^2.1.8) con pruebas unitarias para logger, sanitizador de SQL, verificador de integridad y pruebas de integración con el pipeline de ejecución MCP.

**Target Platform**: Servidor Node.js multiplataforma (Linux / Windows / macOS / Docker).

**Project Type**: Servidor MCP / Biblioteca de seguridad y auditoría.

**Performance Goals**: Sobrecarga acumulada de auditoría (sanitización SQL + cálculo SHA-256 + persistencia append-only) inferior a 5 milisegundos por consulta en p95.

**Constraints**:
- **Cero filtración de datos sensibles**: Ni parámetros en crudo ni celdas de resultados jamás se escriben en el log.
- **Fail-closed**: Si falla el almacenamiento de auditoría, la consulta no debe devolver datos al cliente MCP.
- **Inmutabilidad verificable**: Cualquier alteración o truncamiento en el log debe ser detectada deterministamente mediante el encadenamiento SHA-256.

**Scale/Scope**: Soporte para cientos de consultas concurrentes por minuto mediante serialización asíncrona no bloqueante de escrituras en cola.

## Constitution Check

*GATE: Conformidad estricta con la Constitución v1.0.0 de db-mcp-node.*

| Principio Constitucional | Estado | Justificación |
| :--- | :--- | :--- |
| **I. Solo Lectura Inquebrantable** | **PASS** | El sistema de auditoría es puramente observacional y de registro; no ejecuta escrituras ni altera los esquemas de bases de datos. Captura consultas evaluadas y sus rechazos. |
| **II. Defensa en Profundidad** | **PASS** | Registra los veredictos emitidos por las distintas capas (AST Guard, comprobación de costo, timeout y aprobaciones humanas). Opera como compuerta *fail-closed*. |
| **III. Cero Confianza en los Datos** | **PASS** | Los datos de filas no se escriben en los logs; los textos maliciosos de inyecciones indirectas no alteran la estructura JSON gracias a la serialización estricta. |
| **IV. Privacidad en Memoria** | **PASS** | `SqlSanitizerForAudit` purga todos los literales de texto y numéricos de la sentencia evaluada, y el logger nunca serializa parámetros ni valores devueltos. |
| **V. Auditoría Estructurada Inmutable** | **PASS** | **Implementación directa del Principio V**: formato JSON estructurado, inmutable en memoria, append-only en disco, encadenamiento SHA-256 y comando CLI forense. |
| **VI. Pruebas Adversarias** | **PASS** | Incluye pruebas de alteración maliciosa de logs, inyección de literales sensibles en SQL y fallos simulados de escritura en disco. |
| **VII. Desacoplamiento por Contrato** | **PASS** | Contratos tipados limpios (`IAuditLogger`, `ISqlSanitizerForAudit`, `IAuditVerifier`) exportados en `contracts/audit.contract.ts`. |

## Project Structure

### Documentation (this feature)

```text
specs/003-immutable-audit-log/
├── spec.md              # Especificación funcional validada y refinada
├── plan.md              # Este documento de planificación técnica
├── research.md          # Hallazgos técnicos y decisiones de diseño (Phase 0)
├── data-model.md        # Definición formal de entidades y modelos de datos (Phase 1)
├── quickstart.md        # Guía de validación rápida y pruebas ejecutables (Phase 1)
├── checklists/
│   └── requirements.md  # Checklist de calidad de la especificación
└── contracts/
    └── audit.contract.ts # Contratos TypeScript formales de auditoría
```

### Source Code (repository root)

```text
src/
├── contracts/
│   ├── database-adapter.ts
│   ├── security.contract.ts
│   └── audit.contract.ts          # Contratos de auditoría integrados
├── core/
│   ├── audit/
│   │   ├── audit-logger.ts        # Implementación append-only con SHA-256 y rotación
│   │   ├── sql-sanitizer.ts       # Sanitizador de sentencias SQL para auditoría
│   │   └── audit-verifier.ts      # Verificador de integridad de cadena SHA-256
│   ├── security/                  # AST guard, enmascaramiento, preflight
│   ├── engine-registry.ts         # Registro de adaptadores
│   └── errors.ts                  # Error classes (incluyendo AuditPersistenceError)
├── bin/
│   └── audit-verify.ts            # Herramienta CLI de verificación forense
└── index.ts                       # Punto de entrada y middleware de auditoría MCP

tests/
└── unit/
    ├── audit-logger.spec.ts       # Pruebas de logging append-only, estados y rotación
    ├── sql-sanitizer-for-audit.spec.ts # Pruebas de redacción estricta de literales
    └── audit-verifier.spec.ts     # Pruebas de detección forense de alteraciones
```

## Phase 0: Research Summary

Todos los aspectos de investigación han sido resueltos en `specs/003-immutable-audit-log/research.md`:
1. **Algoritmo**: SHA-256 nativo con serialización canónica de claves lexicográficas.
2. **Sanitización SQL**: Redacción universal de literales a `'[REDACTED_LITERAL]'` y `[REDACTED_NUM]`, y truncado seguro a 16 KB.
3. **Persistencia & Rotación**: Flujo *append-only* en cola secuencial con soporte de rotación diaria y por umbral de 100 MB preservando la continuidad criptográfica.
4. **Política Operativa**: *Fail-closed* garantizando que ninguna consulta se devuelva al cliente sin haber sido auditada exitosamente.

## Phase 1: Design Artifacts

1. **Modelos de Datos**: Registrados en `specs/003-immutable-audit-log/data-model.md` (`AuditLogEntry`, `CanonicalAuditPayload`, `AuditQueryOutcome`, `AuditVerificationResult`).
2. **Contratos**: Definidos formalmente en `specs/003-immutable-audit-log/contracts/audit.contract.ts`.
3. **Guía de Validación**: Detallada en `specs/003-immutable-audit-log/quickstart.md`.
