# Implementation Plan: Herramientas de Comprensión y Descubrimiento para Bases de Datos Legacy

**Branch**: `005-legacy-db-understanding` | **Date**: 2026-10-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-legacy-db-understanding/spec.md`

## Summary

Agregar al servidor MCP `db-mcp-node` tres capacidades de descubrimiento: (1) herramientas de exploración de catálogo (`list_tables`, `describe_table`) que leen solo vistas de sistema mediante `DatabaseAdapter` (ampliando `introspectSchema` ya existente con filtros, paginación, estimaciones de filas e índices); (2) un motor heurístico puro (`RelationshipInferenceEngine`) que puntúa relaciones padre-hijo implícitas combinando similitud léxica, compatibilidad de tipos y evidencia estadística acotada; (3) un glosario de negocio declarativo YAML/JSON versionado en Git, con recarga en caliente (conserva la última versión válida) e inyección automática en `describe_table`, más la herramienta `search_glossary`. Toda salida con texto del glosario o valores derivados de la BD pasa por el `zero-trust-sanitizer` y toda operación se audita.

## Technical Context

**Language/Version**: TypeScript 5.x (`strict: true`, `noUncheckedIndexedAccess: true`) sobre Node.js 20+ LTS

**Primary Dependencies**: `@modelcontextprotocol/sdk`, `zod` (validación del glosario y de los argumentos de tools), `yaml` (parseo YAML con posición de línea en errores), `pg` / `mssql` tras `DatabaseAdapter`. Sin dependencias nuevas de ML: la heurística es determinista.

**Storage**: Archivo de glosario en el repositorio (`docs/glossary.yaml` | `docs/glossary.json`, ruta por `GLOSSARY_PATH`); caché de catálogo en memoria con TTL. Sin persistencia nueva.

**Testing**: Vitest — unitarias del motor de inferencia (corpus de esquemas legacy etiquetados), del cargador de glosario (válido, corrupto, recarga), contratos de adaptador compartidos por PostgreSQL y SQL Server, y casos adversarios (prompt injection en glosario, nombres de objetos con caracteres especiales, muestreo con timeout).

**Target Platform**: Servidor Node.js multiplataforma (stdio y SSE)

**Project Type**: Servidor MCP (extensión del proyecto único existente)

**Performance Goals**: `list_tables` ≤ 1.5 s para 500 tablas; `describe_table` ≤ 100 ms con catálogo en caché; recarga de glosario ≤ 500 ms; muestreo estadístico ≤ 1 s por candidata (abortable).

**Constraints**:
- Solo lectura; metadatos únicamente desde catálogos del sistema (nunca `SELECT *` ni `COUNT(*)` sobre tablas de usuario).
- El muestreo estadístico MUST devolver solo agregados (ratio de contención, distintos); **nunca valores crudos** al motor heurístico ni al cliente (Principios III y IV).
- Cualquier consulta de muestreo MUST pasar por `SqlSecurityGuard`, plan-risk (feature 004) y límites de tiempo/filas, con parámetros tipados.
- Glosario: contenido tratado como no confiable; tamaño máximo de archivo y de campos configurable.

**Scale/Scope**: Catálogos de hasta ~10k tablas (paginación/filtros), glosarios de hasta ~5k entradas.

## Constitution Check

*GATE: debe pasar antes de Phase 0. Re-evaluado tras Phase 1.*

| Principio | Pre-research | Post-design | Notas |
|---|---|---|---|
| **I. Solo Lectura** | PASS | PASS | Catálogos vía vistas de sistema; muestreo agregado pasa por el guard AST. |
| **II. Defensa en Profundidad** | PASS | PASS | Muestreo con timeout 1 s, tope de muestra (100 filas), plan-risk y rate limit existentes; límites de paginación en catálogo. |
| **III. Cero Confianza en los Datos** | PASS | PASS | Descripciones del glosario, nombres de objetos y códigos se envuelven con `zero-trust-sanitizer`. Ver [research.md](./research.md) §R4. |
| **IV. Privacidad en Memoria** | PASS | PASS | El muestreo solo produce agregados; no se serializan valores de filas. Se respeta el perfil de enmascaramiento si un código de dominio coincide con columna sensible. |
| **V. Auditoría Inmutable** | PASS | PASS | Nuevas acciones de auditoría `CATALOG_DISCOVERY` / `RELATIONSHIP_INFERENCE` / `GLOSSARY_QUERY` sin datos crudos. Ver contrato. |
| **VI. Pruebas Adversarias** | PASS | PASS | Se amplía el corpus (inyección vía glosario/identificadores) y corre en CI. |
| **VII. Desacoplamiento por Contrato** | PASS | PASS | `DatabaseAdapter` se extiende con métodos de catálogo; el núcleo no conoce SQL de motor. Ver [contracts](./contracts/legacy-discovery.contract.ts). |

Sin violaciones; la tabla de Complexity Tracking no aplica.

## Project Structure

### Documentation (this feature)

```text
specs/005-legacy-db-understanding/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── legacy-discovery.contract.ts
│   ├── glossary.schema.json
│   └── mcp-tools.schema.json
├── checklists/requirements.md
└── tasks.md             # lo genera /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── contracts/
│   ├── database-adapter.ts            # extender: listTables, describeTable, getColumnStats, sampleContainment
│   ├── audit.contract.ts              # extender: acciones de descubrimiento
│   └── legacy-discovery.contract.ts   # nuevo (copia final del contrato de diseño)
├── adapters/
│   ├── postgres/postgres-catalog.ts   # pg_catalog / information_schema / pg_stats
│   └── sqlserver/sqlserver-catalog.ts # sys.* / INFORMATION_SCHEMA / sys.dm_db_stats_properties
├── core/
│   ├── discovery/
│   │   ├── catalog-service.ts         # filtros, paginación, caché TTL
│   │   ├── name-tokenizer.ts          # normalización y abreviaturas
│   │   ├── relationship-inference-engine.ts
│   │   └── inference-scoring.ts
│   ├── glossary/
│   │   ├── glossary-loader.ts         # parse + zod + last-known-good
│   │   ├── glossary-watcher.ts        # recarga en caliente
│   │   ├── glossary-index.ts          # búsqueda léxica y sinónimos
│   │   └── glossary-enricher.ts       # inyección en describe_table
│   └── tools/discovery-tools.ts       # list_tables, describe_table, infer_table_relationships, search_glossary
└── bin/db-mcp.ts                       # registro de tools

tests/
├── contract/      # suite compartida de adaptadores (catálogo)
├── unit/          # inferencia, glosario, tokenizer
├── integration/
└── adversarial/   # inyección vía glosario e identificadores

docs/glossary.yaml                      # ejemplo versionado
```

**Structure Decision**: Proyecto único existente; módulos nuevos bajo `src/core/discovery` y `src/core/glossary`, con SQL de catálogo aislado en los adaptadores.
