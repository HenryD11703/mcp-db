# Implementation Plan: Orquestador de Consulta Federada Segura entre Servidores Heterogéneos

**Branch**: `006-secure-federated-query` | **Date**: 2026-10-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-secure-federated-query/spec.md`

## Summary

Implementar el orquestador de consulta federada segura en memoria (`FederatedQueryOrchestrator`) para el servidor MCP `db-mcp-node`, permitiendo ejecutar consultas combinadas entre servidores de bases de datos independientes y heterogéneos (PostgreSQL y SQL Server) sin infraestructura de *linked servers* ni `OPENQUERY`. El flujo extrae claves de BD A en memoria, las trata como datos no confiables y las inyecta estrictamente como parámetros tipados en la plantilla de BD B (`WHERE col IN (:keys)` expandido a `$1...` o `@p1...`), con tope configurable de 500 parámetros, doble validación independiente mediante el Guard AST y analizador de costo en cada motor, cruce en memoria (`LEFT` o `INNER` hash join) con desambiguación de colisiones de columnas (`target_<col>`), pseudonimización determinista por sesión (`pseudo_<16_hex>`) usando HMAC-SHA256 con salt efímero antes de la entrega al cliente, y registro estructurado de auditoría inmutable enlazado por un mismo `federation_id` (`correlationId`).

## Technical Context

**Language/Version**: TypeScript 5.x (`strict: true`, `noUncheckedIndexedAccess: true`) sobre Node.js 20+ LTS

**Primary Dependencies**: `@modelcontextprotocol/sdk`, `zod` (validación de esquemas de argumentos), `crypto` nativo de Node.js (HMAC-SHA256 y UUID v4), `pg` / `mssql` a través de los adaptadores existentes tras la interfaz `DatabaseAdapter`. Sin dependencias externas de federation ni motores remotos.

**Storage**: En memoria volátil para el salt efímero de sesión (`SessionPseudonymContext`) y el cruce hash join; auditoría persistida en archivo inmutable secuencial `audit.jsonl` (Merkle/hash chain). Sin persistencia temporal en disco para datos de usuario.

**Testing**: Vitest — pruebas unitarias del expansor de parámetros y del motor de cruce en memoria, suite adversaria de inyección SQL de segundo orden, pruebas de validación con Guard AST en ambas ramas, y pruebas de verificación forense de la cadena de auditoría con `correlationId`.

**Target Platform**: Servidor Node.js multiplataforma (stdio y SSE)

**Project Type**: Servidor MCP (extensión del núcleo y exposición de nueva herramienta MCP)

**Performance Goals**:
- Sobrecarga computacional propia del orquestador (extracción, deduplicación, hash join y pseudonimización de hasta 500 registros) ≤ 150 ms sobre el tiempo acumulado de los motores.
- Hash Join en memoria $\mathcal{O}(N + M)$ con resolución instantánea de colisiones.
- Pseudonimización determinista con caché de sesión ≤ 5 ms para 500 celdas.

**Constraints**:
- Solo lectura estricta en ambas bases de datos: preflight check verificado en arranque y nodo raíz `SELECT` sin efectos secundarios evaluado por el Guard AST.
- Prohibición terminante de enlaces de servidor (*linked servers*, `OPENQUERY`, dblink).
- Claves de BD A tratadas como datos hostiles: inyección exclusiva como parámetros tipados; cero interpolación o concatenación en texto SQL.
- Tope estricto de parámetros: 500 por defecto (máximo 1000) respetando el límite de 2100 de SQL Server.
- Privacidad en memoria: los valores reales de las columnas sensibles de cruce se reemplazan por `pseudo_<16_hex>` antes de abandonar el proceso MCP.
- Trazabilidad: cada hito de la operación federada debe compartir el mismo `correlationId` (`federation_id`).

**Scale/Scope**: Topología 1 a 1 (BD A → BD B), claves de cruce simples (columna única), datasets de cruce de hasta 500 registros (truncables a tope con advertencia).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principio | Pre-research | Post-design | Notas de Cumplimiento |
|---|---|---|---|
| **I. Solo Lectura Inquebrantable** | PASS | PASS | Ambas consultas son evaluadas independientemente por el Guard AST y ejecutadas bajo usuarios de solo lectura verificados por preflight. |
| **II. Defensa en Profundidad** | PASS | PASS | AST guard + límites de costo + rate limiting + timeouts con cancelación real en el motor secundario. |
| **III. Cero Confianza en los Datos** | PASS | PASS | Claves de BD A viajan exclusivamente como parámetros tipados nativos (`$1...`, `@p1...`); cero concatenación de cadenas (previene inyección de segundo orden). |
| **IV. Privacidad en Memoria** | PASS | PASS | Cruce en memoria con valores reales; conjunto final pasa por enmascarador aplicando pseudonimización determinista `pseudo_<16_hex>` con salt efímero de sesión. Dato crudo nunca sale del proceso. |
| **V. Auditoría Inmutable** | PASS | PASS | Cada paso emite su registro en `audit.jsonl` vinculado transversalmente por `federation_id` (`correlationId`) sin exponer claves sensibles crudas. |
| **VI. Pruebas Adversarias** | PASS | PASS | Corpus de pruebas adversarias con payloads de segundo orden (`'; DROP...`, `' OR '1'='1`) probado contra el generador de parámetros tipados. |
| **VII. Desacoplamiento por Contrato** | PASS | PASS | Orquestador interactúa únicamente a través de `DatabaseAdapter` y `AdapterRegistry`, soportando cruces heterogéneos entre PostgreSQL y SQL Server sin acoplarse a motores. |

## Project Structure

### Documentation (this feature)

```text
specs/006-secure-federated-query/
├── plan.md              # Este plan de implementación
├── research.md          # Investigación técnica y decisiones de arquitectura
├── data-model.md        # Entidades, máquinas de estados y reglas de validación
├── quickstart.md        # Guía paso a paso de validación y escenarios de prueba
├── contracts/           # Definición de interfaces TypeScript y esquemas JSON
│   ├── federated-query.contract.ts
│   └── mcp-federated-tool.schema.json
├── checklists/
│   └── requirements.md  # Checklist de calidad de especificación (16/16 aprobado)
└── tasks.md             # Tareas de implementación (generadas por /speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── contracts/
│   ├── database-adapter.ts          # Contratos existentes de adaptador
│   ├── audit.contract.ts            # Extendido con acciones federadas
│   ├── security.contract.ts         # Contratos de seguridad y enmascaramiento
│   └── federated-query.contract.ts  # Contrato formal del orquestador federado
├── core/
│   ├── engine-registry.ts           # AdapterRegistry con métodos de recuperación segura
│   ├── security/
│   │   ├── sql-security-guard.ts    # Guard AST independiente por dialecto
│   │   ├── data-masking-engine.ts   # Integración de pseudonimización determinista
│   │   └── session-pseudonym.ts     # Implementación de SessionPseudonymContext con HMAC-SHA256
│   ├── federation/
│   │   ├── parameter-binder.ts      # Expansión segura de :keys a marcadores tipados ($1 / @p1)
│   │   ├── key-extractor.ts         # Extracción, deduplicación, filtro de nulos y tope
│   │   ├── memory-join.ts           # InMemoryHashJoin (LEFT/INNER) con desambiguación target_*
│   │   └── federated-orchestrator.ts# Orquestador del flujo y compuertas de seguridad
│   └── tools/
│       └── federated-tools.ts       # Registro de herramienta MCP execute_federated_query
└── bin/
    └── db-mcp.ts                    # Exposición de tool en el servidor MCP

tests/
├── unit/
│   ├── parameter-binder.test.ts     # Pruebas de sustitución tipada de :keys
│   ├── key-extractor.test.ts        # Pruebas de deduplicación y truncamiento
│   ├── memory-join.test.ts          # Pruebas de LEFT/INNER join y colisión de columnas
│   └── session-pseudonym.test.ts    # Pruebas de consistencia y formato pseudo_<16_hex>
├── integration/
│   └── federated-query.test.ts      # Flujo end-to-end con adaptadores PostgreSQL y SQL Server
└── adversarial/
    └── second-order-sqli.test.ts    # Payloads hostiles en claves probando inmunidad de BD B
```

---

## Phases

### Phase 0: Outline & Research

Investigación consolidada en [`research.md`](./research.md):
- **R1**: Inyección parametrizada de claves expandiendo `:keys` a `$1...` o `@p1...` y vinculando valores como parámetros tipados en `ParameterizedQuery`.
- **R2**: Motor `InMemoryHashJoin` con desambiguación automática de colisiones (`target_<col>`) cuando no hay alias explícitos.
- **R3**: Pseudonimización determinista `pseudo_<16_hex>` mediante HMAC-SHA256 con salt efímero de sesión en memoria volátil.
- **R4**: Verificación independiente en cada motor de preflight check, Guard AST y análisis de costo.
- **R5**: Trazabilidad completa con `correlationId = federation_id` en todos los eventos de auditoría.

### Phase 1: Design & Contracts

Artefactos de diseño generados:
1. [`data-model.md`](./data-model.md): Entidades `FederatedOperation`, `FederatedKeySet`, `SessionPseudonymContext`, esquemas de request/response y diagrama de máquina de estados.
2. [`contracts/federated-query.contract.ts`](./contracts/federated-query.contract.ts): Contrato de TypeScript para `IFederatedQueryOrchestrator`, opciones, resultados y sesión criptográfica.
3. [`contracts/mcp-federated-tool.schema.json`](./contracts/mcp-federated-tool.schema.json): Esquema JSON de argumentos para la herramienta MCP `execute_federated_query`.
4. [`quickstart.md`](./quickstart.md): 5 escenarios ejecutables de validación (flujo heterogéneo, prueba adversaria de inyección de segundo orden, intercepción AST, tope de claves y verificación forense de auditoría).

### Phase 2: Tasks & Implementation

Siguiente comando del ciclo:
- Generar el desglose de tareas accionables ordenadas por dependencia con `/speckit-tasks`.
